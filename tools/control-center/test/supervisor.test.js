import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Supervisor } from '../src/supervisor.js';
import { Events, fail, claimStateDirectory } from '../src/common.js';
import { YcaUnit, tunnelHealth } from '../src/units.js';
import { loadConfig } from '../src/config.js';

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-test-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-test-'))); rmSync(root, { recursive: true, force: true }); });
  let time = Date.now();
  const units = Object.fromEntries(['yca', 'tunnel'].map(id => [id, {
    running: false, healthy: false, owned: true, activity: { codex: 0, computer: 0, requests: 0 }, starts: 0, stops: 0,
    async observe() { return { running: this.running, healthy: this.healthy, owned: this.owned, activity: this.activity, code: this.code, controlPlane: { state: 'healthy' } }; },
    async start() { this.starts++; if (this.failure) throw fail(this.failure); this.running = true; this.healthy = true; },
    async stop() { this.stops++; this.running = false; this.healthy = false; },
  }]));
  const options = { stateFile: path.join(root, 'state.json'), events: new Events(root), clock: () => time, createUnits: () => units, startupMs: 0 };
  const manager = new Supervisor(options);
  return { manager, units, options, root, advance: ms => { time += ms; } };
}

test('abnormal YCA exit retains only a bounded redacted stderr tail', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-crash-tail-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-crash-tail-'))); rmSync(root, { recursive: true, force: true }); });
  const state = {}; let spawnOptions, spawned = false;
  const child = new EventEmitter(); child.pid = 4242; child.stderr = new PassThrough(); child.unref = () => {};
  const host = { async free() {}, async inspect() { return spawned ? [{ pid: child.pid, created: 'fixture', matches: true }] : []; } };
  const config = { node: process.execPath, pwsh: process.execPath, codex: process.execPath, entry: process.execPath, cwd: root, repo: root,
    runtime: path.join(root, 'runtime'), port: 57391, controlPort: 57393 };
  const unit = new YcaUnit(config, host, state, () => {}, { add() {} }, { spawnProcess: (_exe, _args, options) => {
    spawnOptions = options; spawned = true; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  await unit.start();
  child.stderr.write('x'.repeat(20_000));
  child.stderr.write('\n' + 'api_' + 'key=fixture-value\nFATAL_MARKER\n');
  child.emit('exit', 1); child.stderr.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(state.lastExit.exitCode, 1);
  assert.ok(Buffer.byteLength(state.lastExit.stderrTail, 'utf8') <= 16 * 1024);
  assert.match(state.lastExit.stderrTail, /FATAL_MARKER/);
  assert.equal(state.lastExit.stderrTail.includes('fixture-value'), false);
  assert.equal(state.lastExit.stderrTail.includes('[REDACTED]'), true);
});
test('optional Harness port keeps legacy config valid and participates in local port conflict validation', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-config-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-config-'))); rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'config.json');
  const config = {
    version: 1, observeOnly: true, allowStartupChanges: false, port: 7392, stateDir: path.join(root, 'state'),
    node: process.execPath, pwsh: process.execPath, codex: process.execPath,
    yca: { entry: process.execPath, cwd: root, repo: root, runtime: path.join(root, 'runtime'), port: 7391, controlPort: 7393 },
    tunnel: { bin: process.execPath, alias: 'codex-session-bridge', profile: path.join(root, 'profile.json'),
      stateRoot: path.join(root, 'tunnel'), target: 'http://127.0.0.1:7391/mcp' },
  };
  writeFileSync(file, JSON.stringify(config), 'utf8');
  assert.equal(loadConfig(file).yca.harnessPort, undefined, 'existing config remains valid');
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca, harnessPort: 7394 } }), 'utf8');
  assert.equal(loadConfig(file).yca.harnessPort, 7394);
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca, harnessPort: 7392 } }), 'utf8');
  assert.throws(() => loadConfig(file), { code: 'PORT_CONFIG_INVALID' });
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca,
    implementationLaunchAuthority: 'relative-authority.json' } }), 'utf8');
  assert.throws(() => loadConfig(file), { code: 'ABSOLUTE_PATH_REQUIRED' });
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca,
    implementationLaunchAuthority: path.join(root, 'authority.json') } }), 'utf8');
  assert.equal(loadConfig(file).yca.implementationLaunchAuthority, path.join(root, 'authority.json'));
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca,
    reviewLaunchAuthority: 'relative-review-authority.json' } }), 'utf8');
  assert.throws(() => loadConfig(file), { code: 'ABSOLUTE_PATH_REQUIRED' });
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca,
    reviewLaunchAuthority: path.join(root, 'review-authority.json') } }), 'utf8');
  assert.equal(loadConfig(file).yca.reviewLaunchAuthority, path.join(root, 'review-authority.json'));
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca,
    workflowAgentAuthority: 'relative-workflow-agent-authority.json' } }), 'utf8');
  assert.throws(() => loadConfig(file), { code: 'ABSOLUTE_PATH_REQUIRED' });
  writeFileSync(file, JSON.stringify({ ...config, yca: { ...config.yca,
    workflowAgentAuthority: path.join(root, 'workflow-agent-authority.json') } }), 'utf8');
  assert.equal(loadConfig(file).yca.workflowAgentAuthority, path.join(root, 'workflow-agent-authority.json'));
});

test('serialized repeated starts, dependency order, stop intent and manager restart', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  // An idempotent adapter must not launch twice when a live owned process exists.
  for (const unit of Object.values(u)) { const original = unit.start; unit.start = async function() { if (!this.running) await original.call(this); }; }
  await Promise.all([m.action('all', 'start'), m.action('all', 'start')]);
  assert.equal(u.yca.starts, 1); assert.equal(u.tunnel.starts, 1);
  await m.setRecovery(true); await m.action('all', 'stop');
  f.advance(3_600_000); const restarted = new Supervisor(f.options); await restarted.tick();
  assert.equal(u.yca.starts, 1); assert.equal(u.tunnel.starts, 1);
  assert.equal(restarted.snapshot().units.yca.desired, 'stopped');
});

test('cold startup realizes only a reliably stopped persisted YCA intent', async t => {
  const f = setup(t), { manager: initial, units } = f;
  await initial.action('yca', 'start');
  const commit = 'a'.repeat(40);
  initial.state.units.yca.ownership.deployment = { commit };
  initial.persist();
  units.yca.running = false; units.yca.healthy = false;
  const beforeTunnel = units.tunnel.starts;
  let options;
  units.yca.start = async function(input) { options = input; this.starts++; this.running = true; this.healthy = true; };
  const restarted = new Supervisor(f.options);
  await restarted.reconcileStartup();
  assert.deepEqual(options, { recovery: true, commit });
  assert.equal(restarted.state.units.yca.desired, 'running');
  assert.equal(restarted.state.autoRecovery, true);
  assert.equal(units.tunnel.starts, beforeTunnel);

  units.yca.running = false; units.yca.healthy = false; options = undefined;
  restarted.state.units.yca.desired = 'stopped'; restarted.persist();
  await new Supervisor(f.options).reconcileStartup();
  assert.equal(options, undefined, 'stopped intent is inert');

  restarted.state.units.yca.desired = 'running'; restarted.persist();
  units.yca.running = null;
  await new Supervisor(f.options).reconcileStartup();
  assert.equal(options, undefined, 'unknown observation is inert');

  units.yca.running = true; units.yca.owned = false;
  await new Supervisor(f.options).reconcileStartup();
  assert.equal(options, undefined, 'unowned process is inert');

  units.yca.running = false; units.yca.owned = true; units.yca.code = 'LEGACY_RUNTIME_LOCK';
  await new Supervisor(f.options).reconcileStartup();
  assert.equal(options, undefined, 'conflicting stopped observation is inert');
});

test('cold startup remains inert in observe-only mode', async t => {
  const f = setup(t), { manager: initial, units } = f;
  await initial.action('yca', 'start');
  units.yca.running = false; units.yca.healthy = false;
  const starts = units.yca.starts;

  const observing = new Supervisor({ ...f.options, observeOnly: true });
  await observing.reconcileStartup();

  assert.equal(observing.state.units.yca.desired, 'running');
  assert.equal(units.yca.starts, starts, 'observe-only cold start must not realize persisted intent');
  assert.equal(units.tunnel.starts, 0);
});

test('startup reconciliation events survive bounded reload without accepting arbitrary actions', t => {
  const f = setup(t);
  f.options.events.add('yca', 'startup-reconciled');
  f.options.events.add('yca', 'startup-reconciliation-failed', 'PATH_MISSING');
  f.options.events.add('yca', 'arbitrary-startup-action');

  const restored = new Events(f.root).items;
  assert.deepEqual(restored.map(({ component, action, code }) => ({ component, action, code })), [
    { component: 'yca', action: 'startup-reconciled', code: null },
    { component: 'yca', action: 'startup-reconciliation-failed', code: 'PATH_MISSING' },
  ]);
});

test('service operations record requested and terminal outcomes that survive supervisor restart', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  const succeeded = '11111111-1111-4111-8111-111111111111';
  await m.action('yca', 'start', false, { operationId: succeeded, action: 'start', target: 'yca' });
  u.yca.running = false; u.yca.healthy = false; u.yca.failure = 'PATH_MISSING';
  const failed = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(m.action('yca', 'start', false, { operationId: failed, action: 'start', target: 'yca' }), { code: 'PATH_MISSING' });
  const restored = new Events(f.root).items.filter(event => event.operation_id);
  assert.deepEqual(restored.map(({ operation_id, action, target, outcome, code }) => ({ operation_id, action, target, outcome, code })), [
    { operation_id: succeeded, action: 'start', target: 'yca', outcome: 'requested', code: null },
    { operation_id: succeeded, action: 'start', target: 'yca', outcome: 'succeeded', code: null },
    { operation_id: failed, action: 'start', target: 'yca', outcome: 'requested', code: null },
    { operation_id: failed, action: 'start', target: 'yca', outcome: 'failed', code: 'PATH_MISSING' },
  ]);
  u.yca.failure = null;
  for (let index = 0; index < 40; index++) {
    u.yca.running = false; u.yca.healthy = false;
    const operationId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
    await m.action('yca', 'start', false, { operationId, action: 'start', target: 'yca' });
  }
  assert.ok(m.snapshot().events.length <= 80);
  assert.ok(new Events(f.root).items.length <= 80, 'bounded operation metadata must remain bounded after restart');
});

test('service side effect with final persistence failure remains requested and unknown', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  const operation = { operationId: '77777777-7777-4777-8777-777777777777', action: 'start', target: 'yca' };
  const persist = m.persist.bind(m);
  let writes = 0;
  m.persist = () => { if (++writes === 2) throw fail('STATE_WRITE_FAILED'); persist(); };

  await assert.rejects(m.action('yca', 'start', false, operation), error => error.operationOutcome === 'unknown');
  assert.equal(u.yca.running, true, 'the service side effect already happened');
  assert.deepEqual(new Events(f.root).items.filter(event => event.operation_id === operation.operationId).map(event => event.outcome), ['requested']);
});

test('terminal event persistence failure remains requested and unknown after service side effect', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  const operation = { operationId: '88888888-8888-4888-8888-888888888888', action: 'start', target: 'yca' };
  const addOperation = m.events.addOperation.bind(m.events);
  m.events.addOperation = (...args) => {
    if (args[3] !== 'requested') throw fail('EVENT_WRITE_FAILED');
    addOperation(...args);
  };

  await assert.rejects(m.action('yca', 'start', false, operation), error => error.operationOutcome === 'unknown');
  assert.equal(u.yca.running, true, 'the service side effect already happened');
  assert.deepEqual(new Events(f.root).items.filter(event => event.operation_id === operation.operationId).map(event => event.outcome), ['requested']);
});

test('deployment success is not terminal until final persistence completes', async t => {
  const f = setup(t), { manager: m } = f;
  const operation = { operationId: '99999999-9999-4999-8999-999999999999', action: 'prepare', target: 'yca' };
  let prepared = false;
  m.persist = () => { throw fail('STATE_WRITE_FAILED'); };

  await assert.rejects(m.updateDeployment(async () => {
    prepared = true;
    return { commit: 'a'.repeat(40), branch: 'main', tools: { count: 1, sha256: 'b'.repeat(64) } };
  }, { operation }), error => error.operationOutcome === 'unknown');
  assert.equal(prepared, true, 'deployment preparation already happened');
  assert.deepEqual(new Events(f.root).items.filter(event => event.operation_id === operation.operationId).map(event => event.outcome), ['requested']);
});

test('deployment operations keep correlated terminal outcomes in the Control Center event log', async t => {
  const f = setup(t), m = f.manager;
  const checked = { operationId: '44444444-4444-4444-8444-444444444444', action: 'check-remote', target: 'yca' };
  await m.checkDeployment(async () => ({ branch: 'main', commit: 'a'.repeat(40) }), checked);
  const update = { operationId: '55555555-5555-4555-8555-555555555555', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(async () => { throw fail('DEPLOYMENT_GIT_FAILED'); }, { restart: true, operation: update }),
    { code: 'DEPLOYMENT_GIT_FAILED' });
  const restored = new Events(f.root).items.filter(event => event.operation_id);
  assert.deepEqual(restored.map(event => [event.operation_id, event.action, event.outcome, event.code]), [
    [checked.operationId, 'check-remote', 'requested', null],
    [checked.operationId, 'check-remote', 'succeeded', null],
    [update.operationId, 'update-and-restart', 'requested', null],
    [update.operationId, 'update-and-restart', 'failed', 'DEPLOYMENT_GIT_FAILED'],
  ]);
});

test('manual schema confirmation records the running service instead of adjacent supervisor source', async t => {
  const { manager: m } = setup(t);
  m.localTools = { count: 13, sha256: 'old-supervisor' };
  await assert.rejects(m.confirmTools(), { code: 'SCHEMA_UNAVAILABLE' });
  m.observations.yca = { running: true, owned: true, at: Date.now(), tools: { count: 14, sha256: 'running-yca' } };
  await m.confirmTools();
  assert.equal(m.snapshot().tools.confirmed.sha256, 'running-yca');
  assert.equal(m.snapshot().tools.possibleRefresh, false);
  m.observations.yca.tools = { count: 14, sha256: 'next-yca' };
  assert.equal(m.snapshot().tools.possibleRefresh, true);
});

test('automatic recovery explicitly requests the previous deployment, never the prepared candidate', async t => {
  const f = setup(t);
  let options;
  f.units.yca.start = async function (input) { options = input; this.running = true; this.healthy = true; };
  await f.manager.action('yca', 'start'); assert.equal(options.recovery ?? false, false);
  await f.manager.setRecovery(true); f.units.yca.running = false; f.units.yca.healthy = false;
  await f.manager.tick(); f.advance(2000); await f.manager.tick();
  assert.equal(options.recovery, true);
});

test('a transient YCA health failure recovers and then starts the waiting tunnel', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  await m.action('yca', 'start');
  m.state.units.tunnel.desired = 'running'; m.persist();
  u.yca.healthy = false; u.yca.code = 'HEALTH_FAILED';
  for (let i = 0; i < 3; i++) { f.advance(5000); await m.tick(); }
  assert.equal(m.snapshot().units.yca.retries, 0);
  assert.ok(m.snapshot().units.yca.nextAt);
  assert.equal(m.snapshot().units.tunnel.blocked, 'YCA_NOT_READY');
  assert.equal(u.tunnel.starts, 0);
  f.advance(2000); await m.tick();
  assert.equal(u.yca.stops, 1);
  assert.equal(m.snapshot().units.yca.retries, 1);
  await m.tick();
  assert.equal(u.tunnel.starts, 1);
  assert.equal(m.snapshot().units.tunnel.blocked, null);
});

test('a direct YCA_NOT_READY start request waits and resumes without a second request', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  await assert.rejects(m.action('tunnel', 'start'), { code: 'YCA_NOT_READY' });
  assert.equal(m.snapshot().units.tunnel.blocked, 'YCA_NOT_READY');
  assert.equal(m.snapshot().units.tunnel.retries, 0);
  await m.action('yca', 'start');
  await m.tick();
  assert.equal(u.tunnel.starts, 1);
  assert.equal(m.snapshot().units.tunnel.blocked, null);
});

test('a live tunnel waits for YCA without a stale retry timer or duplicate launch', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  await m.action('all', 'start');
  u.yca.healthy = false; u.yca.code = 'HEALTH_FAILED';
  await m.tick();
  assert.equal(m.snapshot().units.tunnel.blocked, 'YCA_NOT_READY');
  u.yca.healthy = true; u.yca.code = null;
  await m.tick();
  assert.equal(m.snapshot().units.tunnel.blocked, null);
  assert.equal(m.snapshot().units.tunnel.nextAt, null);
  assert.equal(u.tunnel.starts, 1);
});

test('persistent YCA health failure exhausts a durable budget without restart storm', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  await m.action('yca', 'start');
  u.yca.code = 'HEALTH_FAILED';
  u.yca.observe = async function() { return { running: this.running, owned: true, authenticated: true,
    healthy: false, code: 'HEALTH_FAILED', activity: { codex: 0, computer: 0, requests: 0 } }; };
  for (let i = 0; i < 20; i++) { f.advance(30_000); await m.tick(); }
  assert.equal(m.snapshot().units.yca.retries, 5);
  assert.equal(m.snapshot().units.yca.blocked, 'RECOVERY_BUDGET_EXHAUSTED');
  assert.equal(m.snapshot().units.yca.nextAt, null);
  const starts = u.yca.starts;
  f.advance(3_600_000); await m.tick();
  assert.equal(u.yca.starts, starts);
  assert.equal(new Supervisor(f.options).snapshot().units.yca.blocked, 'RECOVERY_BUDGET_EXHAUSTED');
});

test('cold reconciliation restores desired YCA and tunnel in dependency order', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  await m.action('all', 'start');
  u.yca.running = false; u.yca.healthy = false;
  u.tunnel.running = false; u.tunnel.healthy = false;
  const restarted = new Supervisor(f.options);
  await restarted.reconcileStartup();
  assert.equal(u.yca.starts, 2);
  assert.equal(u.tunnel.starts, 2);
  assert.equal(restarted.snapshot().units.tunnel.healthy, true);
});

test('repeated long check gaps still advance bounded recovery', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  await m.action('yca', 'start');
  u.yca.running = false; u.yca.healthy = false;
  for (let i = 0; i < 5; i++) { f.advance(60_000); await m.tick(); }
  assert.equal(u.yca.starts, 2);
  assert.equal(m.snapshot().units.yca.retries, 1);
});

test('duplicate recovery ticks never start a second owned instance', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  await m.action('yca', 'start');
  u.yca.running = false; u.yca.healthy = false;
  await Promise.all([m.tick(), m.tick()]);
  f.advance(2000);
  await Promise.all([m.tick(), m.tick()]);
  assert.equal(u.yca.starts, 2);
});

test('activity protection runs before dependent stops; unknown is not idle', async t => {
  const { manager: m, units: u } = setup(t);
  await m.action('all', 'start'); u.yca.activity.computer = 1;
  await assert.rejects(m.action('all', 'restart'), { code: 'ACTIVE_TASKS' });
  assert.equal(u.tunnel.stops, 0); assert.equal(u.yca.stops, 0);
  assert.equal(m.state.units.yca.desired, 'running', 'rejected restart keeps the intended running state');
  assert.equal(m.state.units.tunnel.desired, 'running');
  u.yca.activity = null;
  await assert.rejects(m.action('tunnel', 'stop'), { code: 'ACTIVITY_UNKNOWN' });
  await m.action('all', 'stop', true); assert.equal(u.tunnel.stops, 1);
});

test('unknown diagnostic is not misreported as an external ownership conflict', t => {
  const { manager: m } = setup(t);
  m.state.units.yca.ownership.deployment = { commit: 'a'.repeat(40) };
  m.observations.yca = { running: true, owned: false, code: 'ACTIVITY_UNKNOWN', deployment: { state: 'unverified' } };
  assert.throws(() => m.currentYcaCommit(), { code: 'ACTIVITY_UNKNOWN' });
});

test('startup gets one final readiness observation before reporting timeout', async t => {
  const { manager: m, units: u } = setup(t);
  m.startupMs = 0;
  let observations = 0;
  u.yca.start = async function() { this.starts++; this.running = true; this.healthy = false; };
  u.yca.observe = async function() {
    observations++;
    return { running: true, healthy: observations >= 2, owned: true, authenticated: true,
      activity: { codex: 0, computer: 0, requests: 0 }, code: null };
  };
  await m.startOne('yca');
  assert.equal(observations, 2);
});

test('startup waits for a transient health failure on the same managed instance', async t => {
  const { manager: m, units: u } = setup(t);
  m.startupMs = 1000;
  let observations = 0;
  u.yca.start = async function() { m.state.units.yca.ownership.instance = 'recovering-instance'; };
  u.yca.observe = async function() {
    observations++;
    return { running: true, owned: true, authenticated: true, instance: 'recovering-instance',
      healthy: observations >= 2, code: observations >= 2 ? null : 'HEALTH_FAILED',
      activity: { codex: 0, computer: 0, requests: 0 } };
  };
  await m.startOne('yca');
  assert.equal(observations, 2);
  assert.equal(m.state.units.yca.blocked, null);
});

test('a later fully verified observation clears only a stale YCA startup timeout', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const commit = 'a'.repeat(40), tools = { count: 14, sha256: 'b'.repeat(64) };
  const processInfo = { pid: 4242, created: 'current-process' };
  Object.assign(m.state.units.yca.ownership, { instance: 'current-instance', process: processInfo, deployment: { commit, tools } });
  let healthy = false;
  u.start = async () => {};
  u.observe = async () => ({ running: true, owned: true, authenticated: true, healthy,
    instance: 'current-instance', ...processInfo, activity: { codex: 0, computer: 0, requests: 0 },
    tools, deployment: { state: 'update-pending', running: { commit, dirty: false } },
    code: healthy ? null : 'HEALTH_FAILED' });
  await assert.rejects(m.action('yca', 'start'), { code: 'STARTUP_TIMEOUT' });
  assert.equal(m.snapshot().units.yca.blocked, 'STARTUP_TIMEOUT');
  healthy = true;
  const restarted = new Supervisor(f.options);
  await restarted.observe();
  assert.equal(restarted.snapshot().units.yca.blocked, null);
  assert.equal(JSON.parse(readFileSync(f.options.stateFile, 'utf8')).units.yca.blocked, null);
  restarted.state.units.yca.blocked = 'DEPLOYMENT_ROLLBACK_FAILED'; restarted.persist();
  await restarted.observe();
  assert.equal(restarted.snapshot().units.yca.blocked, 'DEPLOYMENT_ROLLBACK_FAILED');
});

test('startup timeout remains blocked without matching ownership and deployment proof', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const commit = 'a'.repeat(40), tools = { count: 14, sha256: 'b'.repeat(64) };
  Object.assign(m.state.units.yca, { desired: 'running', blocked: 'STARTUP_TIMEOUT' });
  Object.assign(m.state.units.yca.ownership, { instance: 'current-instance', process: { pid: 4242, created: 'current-process' }, deployment: { commit, tools } });
  const good = { running: true, owned: true, authenticated: true, healthy: true,
    instance: 'current-instance', pid: 4242, created: 'current-process',
    activity: { codex: 0, computer: 0, requests: 0 }, tools,
    deployment: { state: 'verified', running: { commit, dirty: false } }, code: null };
  for (const bad of [
    { authenticated: false }, { owned: false }, { instance: 'other-instance' },
    { pid: 4243 }, { healthy: false, code: 'HEALTH_FAILED' },
    { deployment: { state: 'unverified', running: { commit, dirty: false } } },
    { deployment: { state: 'verified', running: { commit: 'c'.repeat(40), dirty: false } } },
  ]) {
    u.observe = async () => ({ ...good, ...bad });
    await m.observe();
    assert.equal(m.snapshot().units.yca.blocked, 'STARTUP_TIMEOUT');
  }
});

test('startup rejects an explicit authentication or ownership mismatch', async t => {
  const { manager: m, units: u } = setup(t);
  m.startupMs = 0;
  u.yca.start = async function() { m.state.units.yca.ownership.instance = 'expected-instance'; };
  u.yca.observe = async () => ({ running: true, owned: false, authenticated: false, healthy: false,
    code: 'OBSERVED_UNOWNED' });
  await assert.rejects(m.startOne('yca'), { code: 'OBSERVED_UNOWNED' });
});

test('a healthy owned tunnel clears only its stale startup timeout after supervisor reload', async t => {
  const f = setup(t), m = f.manager, tunnel = f.units.tunnel;
  const processInfo = { pid: 7070, created: 'current-tunnel-process' };
  f.units.yca.running = true; f.units.yca.healthy = true;
  tunnel.start = async function() {
    this.running = true; this.healthy = false;
    m.state.units.tunnel.ownership.process = processInfo;
  };
  tunnel.observe = async function() {
    return { running: this.running, owned: this.owned, healthy: this.healthy,
      ...processInfo, code: this.healthy ? null : 'MCP_NOT_READY',
      controlPlane: { state: 'healthy' } };
  };
  await assert.rejects(m.action('tunnel', 'start'), { code: 'STARTUP_TIMEOUT' });
  assert.equal(m.snapshot().units.tunnel.blocked, 'STARTUP_TIMEOUT');
  tunnel.healthy = true;
  const restarted = new Supervisor(f.options);
  await restarted.observe();
  assert.equal(restarted.snapshot().units.tunnel.blocked, null);
  assert.equal(JSON.parse(readFileSync(f.options.stateFile, 'utf8')).units.tunnel.blocked, null);
  restarted.state.units.tunnel.blocked = 'AUTH_REQUIRED'; restarted.persist();
  await restarted.observe();
  assert.equal(restarted.snapshot().units.tunnel.blocked, 'AUTH_REQUIRED');
});

test('tunnel startup timeout stays blocked without healthy ownership of the same process', async t => {
  const { manager: m, units: u } = setup(t);
  Object.assign(m.state.units.tunnel, { desired: 'running', blocked: 'STARTUP_TIMEOUT' });
  m.state.units.tunnel.ownership.process = { pid: 7070, created: 'current-tunnel-process' };
  const good = { running: true, owned: true, healthy: true,
    pid: 7070, created: 'current-tunnel-process', code: null };
  for (const bad of [
    { running: false }, { owned: false }, { healthy: false, code: 'MCP_NOT_READY' },
    { pid: 7071 }, { created: 'different-process' }, { code: 'AUTH_REQUIRED' },
  ]) {
    u.tunnel.observe = async () => ({ ...good, ...bad });
    await m.observe();
    assert.equal(m.state.units.tunnel.blocked, 'STARTUP_TIMEOUT');
  }
});

test('bounded retries survive supervisor restart; no retries after stop', async t => {
  const f = setup(t); let m = f.manager; const u = f.units;
  await m.action('all', 'start'); await m.setRecovery(true);
  u.yca.running = false; u.yca.healthy = false; u.yca.failure = 'SPAWN_FAILED';
  for (let attempt = 0; attempt < 5; attempt++) {
    await m.tick();
    for (let step = 0; step < 7; step++) { f.advance(5000); await m.tick(); if (m.state.units.yca.attempts.length > attempt) break; }
    m = new Supervisor(f.options);
  }
  await m.tick();
  assert.equal(m.state.units.yca.attempts.length, 5);
  assert.equal(m.state.units.yca.blocked, 'RECOVERY_BUDGET_EXHAUSTED');
  assert.equal(u.tunnel.starts, 1); assert.equal(u.tunnel.stops, 0);
  await m.action('all', 'stop'); f.advance(60_000); await m.tick(); assert.equal(u.yca.starts, 6);
});

test('network/auth degradation never restarts a live tunnel or healthy YCA', async t => {
  const f = setup(t); await f.manager.action('all', 'start'); await f.manager.setRecovery(true);
  f.units.tunnel.healthy = false;
  for (let i = 0; i < 20; i++) { f.advance(5000); await f.manager.tick(); }
  assert.equal(f.units.tunnel.starts, 1); assert.equal(f.units.tunnel.stops, 0); assert.equal(f.units.yca.starts, 1);
});

test('long check gap expires evidence and then advances recovery', async t => {
  const f = setup(t); await f.manager.action('all', 'start'); await f.manager.setRecovery(true);
  f.units.yca.running = false; f.units.yca.healthy = false;
  f.advance(120_000); assert.equal(f.manager.snapshot().units.yca.status, '未知');
  await f.manager.tick(); assert.equal(f.manager.state.units.yca.attempts.length, 0);
  assert.ok(f.manager.state.units.yca.nextAt);
  f.advance(5000); await f.manager.tick();
  assert.equal(f.units.yca.starts, 2);
});

test('v1 recovery policy migrates once and a later explicit disable remains durable', async t => {
  const f = setup(t);
  f.manager.state.version = 1; f.manager.state.autoRecovery = false; f.manager.persist();
  const migrated = new Supervisor(f.options);
  assert.equal(migrated.state.version, 2);
  assert.equal(migrated.state.autoRecovery, true);
  await migrated.setRecovery(false);
  assert.equal(new Supervisor(f.options).state.autoRecovery, false);
});

test('a verified self-recovery clears exhausted YCA budget and releases the tunnel', async t => {
  const f = setup(t), { manager: m, units: u } = f;
  const commit = 'a'.repeat(40), tools = { count: 1, sha256: 'b'.repeat(64) };
  Object.assign(m.state.units.yca, { desired: 'running', blocked: 'RECOVERY_BUDGET_EXHAUSTED',
    attempts: [1, 2, 3, 4, 5], lastFailure: 'HEALTH_FAILED' });
  Object.assign(m.state.units.yca.ownership, { instance: 'same-instance', process: { pid: 42, created: 'same-process' },
    deployment: { commit, tools } });
  m.state.units.tunnel.desired = 'running'; m.state.units.tunnel.blocked = 'YCA_RECOVERY_FAILED'; m.persist();
  u.yca.observe = async () => ({ running: true, owned: true, authenticated: true, healthy: true, code: null,
    instance: 'same-instance', pid: 42, created: 'same-process', activity: { codex: 0, computer: 0, requests: 0 },
    deployment: { state: 'verified', running: { commit, dirty: false } }, tools });
  await m.tick();
  assert.equal(m.snapshot().units.yca.blocked, null);
  assert.equal(m.snapshot().units.tunnel.blocked, null);
  assert.equal(m.snapshot().units.tunnel.nextAt !== null, true);
  f.advance(2000); await m.tick();
  assert.equal(u.tunnel.starts, 1);
});

test('continuous local health failure requires authenticated idle activity', async t => {
  const f = setup(t); await f.manager.action('all', 'start'); await f.manager.setRecovery(true);
  f.units.yca.healthy = false; f.units.yca.activity = null;
  for (let i = 0; i < 4; i++) { f.advance(5000); await f.manager.tick(); }
  assert.equal(f.units.yca.stops, 0); assert.equal(f.manager.state.units.yca.blocked, 'ACTIVITY_UNKNOWN_OR_BUSY');
});

test('missing executable pauses retries and observation mode rejects mutations', async t => {
  const f = setup(t); f.units.yca.failure = 'PATH_MISSING';
  await assert.rejects(f.manager.action('all', 'start'), { code: 'PATH_MISSING' });
  await f.manager.setRecovery(true); await f.manager.tick(); assert.equal(f.units.yca.starts, 1);
  const observing = new Supervisor({ ...f.options, observeOnly: true });
  await assert.rejects(observing.action('all', 'stop'), { code: 'DEPLOYMENT_CONFIRMATION_REQUIRED' });
});

test('readiness content, stale proxy evidence, auth and missing components stay distinct', () => {
  const at = Date.now(), health = { status: 200, body: 'live' };
  const auth = tunnelHealth(health, { status: 200, body: 'ready (mcp initialize requires auth: denied)' }, {}, at);
  assert.equal(auth.code, 'AUTH_REQUIRED'); assert.equal(auth.healthy, false);
  const delayed = { status: 200, body: 'ready (mcp startup probe timed out: mcp probe timed out after 2s: context deadline exceeded)' };
  assert.equal(tunnelHealth(health, delayed, {}, at).healthy, true);
  const authFailure = tunnelHealth(health, { status: 200, body: 'ready (mcp startup probe timed out: authentication failed)' }, {}, at);
  assert.equal(authFailure.healthy, false); assert.equal(authFailure.ready, false);
  assert.equal(authFailure.code, 'MCP_NOT_READY');
  assert.equal(tunnelHealth(health, { status: 200, body: 'ready (mcp startup probe timed out: unrelated warning)' }, {}, at).healthy, false);
  assert.equal(tunnelHealth(health, { ...delayed, status: 503 }, {}, at).healthy, false);
  assert.equal(tunnelHealth(health, { status: 200, body: 'ready-ish' }, {}, at).healthy, false);
  assert.equal(tunnelHealth(health, { status: 200, body: 'ready (unexpected warning)' }, {}, at).healthy, false);
  assert.equal(tunnelHealth(health, { status: 200, body: 'ready (mcp startup probe timed out: requires auth)' }, {}, at).healthy, false);
  const ready = { status: 200, body: 'ready' };
  assert.equal(tunnelHealth(health, ready, {}, at).controlPlane.state, 'unknown');
  const system = { proxy_health: [{ route: { kind: 'control_plane' }, health_state: 'unhealthy', last_check: new Date(at).toISOString() }] };
  assert.equal(tunnelHealth(health, ready, system, at).controlPlane.state, 'unhealthy');
  assert.equal(tunnelHealth(health, ready, system, at + 180_000).controlPlane.state, 'unknown');
});

test('single state directory cannot be used by a second control port', t => {
  const { root } = setup(t); claimStateDirectory(root, 7392, 'fixed'); claimStateDirectory(root, 7392, 'fixed');
  assert.throws(() => claimStateDirectory(root, 7394, 'other'), { code: 'STATE_BINDING_CONFLICT' });
  assert.equal(JSON.parse(readFileSync(path.join(root, 'binding.json'))).port, 7392);
});

test('prepared release stays pending across ordinary restart and switches only through update-restart', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  const firstTools = { count: 14, sha256: '1'.repeat(64) }, secondTools = { count: 18, sha256: '2'.repeat(64) };
  u.running = true; u.healthy = true; u.commit = first; u.target = first; u.tools = firstTools;
  m.state.units.yca.ownership.deployment = { commit: first, tools: firstTools };
  m.state.units.yca.ownership.instance = 'first-instance';
  m.state.units.yca.ownership.process = { pid: 100, created: 'first-process' };
  u.pid = 100; u.created = 'first-process'; u.instance = 'first-instance';
  u.observe = async function() {
    return { running: this.running, healthy: this.healthy, owned: true, authenticated: true,
      instance: this.instance, pid: this.pid, created: this.created, activity: this.activity,
      deployment: { running: this.running ? { commit: this.commit, dirty: false } : null, target: { commit: this.target },
        launched: m.state.units.yca.ownership.deployment, state: this.running && this.commit === this.target ? 'verified' : 'update-pending' },
      tools: this.running ? this.tools : null, controlPlane: { state: 'healthy' } };
  };
  const starts = [];
  u.start = async function(input = {}) {
    starts.push({ ...input }); this.running = true; this.healthy = true;
    this.commit = input.commit ?? this.target;
    this.tools = this.commit === second ? secondTools : firstTools;
    m.state.units.yca.ownership.deployment = { commit: this.commit, tools: this.tools };
    this.pid++; this.created = `process-${this.pid}`; this.instance = input.instance ?? 'restart-instance';
    m.state.units.yca.ownership.instance = this.instance;
    m.state.units.yca.ownership.process = { pid: this.pid, created: this.created };
  };
  u.stop = async function() { this.stops++; this.running = false; this.healthy = false; };
  const prepare = async () => { u.target = second; return { commit: second, branch: 'merged', tools: secondTools }; };

  await m.observe();
  await m.updateDeployment(prepare, { restart: false });
  let snapshot = m.snapshot();
  assert.equal(snapshot.units.yca.deployment.running.commit, first);
  assert.equal(snapshot.units.yca.deployment.target.commit, second);
  assert.equal(snapshot.units.yca.deployment.restartRequired, true);
  assert.equal(snapshot.tools.running.sha256, firstTools.sha256, 'preparing must not advertise candidate tools as running');

  await m.action('yca', 'restart');
  snapshot = m.snapshot();
  assert.equal(starts.at(-1).commit, first, 'ordinary restart must pin the currently running release');
  assert.equal(snapshot.units.yca.deployment.running.commit, first);
  assert.equal(snapshot.tools.running.sha256, firstTools.sha256);

  const operation = { operationId: '66666666-6666-4666-8666-666666666666', action: 'update-and-restart', target: 'yca' };
  await m.updateDeployment(prepare, { restart: true, operation });
  snapshot = m.snapshot();
  assert.equal(starts.at(-1).commit, second);
  assert.equal(snapshot.units.yca.deployment.running.commit, second);
  assert.equal(snapshot.units.yca.deployment.restartRequired, false);
  assert.equal(snapshot.tools.running.sha256, secondTools.sha256);
  assert.deepEqual(snapshot.events.filter(event => event.operation_id === operation.operationId).map(event => event.outcome), ['requested', 'succeeded']);
});

test('update-restart rechecks activity after prepare and leaves current release running when work appears', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const first = 'a'.repeat(40), second = 'b'.repeat(40), tools = { count: 14, sha256: '3'.repeat(64) };
  u.running = true; u.healthy = true; u.commit = first; u.target = first; u.tools = tools;
  m.state.units.yca.ownership.deployment = { commit: first, tools };
  u.observe = async function() { return { running: this.running, healthy: this.healthy, owned: true, activity: this.activity,
    deployment: { running: this.running ? { commit: this.commit } : null, target: { commit: this.target }, launched: m.state.units.yca.ownership.deployment, state: 'update-pending' },
    tools: this.running ? this.tools : null, controlPlane: { state: 'healthy' } }; };
  let stopped = false; u.stop = async function() { stopped = true; this.running = false; this.healthy = false; };
  await m.observe();
  const prepare = async () => { u.target = second; u.activity.computer = 1; return { commit: second, branch: 'merged', tools: { count: 18, sha256: '4'.repeat(64) } }; };
  await assert.rejects(m.updateDeployment(prepare, { restart: true }), { code: 'ACTIVE_TASKS' });
  const snapshot = m.snapshot();
  assert.equal(stopped, false);
  assert.equal(snapshot.units.yca.deployment.running.commit, first);
  assert.equal(snapshot.units.yca.deployment.target.commit, second);
  assert.equal(snapshot.tools.running.sha256, tools.sha256);
});
test('failed candidate start restores the captured previous release', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  const firstTools = { count: 14, sha256: '5'.repeat(64) }, secondTools = { count: 18, sha256: '6'.repeat(64) };
  u.running = true; u.healthy = true; u.commit = first; u.target = first; u.tools = firstTools;
  m.state.units.yca.ownership.deployment = { commit: first, tools: firstTools };
  u.observe = async function() { return { running: this.running, healthy: this.healthy, owned: true, activity: this.activity,
    deployment: { running: this.running ? { commit: this.commit } : null, target: { commit: this.target }, launched: m.state.units.yca.ownership.deployment, state: this.running && this.commit === this.target ? 'verified' : 'update-pending' },
    tools: this.running ? this.tools : null, controlPlane: { state: 'healthy' } }; };
  const starts = [];
  u.start = async function(input = {}) {
    starts.push(input.commit ?? null);
    if (input.commit === second) throw fail('SPAWN_FAILED');
    this.running = true; this.healthy = true; this.commit = input.commit ?? this.target; this.tools = firstTools;
    m.state.units.yca.ownership.deployment = { commit: this.commit, tools: this.tools };
  };
  u.stop = async function() { this.stops++; this.running = false; this.healthy = false; };
  await m.observe();
  const prepare = async () => { u.target = second; return { commit: second, branch: 'merged', tools: secondTools }; };
  await assert.rejects(m.updateDeployment(prepare, { restart: true }), { code: 'SPAWN_FAILED' });
  const snapshot = m.snapshot();
  assert.deepEqual(starts, [second, first]);
  assert.equal(snapshot.units.yca.deployment.running.commit, first);
  assert.equal(snapshot.units.yca.deployment.target.commit, second);
  assert.equal(snapshot.tools.running.sha256, firstTools.sha256);
});
test('failed remote check keeps the previous result only as stale evidence', async t => {
  const { manager: m, units: u } = setup(t);
  u.yca.observe = async function() { return { running: false, owned: false, healthy: false, activity: this.activity,
    deployment: { target: { commit: 'a'.repeat(40) }, state: 'stopped' } }; };
  await m.checkDeployment(async () => ({ branch: 'merged', commit: 'a'.repeat(40) }));
  assert.equal(m.snapshot().units.yca.deployment.remoteDiffers, false);
  await assert.rejects(m.checkDeployment(async () => { throw fail('DEPLOYMENT_GIT_FAILED'); }), { code: 'DEPLOYMENT_GIT_FAILED' });
  const deployment = m.snapshot().units.yca.deployment;
  assert.equal(deployment.latest.commit, 'a'.repeat(40));
  assert.equal(deployment.latest.stale, true);
  assert.equal(deployment.latest.error, 'DEPLOYMENT_GIT_FAILED');
  assert.equal(deployment.remoteDiffers, null, 'stale remote evidence must not be presented as current equality');
});
test('pre-switch release change rejects update without rolling the new owner back to the old release', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const first = 'a'.repeat(40), second = 'b'.repeat(40), concurrent = 'c'.repeat(40);
  const firstTools = { count: 14, sha256: '7'.repeat(64) }, concurrentTools = { count: 16, sha256: '8'.repeat(64) };
  u.running = true; u.healthy = true; u.owned = true; u.commit = first; u.target = first; u.tools = firstTools; u.pid = 101; u.created = 'first-process';
  m.state.units.yca.ownership.deployment = { commit: first, tools: firstTools };
  u.observe = async function() { return { running: this.running, healthy: this.healthy, owned: this.owned, activity: this.activity,
    pid: this.pid, created: this.created,
    deployment: { running: this.running ? { commit: this.commit } : null, target: { commit: this.target }, launched: m.state.units.yca.ownership.deployment, state: 'update-pending' },
    tools: this.running ? this.tools : null, controlPlane: { state: 'healthy' } }; };
  let stopped = 0; const starts = [];
  u.stop = async function() { stopped++; this.running = false; this.healthy = false; };
  u.start = async function(input = {}) { starts.push(input.commit ?? null); this.running = true; this.commit = input.commit ?? this.target; };
  await m.observe();
  const prepare = async () => {
    u.target = second;
    u.commit = concurrent; u.tools = concurrentTools; u.pid = 202; u.created = 'concurrent-process';
    m.state.units.yca.ownership.deployment = { commit: concurrent, tools: concurrentTools };
    return { commit: second, branch: 'merged', tools: { count: 18, sha256: '9'.repeat(64) } };
  };
  await assert.rejects(m.updateDeployment(prepare, { restart: true }), { code: 'DEPLOYMENT_CURRENT_CHANGED' });
  const snapshot = m.snapshot();
  assert.equal(stopped, 0); assert.deepEqual(starts, []);
  assert.equal(snapshot.units.yca.deployment.running.commit, concurrent);
});

test('pre-switch ownership loss rejects update without any rollback stop or start', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const first = 'a'.repeat(40), second = 'b'.repeat(40), tools = { count: 14, sha256: 'a'.repeat(64) };
  u.running = true; u.healthy = true; u.owned = true; u.commit = first; u.target = first; u.tools = tools; u.pid = 303; u.created = 'owned-process';
  m.state.units.yca.ownership.deployment = { commit: first, tools };
  u.observe = async function() { return { running: this.running, healthy: this.healthy, owned: this.owned, activity: this.activity,
    pid: this.pid, created: this.created,
    deployment: { running: this.running ? { commit: this.commit } : null, target: { commit: this.target }, launched: m.state.units.yca.ownership.deployment, state: 'update-pending' },
    tools: this.running ? this.tools : null, controlPlane: { state: 'healthy' } }; };
  let stopped = 0; const starts = [];
  u.stop = async function() { stopped++; this.running = false; };
  u.start = async function(input = {}) { starts.push(input.commit ?? null); };
  await m.observe();
  const prepare = async () => { u.target = second; u.owned = false; return { commit: second, branch: 'merged', tools: { count: 18, sha256: 'b'.repeat(64) } }; };
  await assert.rejects(m.updateDeployment(prepare, { restart: true }), { code: 'OBSERVED_UNOWNED' });
  assert.equal(stopped, 0); assert.deepEqual(starts, []); assert.equal(u.running, true);
});
test('rollback refuses to stop a concurrent non-candidate process after the old release was stopped', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const first = 'a'.repeat(40), second = 'b'.repeat(40), concurrent = 'c'.repeat(40);
  const firstTools = { count: 14, sha256: 'c'.repeat(64) }, secondTools = { count: 18, sha256: 'd'.repeat(64) }, concurrentTools = { count: 16, sha256: 'e'.repeat(64) };
  u.running = true; u.healthy = true; u.owned = true; u.commit = first; u.target = first; u.tools = firstTools; u.pid = 404; u.created = 'old-process';
  m.state.units.yca.ownership.deployment = { commit: first, tools: firstTools };
  u.observe = async function() { return { running: this.running, healthy: this.healthy, owned: this.owned, activity: this.activity,
    pid: this.pid, created: this.created,
    deployment: { running: this.running ? { commit: this.commit } : null, target: { commit: this.target }, launched: m.state.units.yca.ownership.deployment, state: 'update-pending' },
    tools: this.running ? this.tools : null, controlPlane: { state: 'healthy' } }; };
  let stops = 0; const starts = [];
  u.stop = async function() { stops++; this.running = false; this.healthy = false; };
  u.start = async function(input = {}) {
    starts.push(input.commit ?? null);
    if (input.commit === second) {
      this.running = true; this.healthy = true; this.owned = true; this.commit = concurrent; this.tools = concurrentTools; this.pid = 505; this.created = 'concurrent-process';
      m.state.units.yca.ownership.deployment = { commit: concurrent, tools: concurrentTools };
      throw fail('SPAWN_FAILED');
    }
  };
  await m.observe();
  const prepare = async () => { u.target = second; return { commit: second, branch: 'merged', tools: secondTools }; };
  await assert.rejects(m.updateDeployment(prepare, { restart: true }), { code: 'DEPLOYMENT_ROLLBACK_CONFLICT' });
  assert.equal(stops, 1, 'only the captured old release may have been stopped');
  assert.deepEqual(starts, [second]);
  assert.equal(u.running, true); assert.equal(u.commit, concurrent);
});
test('rollback does not stop an externally replaced process even when it runs the same candidate commit', async t => {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  const firstTools = { count: 14, sha256: 'f'.repeat(64) }, secondTools = { count: 18, sha256: '0'.repeat(64) };
  u.running = true; u.healthy = true; u.owned = true; u.commit = first; u.target = first; u.tools = firstTools; u.pid = 606; u.created = 'old-process';
  m.state.units.yca.ownership.deployment = { commit: first, tools: firstTools };
  m.state.units.yca.ownership.instance = 'old-instance';
  u.observe = async function() { return { running: this.running, healthy: this.healthy, owned: this.owned, activity: this.activity,
    pid: this.pid, created: this.created,
    deployment: { running: this.running ? { commit: this.commit } : null, target: { commit: this.target }, launched: m.state.units.yca.ownership.deployment, state: 'update-pending' },
    tools: this.running ? this.tools : null, controlPlane: { state: 'healthy' } }; };
  let stops = 0; const starts = [];
  u.stop = async function() { stops++; this.running = false; this.healthy = false; };
  u.start = async function(input = {}) {
    starts.push({ commit: input.commit ?? null, instance: input.instance ?? null });
    if (input.commit === second) {
      this.running = true; this.healthy = true; this.owned = true; this.commit = second; this.tools = secondTools; this.pid = 707; this.created = 'external-same-commit';
      m.state.units.yca.ownership.deployment = { commit: second, tools: secondTools };
      m.state.units.yca.ownership.instance = 'external-instance';
      throw fail('SPAWN_FAILED');
    }
  };
  await m.observe();
  const prepare = async () => { u.target = second; return { commit: second, branch: 'merged', tools: secondTools }; };
  await assert.rejects(m.updateDeployment(prepare, { restart: true }), { code: 'DEPLOYMENT_ROLLBACK_CONFLICT' });
  assert.equal(stops, 1, 'rollback must not stop the replacement B');
  assert.equal(starts.length, 1); assert.equal(starts[0].commit, second); assert.ok(starts[0].instance);
  assert.equal(u.running, true); assert.equal(u.commit, second); assert.equal(m.state.units.yca.ownership.instance, 'external-instance');
});

function switchFixture(t) {
  const f = setup(t), m = f.manager, u = f.units.yca;
  const old = 'a'.repeat(40), next = 'b'.repeat(40);
  const oldTools = { count: 14, sha256: '1'.repeat(64) }, nextTools = { count: 18, sha256: '2'.repeat(64) };
  Object.assign(u, { running: true, healthy: true, owned: true, commit: old, tools: oldTools,
    pid: 101, created: 'old-process', instance: 'old-instance', activity: { codex: 0, computer: 0, requests: 0 } });
  Object.assign(m.state.units.yca.ownership, { instance: u.instance, process: { pid: u.pid, created: u.created, matches: true }, deployment: { commit: old, tools: oldTools } });
  u.observe = async function() { return { running: this.running, healthy: this.healthy, owned: this.owned,
    authenticated: this.authenticated ?? this.owned, instance: this.authenticated === false ? null : this.instance,
    pid: this.pid, created: this.created, activity: this.activity,
    deployment: { running: this.running && this.authenticated !== false ? { commit: this.commit, dirty: false } : null,
      state: this.running ? 'verified' : 'stopped' }, tools: this.authenticated === false ? null : this.tools,
    code: this.code }; };
  u.stop = async function() { this.stops++; this.running = false; this.healthy = false; };
  u.start = async function(input) {
    this.starts++; this.running = true; this.healthy = true; this.commit = input.commit; this.tools = input.commit === next ? nextTools : oldTools;
    this.pid++; this.created = `process-${this.pid}`; this.instance = input.instance ?? 'restored-instance';
    Object.assign(m.state.units.yca.ownership, { instance: this.instance,
      process: { pid: this.pid, created: this.created, matches: true }, deployment: { commit: this.commit, tools: this.tools } });
  };
  return { f, m, u, old, next, oldTools, nextTools, prepare: async () => ({ commit: next, branch: 'main', tools: nextTools }) };
}

test('candidate observation gap recovers within the existing startup window', async t => {
  const x = switchFixture(t), { m, u } = x;
  m.startupMs = 1000;
  const observe = u.observe.bind(u); let gaps = 0;
  u.observe = async function() {
    const o = await observe();
    if (this.commit === x.next && gaps++ < 2) return { ...o, owned: false, authenticated: false, instance: null,
      healthy: false, activity: null, tools: null, code: 'ACTIVITY_UNKNOWN' };
    return o;
  };
  const operation = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'update-and-restart', target: 'yca' };
  await m.updateDeployment(x.prepare, { restart: true, operation });
  assert.equal(u.stops, 1); assert.equal(u.commit, x.next);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'succeeded']);
});

test('update-and-restart cannot succeed when candidate health fails its confirmation probe', async t => {
  const x = switchFixture(t), { m, u } = x;
  const observe = u.observe.bind(u); let candidateChecks = 0;
  u.observe = async function() {
    const o = await observe();
    if (this.commit === x.next && ++candidateChecks >= 3) return { ...o, healthy: false, code: 'HEALTH_FAILED' };
    return o;
  };
  const operation = { operationId: 'a1111111-1111-4111-8111-111111111111', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(x.prepare, { restart: true, operation }), { code: 'DEPLOYMENT_SWITCH_UNVERIFIED' });
  assert.equal(u.commit, x.old);
  assert.equal(u.stops, 2);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'failed']);
});

test('candidate verified during rollback recheck stays running and succeeds', async t => {
  const x = switchFixture(t), { m, u } = x;
  m.startupMs = 0;
  const observe = u.observe.bind(u); let gaps = 0;
  u.observe = async function() {
    const o = await observe();
    if (this.commit === x.next && gaps++ === 0) return { ...o, healthy: false, code: 'ACTIVITY_UNKNOWN', activity: null };
    return o;
  };
  const operation = { operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', action: 'update-and-restart', target: 'yca' };
  await m.updateDeployment(x.prepare, { restart: true, operation });
  assert.equal(u.stops, 1); assert.equal(u.commit, x.next);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'succeeded']);
});

test('rollback recheck cannot turn a single healthy candidate sample into success', async t => {
  const x = switchFixture(t), { m, u } = x;
  m.startupMs = 0;
  const observe = u.observe.bind(u); let checks = 0;
  u.observe = async function() {
    const o = await observe();
    if (this.commit !== x.next) return o;
    checks++;
    if (checks <= 2) return { ...o, healthy: false, code: 'HEALTH_FAILED' };
    if (checks === 4) return { ...o, healthy: false, code: 'HEALTH_FAILED' };
    return o;
  };
  const operation = { operationId: 'b1111111-1111-4111-8111-111111111111', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(x.prepare, { restart: true, operation }), { code: 'STARTUP_TIMEOUT' });
  assert.equal(u.commit, x.old);
  assert.equal(u.stops, 2);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'failed']);
});

test('unknown candidate evidence leaves requested-only and never stops it', async t => {
  const x = switchFixture(t), { m, u } = x;
  m.startupMs = 0;
  const observe = u.observe.bind(u);
  u.observe = async function() {
    const o = await observe();
    return this.commit === x.next ? { ...o, owned: false, authenticated: false, instance: null,
      healthy: false, activity: null, tools: null, code: 'OBSERVED_UNOWNED' } : o;
  };
  const operation = { operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(x.prepare, { restart: true, operation }), e => e.operationOutcome === 'unknown');
  assert.equal(u.stops, 1); assert.equal(u.commit, x.next);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested']);
});

test('accepted old stop with unknown outcome keeps a requested-only receipt', async t => {
  const x = switchFixture(t), { m, u } = x;
  u.stop = async function() { this.stops++; this.running = null; throw fail('STOP_TIMEOUT'); };
  const operation = { operationId: '11111111-1111-4111-8111-111111111111', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(x.prepare, { restart: true, operation }), e => e.operationOutcome === 'unknown');
  assert.equal(u.stops, 1); assert.equal(u.starts, 0);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested']);
});

test('accepted old stop that then errors restores the verified previous release', async t => {
  const x = switchFixture(t), { m, u } = x;
  u.stop = async function() { this.stops++; this.running = false; this.healthy = false; throw fail('STOP_TIMEOUT'); };
  const operation = { operationId: '22222222-2222-4222-8222-222222222222', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(x.prepare, { restart: true, operation }), { code: 'STOP_TIMEOUT' });
  assert.equal(u.stops, 1); assert.equal(u.starts, 1); assert.equal(u.commit, x.old); assert.equal(u.healthy, true);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'failed']);
});

test('rejected old stop leaves the verified previous release untouched', async t => {
  const x = switchFixture(t), { m, u } = x;
  u.stop = async function() { this.stops++; throw fail('STOP_REJECTED'); };
  const operation = { operationId: '33333333-3333-4333-8333-333333333333', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(x.prepare, { restart: true, operation }), { code: 'STOP_REJECTED' });
  assert.equal(u.stops, 1); assert.equal(u.starts, 0); assert.equal(u.running, true); assert.equal(u.commit, x.old);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'failed']);
});

test('known startup identity conflict does not wait for diagnostics', async t => {
  const { manager: m, units } = setup(t);
  m.startupMs = 1000;
  units.yca.start = async () => { m.state.units.yca.ownership.instance = 'new-instance';
    m.state.units.yca.ownership.process = { pid: 123, created: 'original' }; };
  units.yca.observe = async () => ({ running: true, healthy: false, authenticated: false,
    code: 'OWNERSHIP_CHANGED' });
  await assert.rejects(m.startOne('yca'), { code: 'OWNERSHIP_CHANGED' });
});

test('authenticated candidate with wrong tools and idle activity is stopped before restoring A', async t => {
  const x = switchFixture(t), { m, u } = x;
  const start = u.start.bind(u);
  u.start = async function(input) {
    await start(input);
    if (input.commit === x.next) { this.healthy = false; this.tools = { count: 18, sha256: '9'.repeat(64) }; this.code = 'DEPLOYMENT_UNVERIFIED'; }
    else this.code = null;
  };
  const operation = { operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', action: 'update-and-restart', target: 'yca' };
  await assert.rejects(m.updateDeployment(x.prepare, { restart: true, operation }), { code: 'DEPLOYMENT_UNVERIFIED' });
  assert.equal(u.stops, 2); assert.equal(u.commit, x.old); assert.equal(u.healthy, true);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'failed']);
});

test('verified switch ignores noncritical reporting failure and terminal failure stays unknown', async t => {
  const x = switchFixture(t), { m, u } = x;
  const add = m.events.add.bind(m.events);
  m.events.add = (...args) => { if (args[1] === 'deployment-switched') throw fail('EVENT_WRITE_FAILED'); add(...args); };
  const operation = { operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', action: 'update-and-restart', target: 'yca' };
  await m.updateDeployment(x.prepare, { restart: true, operation });
  assert.equal(u.stops, 1); assert.equal(u.commit, x.next);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'succeeded']);
  const y = switchFixture(t);
  const addOperation = y.m.events.addOperation.bind(y.m.events);
  y.m.events.addOperation = (...args) => { if (args[3] === 'succeeded') throw fail('EVENT_WRITE_FAILED'); addOperation(...args); };
  await assert.rejects(y.m.updateDeployment(y.prepare, { restart: true, operation: {
    operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', action: 'update-and-restart', target: 'yca' } }), e => e.operationOutcome === 'unknown');
  assert.equal(y.u.stops, 1); assert.equal(y.u.commit, y.next);
});
