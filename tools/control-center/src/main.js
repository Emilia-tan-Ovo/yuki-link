import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { Events, run, claimStateDirectory, readJson, fail } from './common.js';
import { WindowsHost } from './host.js';
import { YcaUnit, TunnelUnit } from './units.js';
import { Supervisor } from './supervisor.js';
import { createServer } from './server.js';
import { Startup } from './startup.js';
import { latestDeployment, prepareDeployment } from './deployment.js';
import { resolveCodexExecutable } from '../../codex-session-bridge/src/codex-executable.js';

const { values } = parseArgs({ options: { config: { type: 'string', default: fileURLToPath(new URL('../../../.local/control-center/config.json', import.meta.url)) } } });
let server, timer;
try {
  const configFile = path.resolve(values.config), c = loadConfig(configFile);
  mkdirSync(c.stateDir, { recursive: true });
  const events = new Events(c.stateDir), host = new WindowsHost(c.pwsh), startup = new Startup(c, configFile);
  // Bind first: the OS is the single-instance arbiter. A second process never
  // loads/mutates shared state or starts services before acquiring this socket.
  let supervisor;
  server = createServer({ snapshot: () => supervisor ? supervisor.snapshot() : { initializing: true },
    action: (...args) => supervisor.action(...args), serial: fn => supervisor.serial(fn), observe: () => supervisor.observe(),
    setRecovery: v => supervisor.setRecovery(v), confirmTools: () => supervisor.confirmTools(),
  }, { startup, codexCheck: async () => {
    await supervisor.serial(async () => {
      try {
        const resolved = resolveCodexExecutable(c.codex);
        const r = await run(resolved.executable, ['--version']);
        supervisor.codex = { cli: r.code === 0 && /^codex-cli [\w.+-]+\s*$/.test(r.output) ? r.output.trim() : '检查失败',
          source: resolved.source, refreshed: resolved.refreshed,
          account: '未检查（需授权使用已有账号）', inference: '未在此验证', at: new Date().toISOString() };
      } catch (error) { supervisor.codex = { cli: error.code === 'CODEX_EXECUTABLE_UNAVAILABLE' ? '配置路径失效，自动发现未找到可用 CLI' : 'CLI 启动检查失败', code: error.code, account: '未检查', inference: '未在此验证' }; }
    });
  }, deploymentCheck: operation => supervisor.checkDeployment(async () => {
    if (!c.yca.deploymentRoot) throw fail('DEPLOYMENT_NOT_CONFIGURED');
    return latestDeployment(c.yca.repo);
  }, operation), deploymentUpdate: (restart, confirm, operation) => supervisor.updateDeployment(async () => {
    if (!c.yca.deploymentRoot) throw fail('DEPLOYMENT_NOT_CONFIGURED');
    return prepareDeployment({ repo: c.yca.repo, root: c.yca.deploymentRoot, node: c.node });
  }, { restart, confirm, operation }) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.port, '127.0.0.1', resolve); });
  claimStateDirectory(c.stateDir, c.port, configFile);
  supervisor = new Supervisor({ stateFile: path.join(c.stateDir, 'state.json'), events, observeOnly: c.observeOnly,
    createUnits: (state, persist) => ({
      yca: new YcaUnit({ ...c.yca, node: c.node, pwsh: c.pwsh, codex: c.codex,
        servicesUrl: `http://127.0.0.1:${c.port}/harness/services`,
        controlRoots: [path.dirname(configFile), c.stateDir, ...(c.yca.deploymentRoot ? [c.yca.deploymentRoot] : [])] }, host, state.units.yca.ownership, persist, events),
      tunnel: new TunnelUnit({ ...c.tunnel, backupDir: c.stateDir }, host, state.units.tunnel.ownership, persist, events),
    }),
  });
  supervisor.identity = { name: 'yuki-control-center', pid: process.pid, startedAt: new Date().toISOString(), instance: randomUUID(), configId: createHash('sha256').update(configFile.toLowerCase()).digest('hex') };
  supervisor.versions = { controlCenter: '0.1.0', node: process.version, yca: readJson(fileURLToPath(new URL('../../codex-session-bridge/package.json', import.meta.url))).version, tunnel: '未检查' };
  try { const version = await run(c.tunnel.bin, ['--version']); if (version.code === 0 && /^[\w.+() :\r\n-]{1,200}$/.test(version.output)) supervisor.versions.tunnel = version.output.trim(); } catch { /* Report unavailable, never infer installed version. */ }
  await startup.refresh(); await supervisor.reconcileStartup(); await supervisor.tick();
  let checking = false;
  timer = setInterval(async () => {
    if (checking) return; checking = true;
    try { await supervisor.tick(); } catch (e) { events.add('supervisor', 'check-failed', e.code ?? 'CHECK_FAILED'); }
    finally { checking = false; }
  }, 5000);
  events.add('supervisor', 'ready');
  console.log(`Control Center http://127.0.0.1:${c.port}`);
  const close = () => { clearInterval(timer); server.close(); server.closeIdleConnections(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
} catch (e) {
  clearInterval(timer); server?.close();
  // An occupied port can be a different application. Do not call it our instance.
  console.error(e.code === 'EADDRINUSE' ? 'CONTROL_PORT_OCCUPIED' : /^[A-Z_]{2,80}$/.test(e.code ?? '') ? e.code : 'CONTROL_START_FAILED');
  process.exitCode = 1;
}
