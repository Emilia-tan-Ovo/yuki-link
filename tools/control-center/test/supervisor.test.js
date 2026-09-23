import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor } from '../src/supervisor.js';
import { Events, fail, claimStateDirectory } from '../src/common.js';
import { tunnelHealth } from '../src/units.js';
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
  assert.equal(restarted.state.autoRecovery, false);
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

test('activity protection runs before dependent stops; unknown is not idle', async t => {
  const { manager: m, units: u } = setup(t);
  await m.action('all', 'start'); u.yca.activity.computer = 1;
  await assert.rejects(m.action('all', 'restart'), { code: 'ACTIVE_TASKS' });
  assert.equal(u.tunnel.stops, 0); assert.equal(u.yca.stops, 0);
  assert.equal(m.state.units.yca.desired, 'stopped');
  u.yca.activity = null;
  await assert.rejects(m.action('tunnel', 'stop'), { code: 'ACTIVITY_UNKNOWN' });
  await m.action('all', 'stop', true); assert.equal(u.tunnel.stops, 1);
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

test('long check gap expires evidence, resets health strikes and gives recovery grace', async t => {
  const f = setup(t); await f.manager.action('all', 'start'); await f.manager.setRecovery(true);
  f.units.yca.running = false; f.units.yca.healthy = false;
  f.advance(120_000); assert.equal(f.manager.snapshot().units.yca.status, '未知');
  await f.manager.tick(); assert.equal(f.manager.state.units.yca.attempts.length, 0);
  for (let i = 0; i < 5; i++) { f.advance(5000); await f.manager.tick(); }
  assert.equal(f.units.yca.starts, 1);
  f.advance(5000); await f.manager.tick(); f.advance(5000); await f.manager.tick(); assert.equal(f.units.yca.starts, 2);
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
  assert.equal(tunnelHealth(health, { status: 200, body: 'ready (mcp initialize requires auth: denied)' }, {}, at).code, 'AUTH_REQUIRED');
  assert.equal(tunnelHealth(health, { status: 200, body: 'ready (mcp startup probe timed out: timeout)' }, {}, at).healthy, false);
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
      healthy: false, activity: null, tools: null, code: 'OBSERVED_UNOWNED' };
    return o;
  };
  const operation = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'update-and-restart', target: 'yca' };
  await m.updateDeployment(x.prepare, { restart: true, operation });
  assert.equal(u.stops, 1); assert.equal(u.commit, x.next);
  assert.deepEqual(new Events(x.f.root).items.filter(e => e.operation_id === operation.operationId).map(e => e.outcome), ['requested', 'succeeded']);
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
