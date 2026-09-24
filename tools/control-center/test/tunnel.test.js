import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { TunnelUnit } from '../src/units.js';
import { Events, saveJson, readJson } from '../src/common.js';

test('native runtime adapter reuses a fixed tunnel, validates identity and refuses PID reuse/custom profile loss', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-tunnel-'));
  const alias = 'codex-session-bridge', target = 'http://127.0.0.1:17391/mcp';
  const profileFile = path.join(root, alias + '.yaml'), state = {}, calls = [];
  mkdirSync(path.join(root, 'health')); mkdirSync(path.join(root, 'logs'));
  const profile = { config_version: 1, admin_ui: { open_browser: false },
    control_plane: { tunnel_id: 'tunnel_test_fixture', base_url: 'https://api.openai.com', api_key: 'file:never-open-this-fixture-reference' },
    health: { listen_addr: '127.0.0.1:0', url_file: path.join(root, 'health', alias + '.url') },
    log: { level: 'info', format: 'json', file: path.join(root, 'logs', alias + '.log') },
    mcp: { server_urls: [{ channel: 'main', url: target }] } };
  saveJson(profileFile, profile); saveJson(path.join(root, 'aliases.yaml'), { [alias]: { tunnel_id: profile.control_plane.tunnel_id, profile_path: profileFile } });
  saveJson(path.join(root, 'processes.yaml'), {});
  let actual = null, poison = false, readyBody = 'ready';
  const server = http.createServer((req, res) => {
    const body = req.url === '/healthz' ? 'live' : req.url === '/readyz' ? readyBody : JSON.stringify(req.url === '/api/status'
      ? { control_plane_tunnel_id: poison ? 'wrong_tunnel' : profile.control_plane.tunnel_id }
      : { proxy_health: [{ route: { kind: 'control_plane' }, health_state: 'healthy', last_check: new Date().toISOString() }], credential: 'sk-DO_NOT_EXPORT_THIS' });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  writeFileSync(profile.health.url_file, `http://127.0.0.1:${server.address().port}`);
  t.after(() => { server.close(); server.closeAllConnections(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-tunnel-'))); rmSync(root, { recursive: true, force: true }); });
  const host = { inspect: async (exe, markers, pid) => actual && (!pid || pid === actual.pid) ? [actual] : [] };
  const invoke = async (bin, args) => {
    if (args[0] === '--version') return { code: 0, output: '0.0.14+0f870e50a973fa820d4c409000059e181e8d242b' };
    calls.push(args);
    if (args[1] === 'connect') {
      actual = { pid: 12345, created: new Date().toISOString(), matches: true };
      saveJson(path.join(root, 'processes.yaml'), { [alias]: { pid: actual.pid, target_value: target, tunnel_id: profile.control_plane.tunnel_id } });
    } else actual = null;
    return { code: 0, output: '{"api_key":"sk-DO_NOT_EXPORT_THIS"}' };
  };
  const unit = new TunnelUnit({ bin: process.execPath, stateRoot: root, alias, target, profile: profileFile, backupDir: root }, host, state, () => {}, new Events(root), invoke);
  await unit.start(); let o = await unit.observe(); assert.equal(o.owned, true); assert.equal(o.healthy, true);
  readyBody = 'ready (mcp startup probe timed out: mcp probe timed out after 2s: context deadline exceeded)';
  o = await unit.observe(); assert.equal(o.healthy, true, 'a known native startup warning does not negate HTTP 200 readiness');
  assert.equal(calls[0][1], 'connect'); assert.ok(calls[0].includes('--tunnel-id')); assert.ok(!calls[0].includes('create'));
  assert.ok(!JSON.stringify(o).includes('sk-')); assert.ok(!JSON.stringify(o).includes('tunnel_test_fixture'));
  await unit.start(); assert.equal(calls.length, 1);
  poison = true; assert.equal((await unit.observe()).healthy, false); poison = false;
  actual = { ...actual, created: '2000-01-01T00:00:00Z' }; await assert.rejects(unit.stop(), { code: 'OBSERVED_UNOWNED' });
  actual.created = state.process.created; await unit.stop(); assert.equal(calls.length, 2); assert.equal(calls[1][1], 'stop');
  profile.mcp.server_urls[0].extra_headers = { Authorization: 'fixture-only' }; saveJson(profileFile, profile);
  await assert.rejects(unit.start(), { code: 'PROFILE_REVIEW_REQUIRED' }); assert.equal(calls.length, 2);
  delete profile.mcp.server_urls[0].extra_headers; saveJson(profileFile, profile);
  // Native PID metadata now points to an unrelated live process, even if its
  // executable is not tunnel-client. Never invoke native connect in that case.
  actual = { pid: 12345, created: '2001-01-01T00:00:00Z', matches: false };
  host.inspect = async (exe, markers, pid) => pid ? [actual] : [];
  await assert.rejects(unit.start(), { code: 'PID_CONFLICT' }); assert.equal(calls.length, 2);
  assert.ok(!readFileSync(path.join(root, 'events.jsonl'), 'utf8').includes('sk-'));
  assert.deepEqual(readJson(profileFile), profile);
});
