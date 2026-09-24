import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ModelCatalog } from './catalog.js';
import { RuntimeStore } from './store.js';
import { CodexExecutor } from './executor.js';
import { PermissionResolver } from './permissions.js';
import { SessionManager } from './manager.js';
import { createMcpServer } from './mcp.js';
import { createHttpServer } from './http.js';
import { BridgeError, publicError } from './errors.js';
import { ComputerTools } from './computer/tools.js';
import { createDiagnostics, toolSummary } from './diagnostics.js';
import { sourceVersion } from './source.js';
import { createHarnessRuntime, createHarnessServer } from './harness/runtime.ts';
import { FileImplementationLaunchAuthoritySource } from './orchestration/implementation-launcher.ts';
import { FileReviewLaunchAuthoritySource } from './orchestration/review-launcher.ts';
import { FileWorkflowAgentAuthoritySource } from './orchestration/workflow-agent-launcher.ts';

const toolRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: {
  transport: { type: 'string', default: 'stdio' },
  port: { type: 'string', default: '7391' },
  runtime: { type: 'string', default: path.join(toolRoot, 'runtime') },
  'allow-cwd': { type: 'string', multiple: true },
  'read-root': { type: 'string', multiple: true },
  'pwsh-bin': { type: 'string', default: process.platform === 'win32' ? 'pwsh.exe' : 'pwsh' },
  'codex-bin': { type: 'string', default: 'codex' },
  help: { type: 'boolean', default: false },
  'control-port': { type: 'string' },
  'control-instance': { type: 'string' },
  'control-root': { type: 'string', multiple: true },
  'harness-port': { type: 'string' },
  'services-url': { type: 'string' },
  'implementation-launch-authority': { type: 'string' },
  'review-launch-authority': { type: 'string' },
  'workflow-agent-authority': { type: 'string' },
} });

if (values.help) {
  console.log('--harness-port PORT (optional separate loopback read-only Harness UI; never tunnel this listener)');
  console.log('--services-url URL (optional Control Center daily-services navigation; strict loopback URL only)');
  console.log('--implementation-launch-authority ABSOLUTE_JSON_PATH (trusted versioned policy and Ticket authorization source for start_ticket_implementation)');
  console.log('--review-launch-authority ABSOLUTE_JSON_PATH (trusted versioned policy and Ticket authorization source for start_ticket_review)');
  console.log('--workflow-agent-authority ABSOLUTE_JSON_PATH (trusted policies and Ticket authorizations for the unified Workflow Agent launcher)');
  console.log('Yuki Computer Agent\n--transport stdio|http (default stdio)\n--port 7391 (HTTP binds only 127.0.0.1)\n--allow-cwd ABSOLUTE_PATH (repeatable; required; Codex cwd and filesystem write roots)\n--read-root ABSOLUTE_PATH (repeatable; optional additional read roots)\n--runtime ABSOLUTE_PATH (default tools/codex-session-bridge/runtime)\n--codex-bin EXECUTABLE (default codex)\n--pwsh-bin EXECUTABLE (default pwsh.exe on Windows)');
} else {
  let store;
  let manager;
  let computer;
  let httpServer;
  let controlServer;
  let harnessServer;
  const closeExecutionSources = async () => {
    if (manager) manager.closing = true;
    if (computer) computer.closing = true;
    if (manager?.harness) manager.harness.computerCalls.closing = true;
    // Attempt every source even if another stop rejects. No source owns the
    // shared writer's release until all stop/capture outcomes are confirmed.
    const sources = ['computer', 'codex', 'sync-recording'];
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => computer?.close()),
      Promise.resolve().then(() => manager?.stopRuns()),
      Promise.resolve().then(() => manager?.harness?.computerCalls.drain()),
    ]);
    const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [{ source: sources[index], error: publicError(outcome.reason) }] : []);
    if (failures.length) throw new BridgeError('STOP_FAILED', 'Execution sources could not all close; retain the runtime writer and observation.', { failures });
    if (manager) await manager.close(); // Final capture/recheck, then writer release.
    else store?.close();
  };
  try {
    if (!values['allow-cwd']?.length || !['stdio', 'http'].includes(values.transport)) throw new Error('Specify --allow-cwd and a supported --transport.');
    if (!path.isAbsolute(values.runtime) || [...values['allow-cwd'], ...(values['read-root'] ?? []), ...(values['control-root'] ?? []),
      ...(values['implementation-launch-authority'] ? [values['implementation-launch-authority']] : []),
      ...(values['review-launch-authority'] ? [values['review-launch-authority']] : []),
      ...(values['workflow-agent-authority'] ? [values['workflow-agent-authority']] : [])].some(p => !path.isAbsolute(p))) throw new Error('Runtime, allowlist and authority paths must be absolute.');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const harnessPort = values['harness-port'] === undefined ? null : Number(values['harness-port']);
    if (harnessPort !== null && (!Number.isInteger(harnessPort) || harnessPort < 1 || harnessPort > 65535)) throw new Error('Invalid Harness port.');
    const catalog = new ModelCatalog(values['codex-bin']);
    // Codex capability discovery is lazy; unavailable Codex must not block computer tools.
    store = new RuntimeStore(values.runtime);
    manager = new SessionManager({ store, catalog, executor: new CodexExecutor(values['codex-bin']), permissionResolver: new PermissionResolver(values['codex-bin']), allowedCwds: values['allow-cwd'] });
    manager.implementationLaunchAuthority = values['implementation-launch-authority']
      ? new FileImplementationLaunchAuthoritySource(values['implementation-launch-authority'], {
        forbiddenRoots: values['allow-cwd'],
      }) : null;
    manager.reviewLaunchAuthority = values['review-launch-authority']
      ? new FileReviewLaunchAuthoritySource(values['review-launch-authority'], {
        forbiddenRoots: values['allow-cwd'],
      }) : null;
    manager.workflowAgentAuthority = values['workflow-agent-authority']
      ? new FileWorkflowAgentAuthoritySource(values['workflow-agent-authority'], {
        forbiddenRoots: values['allow-cwd'],
      }) : null;
    computer = new ComputerTools({ readRoots: [...values['allow-cwd'], ...(values['read-root'] ?? [])], writeRoots: values['allow-cwd'], runtime: values.runtime, controlRoots: values['control-root'], pwsh: values['pwsh-bin'] });
    manager.harness = createHarnessRuntime(manager, values['control-root'], computer.tasks);
    let server;
    const observation = { active: 0 };
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      observation.draining = true;
      manager.closing = true;
      computer.closing = true;
      manager.harness.computerCalls.closing = true;
      try {
        // Raw connected sockets are not part of activity counters and can keep Node alive after an accepted stop.
        if (httpServer) { httpServer.close(); httpServer.closeIdleConnections(); httpServer.closeAllConnections(); }
        // Keep the writer and read-only observation alive until all computer
        // results are captured. Failed termination must not release ownership.
        await closeExecutionSources();
        if (controlServer) { controlServer.close(); controlServer.closeIdleConnections(); controlServer.closeAllConnections(); }
        if (harnessServer) { harnessServer.close(); harnessServer.closeAllConnections(); }
        if (server) await server.close();
        process.exitCode = 0;
      } catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    if (values.transport === 'http') {
      httpServer = createHttpServer(manager, computer, observation);
      await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, '127.0.0.1', resolve); });
      if (values['control-port']) {
        const controlPort = Number(values['control-port']);
        if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535 || !values['control-instance']) throw new Error('Invalid local control configuration.');
        const controlToken = process.env.YUKI_CONTROL_TOKEN;
        delete process.env.YUKI_CONTROL_TOKEN; // Do not propagate control credentials to tools/Codex.
        controlServer = createDiagnostics({ manager, computer, instance: values['control-instance'], token: controlToken,
          summary: await toolSummary(), source: sourceVersion(), requests: () => observation.active, shutdown, drain: () => { observation.draining = true; } });
        await new Promise((resolve, reject) => { controlServer.once('error', reject); controlServer.listen(controlPort, '127.0.0.1', resolve); });
      }
      console.error(`Yuki Computer Agent ready at http://127.0.0.1:${port}/mcp`);
    } else {
      server = createMcpServer(manager, computer);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      process.stdin.once('end', shutdown);
      console.error('Yuki Computer Agent ready on stdio');
    }
    if (harnessPort !== null) {
      harnessServer = createHarnessServer(manager.harness, values['services-url']);
      // UI availability is independent from execution and durable capture.
      harnessServer.on('error', () => console.error('HARNESS_UI_UNAVAILABLE: check the separate loopback port; background recording continues.'));
      harnessServer.listen(harnessPort, '127.0.0.1', () => console.error(`Yuki Harness ready at http://127.0.0.1:${harnessPort}/`));
    }
  } catch (error) {
    httpServer?.close(); httpServer?.closeAllConnections();
    console.error(JSON.stringify(publicError(error)));
    try {
      await closeExecutionSources();
      controlServer?.close(); controlServer?.closeAllConnections();
      harnessServer?.close(); harnessServer?.closeAllConnections();
    } catch (cleanupError) { console.error(JSON.stringify(publicError(cleanupError))); }
    process.exitCode = 1;
  }
}
