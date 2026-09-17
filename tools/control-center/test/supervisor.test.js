import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor } from '../src/supervisor.js';
import { Events, fail, claimStateDirectory } from '../src/common.js';
import { tunnelHealth } from '../src/units.js';

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-test-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-test-'))); rmSync(root, { recursive: true, force: true }); });
  let time = Date.now();
  const units = Object.fromEntries(['yca', 'tunnel'].map(id => [id, {
    running: false, healthy: false, owned: true, activity: { codex: 0, computer: 0, requests: 0 }, starts: 0, stops: 0,
    async observe() { return { running: this.running, healthy: this.healthy, owned: this.owned, activity: this.activity, controlPlane: { state: 'healthy' } }; },
    async start() { this.starts++; if (this.failure) throw fail(this.failure); this.running = true; this.healthy = true; },
    async stop() { this.stops++; this.running = false; this.healthy = false; },
  }]));
  const options = { stateFile: path.join(root, 'state.json'), events: new Events(root), clock: () => time, createUnits: () => units, startupMs: 0 };
  const manager = new Supervisor(options);
  return { manager, units, options, root, advance: ms => { time += ms; } };
}

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
  await f.manager.action('yca', 'start'); assert.equal(options.recovery, false);
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
