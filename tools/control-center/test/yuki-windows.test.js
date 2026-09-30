import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowsMcpUnit } from '../src/windows-mcp-unit.js';
import { ProfileTunnelUnit } from '../src/profile-tunnel-unit.js';
import { fail } from '../src/common.js';

function temp(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-windows-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function child(pid = 4242) {
  const value = new EventEmitter();
  value.pid = pid;
  value.unref = () => {};
  return value;
}

test('WindowsMcpUnit refuses an existing matching process it does not own', async () => {
  const actual = { pid: 1111, created: '2026-09-29T00:00:00.000Z', matches: true };
  const host = { inspect: async () => [actual], free: async () => { throw fail('PORT_CONFLICT'); } };
  const unit = new WindowsMcpUnit({ python: process.execPath, port: 8000 }, host, {}, () => {}, { add() {} });
  const observation = await unit.observe();
  assert.equal(observation.running, true);
  assert.equal(observation.owned, false);
  assert.equal(observation.code, 'OBSERVED_UNOWNED');
  await assert.rejects(unit.start(), { code: 'OBSERVED_UNOWNED' });
});

test('WindowsMcpUnit records exact ownership and one successful startup MCP probe', async () => {
  const state = {};
  let spawned = false, probeCount = 0, spawnArgs;
  const actual = { pid: 4242, created: '2026-09-29T00:00:00.000Z', matches: true };
  const host = {
    inspect: async (_exe, _markers, pid) => spawned && (!pid || pid === actual.pid) ? [actual] : [],
    free: async () => { if (spawned) throw fail('PORT_CONFLICT'); },
  };
  const unit = new WindowsMcpUnit({ python: process.execPath, port: 8123 }, host, state, () => {}, { add() {} }, {
    spawnProcess: (_exe, args) => {
      spawnArgs = args; spawned = true; const c = child(actual.pid); queueMicrotask(() => c.emit('spawn')); return c;
    },
    probe: async () => { probeCount++; return { healthy: true, status: 200, serverName: 'windows-mcp', serverVersion: '4.0.3', code: null }; },
  });
  await unit.start();
  assert.deepEqual(spawnArgs, ['-m', 'windows_mcp', 'serve', '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', '8123']);
  assert.equal(probeCount, 1);
  assert.deepEqual(state.process, actual);
  assert.equal(state.lastProbe.serverVersion, '4.0.3');
  const observation = await unit.observe();
  assert.equal(observation.healthy, true);
  assert.equal(observation.owned, true);
});

test('ProfileTunnelUnit keeps ownership across profile drift and projects real communication evidence', async t => {
  const root = temp(t);
  const profile = path.join(root, 'yuki-windows.yaml');
  const profileContent = 'config_version: 1\nfixture: unchanged\n';
  writeFileSync(profile, profileContent);
  const profileSha256 = createHash('sha256').update(profileContent).digest('hex');
  const state = {};
  let spawned = false, spawnArgs;
  const actual = { pid: 5252, created: '2026-09-29T00:00:01.000Z', matches: true };
  const host = { inspect: async (_exe, _markers, pid) => spawned && (!pid || pid === actual.pid) ? [actual] : [] };
  const config = { bin: process.execPath, profile, profileSha256, stateDir: path.join(root, 'runtime'), target: 'http://127.0.0.1:8000/mcp' };
  const unit = new ProfileTunnelUnit(config, host, state, () => {}, { add() {} }, {
    invoke: async () => ({ code: 0, output: '0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0 (git sha: fixture)' }),
    spawnProcess: (_exe, args) => {
      spawnArgs = args; spawned = true;
      writeFileSync(path.join(config.stateDir, 'health.url'), 'http://127.0.0.1:45678/');
      writeFileSync(path.join(config.stateDir, 'tunnel.log'), JSON.stringify({
        time: new Date().toISOString(), msg: 'dispatcher forwarded command to MCP server', component: 'dispatcher',
      }) + '\n');
      const c = child(actual.pid); queueMicrotask(() => c.emit('spawn')); return c;
    },
    getHttp: async url => url.endsWith('/healthz') ? { status: 200, body: 'live' }
      : url.endsWith('/readyz') ? { status: 200, body: 'ready' }
        : { status: 200, json: { proxy_health: [{ route: { kind: 'control_plane' }, health_state: 'healthy', last_check: new Date().toISOString() }] } },
  });
  await unit.start();
  assert.deepEqual(state.process, actual);
  assert.equal(spawnArgs.includes('--profile-file'), true);
  assert.equal(spawnArgs[spawnArgs.indexOf('--profile-file') + 1], profile);
  const observation = await unit.observe();
  assert.equal(observation.running, true);
  assert.equal(observation.owned, true);
  assert.equal(observation.healthy, true);
  assert.equal(observation.communication.state, 'recent-local-evidence');
  assert.equal(observation.recentEvents.at(-1).action, 'forwarded-to-mcp');

  writeFileSync(profile, 'changed');
  assert.throws(() => unit.verifyProfile(), { code: 'PROFILE_CHANGED' });
  const changed = await unit.observe();
  assert.equal(changed.running, true);
  assert.equal(changed.owned, true);
  assert.equal(changed.healthy, false);
  assert.equal(changed.code, 'PROFILE_CHANGED');
  await assert.rejects(unit.start(), { code: 'PROFILE_CHANGED' });
});

test('ProfileTunnelUnit does not adopt a foreign process with the same profile', async t => {
  const root = temp(t);
  const profile = path.join(root, 'yuki-windows.yaml');
  writeFileSync(profile, 'fixture');
  const profileSha256 = createHash('sha256').update('fixture').digest('hex');
  const actual = { pid: 6262, created: '2026-09-29T00:00:02.000Z', matches: true };
  const unit = new ProfileTunnelUnit(
    { bin: process.execPath, profile, profileSha256, stateDir: path.join(root, 'runtime'), target: 'http://127.0.0.1:8000/mcp' },
    { inspect: async () => [actual] }, {}, () => {}, { add() {} },
  );
  const observation = await unit.observe();
  assert.equal(observation.owned, false);
  assert.equal(observation.code, 'OBSERVED_UNOWNED');
  await assert.rejects(unit.start(), { code: 'OBSERVED_UNOWNED' });
});
