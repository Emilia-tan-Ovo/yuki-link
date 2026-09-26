import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { YcaUnit } from '../src/units.js';
import { WindowsHost } from '../src/host.js';
import { Events, get, sleep, readJson, saveJson, run } from '../src/common.js';
import { toolSummary, createDiagnostics } from '../../codex-session-bridge/src/diagnostics.js';

async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn) { const deadline = Date.now() + 20_000; do { const r = await fn(); if (r) return r; await sleep(200); } while (Date.now() < deadline); throw Error('Timed out'); }

test('real isolated YCA: duplicate start, authenticated ownership, manager recovery, crash recovery and graceful stop', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-live-'));
  const bridge = fileURLToPath(new URL('../../codex-session-bridge/', import.meta.url));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const pwsh = process.env.CC_TEST_PWSH ?? (await run('pwsh.exe', ['-NoProfile', '-Command', '[Console]::Write((Get-Process -Id $PID).Path)'])).output.trim();
  const config = { node: process.execPath, pwsh, codex: process.execPath, entry: path.join(bridge, 'src/main.js'), cwd: bridge, repo: workspace,
    runtime: path.join(root, 'runtime'), port: await port(), controlPort: await port(), harnessPort: await port() };
  const host = new WindowsHost(pwsh), events = new Events(root), file = path.join(root, 'owned.json'); let state = {};
  const persist = () => saveJson(file, state); let unit = new YcaUnit(config, host, state, persist, events);
  t.after(async () => {
    try { await unit.stop(true); } finally {
      const live = await host.inspect(config.node, [config.entry, config.runtime]);
      if (!live.length) { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-live-'))); rmSync(root, { recursive: true, force: true }); }
    }
  });
  await unit.start(); let first = await until(async () => { const o = await unit.observe(); return o.healthy && o; });
  const firstInstance = state.instance;
  assert.equal(first.owned, true); assert.deepEqual(first.tools, await toolSummary());
  const harnessRoot = await get(`http://127.0.0.1:${config.harnessPort}/`);
  assert.ok([200, 503].includes(harnessRoot.status), 'configured Harness listener is reachable');
  if (harnessRoot.status === 503) assert.equal(harnessRoot.body, 'UI_BUILD_UNAVAILABLE', 'a missing optional UI build is not YCA unavailability');
  assert.match(first.deployment.running.commit, /^[a-f0-9]{40}$/);
  assert.equal(first.deployment.state, 'unmanaged');
  await unit.start(); assert.equal((await unit.observe()).pid, first.pid);
  const wrong = await get(`http://127.0.0.1:${config.controlPort}/status`, { token: 'wrong' }); assert.equal(wrong.status, 403);
  const tunneled = await get(`http://127.0.0.1:${config.port}/status`, { token: state.token }); assert.equal(tunneled.status, 404);
  // Fresh adapter is equivalent to reconstructing the supervisor after it dies.
  state = readJson(file); unit = new YcaUnit(config, host, state, persist, events);
  assert.equal((await unit.observe()).owned, true); await unit.start(); assert.equal((await unit.observe()).pid, first.pid);
  // PID reuse/creation-time mismatch never authorizes a stop.
  const realCreated = state.process.created; state.process.created = '1900-01-01T00:00:00Z';
  await assert.rejects(unit.stop(), { code: 'OBSERVED_UNOWNED' }); state.process.created = realCreated;
  // Kill only the child started by this test, using the just-reverified identity.
  assert.equal((await unit.observe()).pid, first.pid); process.kill(first.pid);
  await until(async () => !(await host.inspect(config.node, [], first.pid)).length);
  assert.ok(existsSync(path.join(config.runtime, 'bridge.lock')));
  await unit.start(); const second = await until(async () => { const o = await unit.observe(); return o.healthy && o; });
  assert.notEqual(second.pid, first.pid); assert.notEqual(state.instance, firstInstance);
  await unit.stop(); assert.equal((await unit.observe()).running, false); assert.equal(existsSync(path.join(config.runtime, 'bridge.lock')), false);
  t.diagnostic(`Real Node ${process.version}; isolated HTTP/control ports; no model or production tunnel invoked.`);
});

test('legacy runtime lock and occupied port never trigger deletion or process termination', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-lock-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-lock-'))); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(path.join(root, 'bridge.lock'), JSON.stringify({ pid: 9999999, token: 'legacy' }));
  const host = { inspect: async () => [], free: async () => {} };
  const config = { runtime: root, node: process.execPath, entry: process.execPath, pwsh: process.execPath, codex: process.execPath };
  const unit = new YcaUnit(config, host, {}, () => {}, new Events(root));
  await assert.rejects(unit.start(), { code: 'LEGACY_RUNTIME_LOCK' }); assert.equal(readJson(path.join(root, 'bridge.lock')).token, 'legacy');
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); t.after(() => s.close());
  await assert.rejects(new WindowsHost('unused').free(s.address().port), { code: 'PORT_CONFLICT' });
});

test('diagnostic stop refuses activity until explicit confirmation and schema stays local', async t => {
  let shutdown = 0, drained = false;
  const manager = { running: new Map(), store: { state: { runs: { queued: { status: 'queued', created_at: '2026-01-01' } } } } };
  const computer = { executions: new Set() }, token = 'a'.repeat(64);
  const s = createDiagnostics({ manager, computer, instance: 'test', token, summary: await toolSummary(), requests: () => 0,
    shutdown: () => { shutdown++; }, drain: () => { drained = true; } });
  await new Promise(r => s.listen(0, '127.0.0.1', r)); t.after(() => { s.close(); s.closeAllConnections(); });
  const url = `http://127.0.0.1:${s.address().port}`;
  const busy = await get(url + '/stop', { token, method: 'POST' }); assert.equal(busy.status, 409); assert.equal(shutdown, 0);
  const status = await get(url + '/status', { token }); assert.equal(status.json.active.codex, 1); assert.ok(!JSON.stringify(status.json).includes(token));
  assert.equal((await get(url + '/stop', { token, method: 'POST', confirm: true })).status, 202);
  await sleep(30); assert.equal(shutdown, 1); assert.equal(drained, true);
});

test('YCA observation binds OS identity to the current authenticated instance and valid activity', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-observe-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-observe-'))); rmSync(root, { recursive: true, force: true }); });
  const token = 'a'.repeat(64), instance = 'current-instance';
  const actual = { pid: 12345, created: '2026-01-01T00:00:00Z', matches: true };
  let diagnostic = { service: 'yuki-local-control', instance, pid: actual.pid,
    active: { codex: 0, computer: 0, requests: 0 }, tools: { count: 1, sha256: 'b'.repeat(64) } };
  let denied = false, healthStatus = 200;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/healthz') { response.statusCode = healthStatus;
      return response.end(JSON.stringify({ service: 'yuki-computer-agent', status: 'ok' })); }
    if (denied || request.headers.authorization !== `Bearer ${token}`) { response.statusCode = 403; return response.end('{}'); }
    response.end(JSON.stringify(diagnostic));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const state = { instance, token, process: { ...actual } };
  const config = { node: process.execPath, entry: process.execPath, runtime: root,
    port: server.address().port, controlPort: server.address().port };
  const host = { inspect: async () => [actual], free: async () => {} };
  const unit = new YcaUnit(config, host, state, () => {}, new Events(root));
  assert.equal((await unit.observe()).healthy, true);
  healthStatus = 503;
  let observation = await unit.observe();
  assert.equal(observation.code, 'HEALTH_FAILED');
  assert.deepEqual(observation.healthProbe, { status: 503, code: 'HEALTH_HTTP_ERROR' });
  healthStatus = 200;
  denied = true;
  observation = await unit.observe();
  assert.equal(observation.owned, false); assert.equal(observation.activity, null); assert.equal(observation.healthy, false);
  assert.deepEqual(observation.diagnosticProbe, { status: 403, code: 'OBSERVED_UNOWNED' });
  await assert.rejects(unit.stop(), { code: 'OBSERVED_UNOWNED' });
  denied = false; diagnostic = { ...diagnostic, instance: 'previous-instance' };
  assert.equal((await unit.observe()).owned, false, 'old instance response cannot authenticate this launch');
  diagnostic = { ...diagnostic, instance, active: { codex: -1, computer: 0, requests: 0 } };
  observation = await unit.observe();
  assert.equal(observation.owned, true); assert.equal(observation.activity, null); assert.equal(observation.healthy, false);
  await assert.rejects(unit.stop(), { code: 'ACTIVITY_UNKNOWN' });
  diagnostic = { ...diagnostic, active: { codex: 0, computer: 0, requests: 0 } };
  state.process = null;
  assert.equal((await unit.observe()).owned, true, 'matching authenticated instance can recover missing OS record');
  assert.deepEqual(state.process, actual);
  state.process = { ...actual, created: 'previous-process' };
  assert.equal((await unit.observe()).owned, false, 'PID alone never grants ownership');
  denied = true;
  observation = await unit.observe();
  assert.equal(observation.code, 'OWNERSHIP_CHANGED', 'known OS identity mismatch stays a hard conflict without diagnostics');
  denied = false;
  state.process = { ...actual };
  assert.equal((await unit.observe()).healthy, true, 'manual recheck recovers after diagnostics do');
});

test('YCA health probe accepts a healthy response after the generic 2s deadline', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-slow-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const processInfo = { pid: 12346, created: '2026-01-01T00:00:00Z', matches: true };
  const state = { instance: 'slow-health-instance', token: 'a'.repeat(64), process: processInfo };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/status') return response.end(JSON.stringify({
      service: 'yuki-local-control', instance: state.instance, pid: processInfo.pid,
      active: { codex: 0, computer: 0, requests: 0 },
    }));
    if (request.url === '/healthz') return setTimeout(() => response.end(JSON.stringify({
      service: 'yuki-computer-agent', status: 'ok',
    })), 2300);
    response.statusCode = 404; response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const config = { node: process.execPath, entry: process.execPath, runtime: root,
    port: server.address().port, controlPort: server.address().port };
  const unit = new YcaUnit(config, { inspect: async () => [processInfo] }, state, () => {}, new Events(root));
  const observation = await unit.observe();
  assert.equal(observation.owned, true);
  assert.equal(observation.healthy, true);
  assert.equal(observation.code, null);
});
