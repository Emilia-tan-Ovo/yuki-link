import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsMcpUnit } from '../src/windows-mcp-unit.js';
import { fail } from '../src/common.js';

function fixture({ trustedChild = true } = {}) {
  const root = { pid: 4100, created: '2026-10-03T01:49:28.226756Z', matches: true };
  const service = { pid: 4200, created: '2026-10-03T01:49:28.300000Z', matches: true };
  let rootAlive = true, serviceAlive = true, treeStops = 0, childChecks = 0;
  const host = {
    inspect: async () => rootAlive ? [root] : [],
    portOwner: async () => serviceAlive ? service.pid : null,
    free: async () => { if (serviceAlive) throw fail('PORT_CONFLICT'); },
    inspectRedirectorService: async () => { childChecks++; return trustedChild && serviceAlive ? service : null; },
    terminateRedirectorTree: async () => { treeStops++; rootAlive = false; serviceAlive = false; },
  };
  const state = { process: { pid: root.pid, created: root.created }, managedProcess: { pid: root.pid, created: root.created } };
  const unit = new WindowsMcpUnit({ python: process.execPath, port: 8123 }, host, state, () => {}, { add() {} }, {
    probe: async () => ({ healthy: true, serverName: 'windows-mcp', serverVersion: 'test' }),
  });
  return { unit, root, service, state, get childChecks() { return childChecks; }, get treeStops() { return treeStops; } };
}

test('a proven redirector child is the managed port-owning service and tree stop verifies release', async () => {
  const f = fixture();
  const observed = await f.unit.observe();
  assert.equal(observed.owned, true);
  assert.equal(observed.healthy, true);
  assert.deepEqual(observed.serviceProcess, { pid: f.service.pid, created: f.service.created });
  assert.ok(f.childChecks > 0);
  await f.unit.stop(true);
  assert.equal(f.treeStops, 1);
  assert.equal(f.state.lastStop.state, 'stopped');
});

test('an unproven port-owning child cannot confer ownership or be stopped', async () => {
  const f = fixture({ trustedChild: false });
  const observed = await f.unit.observe();
  assert.equal(observed.owned, false);
  assert.equal(observed.healthy, false);
  await assert.rejects(f.unit.stop(true), { code: 'OWNERSHIP_CHANGED' });
  assert.equal(f.treeStops, 0);
});

test('a child PID reused between observation and stop cannot be terminated as the old service', async () => {
  const f = fixture();
  f.unit.host.terminateRedirectorTree = async () => { throw fail('OWNERSHIP_CHANGED'); };
  await assert.rejects(f.unit.stop(true), { code: 'OWNERSHIP_CHANGED' });
  assert.equal(f.treeStops, 0);
});
