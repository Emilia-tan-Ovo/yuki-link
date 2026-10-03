import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { createEngineeringRuntime } from './runtime.js';
import { createEngineeringHttpServer } from './http.js';
import { createHarnessServer } from '../harness/runtime.ts';
import { publicError } from '../errors.js';

const { values } = parseArgs({ options: {
  runtime: { type: 'string' }, 'allow-cwd': { type: 'string', multiple: true },
  port: { type: 'string', default: '7394' }, 'harness-port': { type: 'string' },
  'codex-bin': { type: 'string', default: 'codex' }, 'pwsh-bin': { type: 'string' },
  'implementation-launch-authority': { type: 'string' }, 'review-launch-authority': { type: 'string' },
  'workflow-agent-authority': { type: 'string' }, 'execution-authority': { type: 'string' },
  'adapter-config': { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Yuki Engineering Runtime\n--runtime ABSOLUTE_DIRECTORY --allow-cwd ABSOLUTE_DIRECTORY (repeatable)\n'
    + '--port 7394 (127.0.0.1 only; /mcp and /engineering share one owner)\n'
    + '--adapter-config ABSOLUTE_JSON_PATH (outside writable roots; adapter_id and optional sylvia_profile)\n'
    + 'YER_ADAPTER_TOKEN is a backend-only deployment secret, removed before child creation.\n'
    + 'Existing --implementation-launch-authority / --review-launch-authority / --workflow-agent-authority / --execution-authority policies are reused.\n'
    + '--harness-port PORT optionally retains the read-only diagnostic UI.');
} else {
  let runtime, server, harnessServer;
  const observation = { active: 0, draining: false };
  const adapterToken = process.env.YER_ADAPTER_TOKEN;
  delete process.env.YER_ADAPTER_TOKEN;
  const shutdown = async () => {
    if (observation.draining) return;
    observation.draining = true;
    server?.close(); server?.closeAllConnections();
    try {
      await runtime?.close();
      harnessServer?.close(); harnessServer?.closeAllConnections();
    } catch (error) {
      // Do not force exit/release the writer after an unconfirmed stop.
      observation.draining = false;
      console.error(JSON.stringify(publicError(error)));
    }
  };
  try {
    const roots = values['allow-cwd'] ?? [];
    const paths = [values.runtime, ...roots, ...['adapter-config', 'implementation-launch-authority',
      'review-launch-authority', 'workflow-agent-authority', 'execution-authority'].map(key => values[key]).filter(Boolean)];
    if (!values.runtime || !roots.length || paths.some(value => !path.isAbsolute(value)))
      throw Error('Explicit absolute runtime and allowlist paths are required.');
    const port = Number(values.port), harnessPort = values['harness-port'] ? Number(values['harness-port']) : null;
    for (const number of [port, ...(harnessPort === null ? [] : [harnessPort])])
      if (!Number.isInteger(number) || number < 1 || number > 65535) throw Error('Invalid loopback port.');
    let adapter = {};
    if (values['adapter-config']) {
      const filename = realpathSync(values['adapter-config']);
      if (roots.some(root => { const relative = path.relative(realpathSync(root), filename);
        return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }))
        throw Error('Adapter config must be outside writable roots.');
      adapter = JSON.parse(readFileSync(filename, 'utf8'));
      if (adapter.schema_version !== 1 || typeof adapter.adapter_id !== 'string' ||
          Object.keys(adapter).some(key => !['schema_version', 'adapter_id', 'sylvia_profile'].includes(key)))
        throw Error('Invalid adapter configuration.');
    }
    runtime = createEngineeringRuntime({ runtime: values.runtime, roots, codex: values['codex-bin'], pwsh: values['pwsh-bin'],
      authorityFiles: { implementationLaunchAuthority: values['implementation-launch-authority'],
        reviewLaunchAuthority: values['review-launch-authority'], workflowAgentAuthority: values['workflow-agent-authority'],
        executionAuthority: values['execution-authority'] },
      adapterId: adapter.adapter_id, profile: adapter.sylvia_profile });
    server = createEngineeringHttpServer(runtime.manager, { adapterToken, observation });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    if (harnessPort !== null) {
      harnessServer = createHarnessServer(runtime.manager.harness);
      await new Promise((resolve, reject) => { harnessServer.once('error', reject); harnessServer.listen(harnessPort, '127.0.0.1', resolve); });
    }
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    console.error('YER ready at http://127.0.0.1:' + port + '/mcp; source_id=' + runtime.manager.harness.journal.sourceId);
  } catch (error) {
    console.error(JSON.stringify(publicError(error)));
    await shutdown();
    process.exitCode = 1;
  }
}
