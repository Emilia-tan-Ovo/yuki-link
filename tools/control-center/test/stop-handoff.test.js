import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { YcaUnit } from '../src/units.js';
import { Supervisor } from '../src/supervisor.js';
import { Events } from '../src/common.js';

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yca-stop-handoff-'));
  const processInfo = { pid: 12345, created: '2026-09-29T00:00:00Z', matches: true };
  const tools = { count: 40, sha256: 'b'.repeat(64) }, commit = 'a'.repeat(40);
  const state = { process: { ...processInfo }, instance: 'same-instance', token: 'a'.repeat(64), deployment: { commit, tools } };
  let alive = true, inspects = 0, probes = 0, stops = 0, status = 202, dropProbe = false, dropStop = false;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') return res.end(JSON.stringify({ service: 'yuki-computer-agent', status: 'ok' }));
    if (req.url === '/status') {
      probes++;
      if (dropProbe) return req.socket.destroy();
      return res.end(JSON.stringify({ service: 'yuki-local-control', instance: state.instance, pid: processInfo.pid,
        source: { commit, dirty: false }, tools, active: { codex: 0, computer: 0, requests: 0 } }));
    }
    stops++;
    assert.equal(req.headers.authorization, 'Bearer ' + state.token);
    assert.equal(req.headers['x-confirm-impact'], 'yes');
    if (dropStop) return req.socket.destroy();
    res.statusCode = status;
    if (status === 202) alive = false;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); rmSync(root, { recursive: true, force: true }); });
  const unit = new YcaUnit({ node: process.execPath, entry: process.execPath, runtime: root,
    controlPort: server.address().port, port: server.address().port },
  { inspect: async () => { inspects++; return alive ? [{ ...processInfo }] : []; }, free: async () => {} }, state, () => {}, new Events(root));
  return { unit, state, root, processInfo, tools, commit,
    get inspects() { return inspects; }, get probes() { return probes; }, get stops() { return stops; },
    setAlive(value) { alive = value; }, failProbe() { dropProbe = true; },
    rejectStop(code) { status = code; }, loseStop() { dropStop = true; } };
}

test('confirmed stop uses a verified same-instance preflight despite the next diagnostic probe failing', async t => {
  const f = await fixture(t), expected = await f.unit.observe();
  assert.equal(expected.healthy, true);
  f.failProbe();
  await f.unit.stop(true, expected);
  assert.equal(f.probes, 1);
  assert.equal(f.stops, 1);
});

test('unknown handoff fails closed and records a failed stop receipt', async t => {
  const f = await fixture(t);
  const m = new Supervisor({ stateFile: path.join(f.root, 'state.json'), events: new Events(f.root),
    createUnits: () => ({ yca: f.unit, tunnel: { observe: async () => ({ running: false }) } }), startupMs: 0 });
  m.state.units.yca.ownership = f.state;
  const observe = f.unit.observe.bind(f.unit);
  let first = true;
  f.unit.observe = async () => {
    if (first) { first = false; return { running: null, code: 'ACTIVITY_UNKNOWN' }; }
    return observe();
  };
  const operation = { operationId: '22222222-2222-4222-8222-222222222222', action: 'stop', target: 'yca' };
  await assert.rejects(m.action('yca', 'stop', true, operation), { code: 'ACTIVITY_UNKNOWN' });
  assert.equal(f.stops, 0);
  assert.deepEqual(new Events(f.root).items.filter(e => e.operation_id).map(e => e.outcome), ['requested', 'failed']);
  assert.equal(m.state.units.yca.blocked, 'ACTIVITY_UNKNOWN');
});

test('stopped handoff confirms absence before returning', async t => {
  const f = await fixture(t);
  f.setAlive(false);
  const expected = await f.unit.observe();
  assert.equal(expected.running, false);
  const before = f.inspects;
  await f.unit.stop(true, expected);
  assert.equal(f.inspects, before + 1);
  assert.equal(f.stops, 0);
});

test('stale stopped handoff stops a newly observed same instance', async t => {
  const f = await fixture(t);
  f.setAlive(false);
  const expected = await f.unit.observe();
  assert.equal(expected.running, false);
  f.setAlive(true);
  await f.unit.stop(true, expected);
  assert.equal(f.stops, 1);
});

for (const change of ['pid', 'created', 'markers', 'instance', 'commit']) test(`stop handoff refuses changed ${change}`, async t => {
  const f = await fixture(t), expected = await f.unit.observe();
  if (change === 'pid') f.processInfo.pid++;
  if (change === 'created') f.processInfo.created = 'replacement';
  if (change === 'markers') f.processInfo.matches = false;
  if (change === 'instance') f.state.instance = 'replacement';
  if (change === 'commit') f.state.deployment.commit = 'c'.repeat(40);
  await assert.rejects(f.unit.stop(true, expected));
  assert.equal(f.stops, 0);
});

for (const status of [409, 403]) test(`stop handoff preserves endpoint rejection ${status}`, async t => {
  const f = await fixture(t), expected = await f.unit.observe();
  f.rejectStop(status);
  await assert.rejects(f.unit.stop(true, expected), { code: status === 409 ? 'ACTIVE_TASKS' : 'OBSERVED_UNOWNED' });
  assert.equal(f.stops, 1);
});

test('lost stop response is unknown, never a confirmed failure or stopped instance', async t => {
  const f = await fixture(t), expected = await f.unit.observe(); f.loseStop();
  await assert.rejects(f.unit.stop(true, expected), { operationOutcome: 'unknown', code: 'STOP_OUTCOME_UNKNOWN' });
});

test('unexpected stop response cannot prove that no stop was accepted', async t => {
  const f = await fixture(t), expected = await f.unit.observe(); f.rejectStop(500);
  await assert.rejects(f.unit.stop(true, expected), { operationOutcome: 'unknown', code: 'STOP_OUTCOME_UNKNOWN' });
});

test('unconfirmed stop still needs current activity; a handoff never bypasses it', async t => {
  const f = await fixture(t), expected = await f.unit.observe(); f.failProbe();
  await assert.rejects(f.unit.stop(false, expected), { code: 'ACTIVITY_UNKNOWN' });
  assert.equal(f.stops, 0);
});

test('unknown stop outcome survives Control Center restart as a correlated receipt', async t => {
  const f = await fixture(t); f.loseStop();
  const m = new Supervisor({ stateFile: path.join(f.root, 'state.json'), events: new Events(f.root),
    createUnits: () => ({ yca: f.unit, tunnel: { observe: async () => ({ running: false }) } }), startupMs: 0 });
  m.state.units.yca.ownership = f.state;
  const operation = { operationId: '11111111-1111-4111-8111-111111111111', action: 'stop', target: 'yca' };
  await assert.rejects(m.action('yca', 'stop', true, operation), { operationOutcome: 'unknown' });
  assert.deepEqual(new Events(f.root).items.filter(e => e.operation_id).map(e => e.outcome), ['requested', 'unknown']);
  assert.equal((await f.unit.observe()).lastStop.code, 'STOP_OUTCOME_UNKNOWN');
});

test('update passes its immediately verified preflight into the real stop adapter', async t => {
  const f = await fixture(t);
  const tunnel = { observe: async () => ({ running: false, healthy: false }) };
  const m = new Supervisor({ stateFile: path.join(f.root, 'state.json'), events: new Events(f.root),
    createUnits: () => ({ yca: f.unit, tunnel }), startupMs: 0 });
  m.state.units.yca.ownership = f.state;
  const observe = f.unit.observe.bind(f.unit);
  f.unit.observe = async () => { const o = await observe(); if (f.probes === 3) f.failProbe(); return o; };
  let starts = 0;
  // Candidate startup is independent of this regression; assert the real stop completes before it.
  m.startOne = async () => { starts++; assert.equal(f.stops, 1); };
  m.candidateVerified = () => starts === 1;
  await m.updateDeployment(async () => ({ commit: 'c'.repeat(40), tools: f.tools }), { restart: true, confirm: true });
  assert.equal(starts, 1);
  assert.equal(f.probes, 3, 'there is no fourth, redundant diagnostic before /stop');
});
