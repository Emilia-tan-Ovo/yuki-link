import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { saveJson, readJson, run, sleep, get } from '../src/common.js';

async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function ready(base) {
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    try {
      const page = await fetch(base, { signal: AbortSignal.timeout(1000) }); const cookie = page.headers.get('set-cookie')?.split(';')[0];
      const s = await (await fetch(base + '/api/status', { headers: { cookie }, signal: AbortSignal.timeout(1000) })).json();
      if (s.supervisor && s.units.yca.at) return { cookie, ...s };
    } catch { }
    await sleep(200);
  }
  throw Error('Manager not ready');
}
test('actual supervisor process crash, duplicate opener and persisted stop with isolated YCA', { skip: process.platform !== 'win32', timeout: 90_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-manager-')); mkdirSync(path.join(root, 'workspace'));
  const pwsh = process.env.CC_TEST_PWSH ?? (await run('pwsh.exe', ['-NoProfile', '-Command', '[Console]::Write((Get-Process -Id $PID).Path)'])).output.trim();
  const bridge = fileURLToPath(new URL('../../codex-session-bridge/', import.meta.url));
  const alias = 'codex-session-bridge', file = path.join(root, 'config.json'), profile = path.join(root, alias + '.yaml');
  const config = { version: 1, observeOnly: false, allowStartupChanges: false, port: await port(), stateDir: path.join(root, 'state'), node: process.execPath, pwsh, codex: process.execPath,
    yca: { entry: path.join(bridge, 'src/main.js'), cwd: bridge, repo: path.join(root, 'workspace'), runtime: path.join(root, 'yca'), port: await port(), controlPort: await port() },
    tunnel: { bin: process.execPath, stateRoot: root, profile, alias } };
  config.tunnel.target = `http://127.0.0.1:${config.yca.port}/mcp`;
  saveJson(file, config); saveJson(profile, { control_plane: { tunnel_id: 'fixture', api_key: 'file:never-read' }, mcp: { server_urls: [{ url: config.tunnel.target }] }, health: { listen_addr: '127.0.0.1:0' }, log: { file: path.join(root, 'missing.log') } });
  saveJson(path.join(root, 'aliases.yaml'), { [alias]: { profile_path: profile, tunnel_id: 'fixture' } }); saveJson(path.join(root, 'processes.yaml'), {});
  const children = [];
  const launch = () => { const p = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), '--config', file], { windowsHide: true, shell: false, stdio: 'ignore' }); children.push(p); return p; };
  const kill = async p => { if (p.exitCode !== null || p.signalCode !== null) return; const done = once(p, 'exit'); p.kill(); await done; };
  t.after(async () => {
    try {
      const state = readJson(path.join(config.stateDir, 'state.json'), null);
      if (state?.units.yca.ownership.token) await get(`http://127.0.0.1:${config.yca.controlPort}/stop`, { method: 'POST', confirm: true, token: state.units.yca.ownership.token }).catch(() => {});
      await sleep(500);
    } finally { for (const p of children) await kill(p); assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-manager-'))); rmSync(root, { recursive: true, force: true }); }
  });
  const base = `http://127.0.0.1:${config.port}`;
  let p = launch(), session = await ready(base);
  const post = async (route, body) => {
    const r = await fetch(base + route, { method: 'POST', headers: { cookie: session.cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': session.csrf }, body: JSON.stringify(body) });
    assert.equal(r.status, 200, await r.text());
  };
  await post('/api/action', { id: 'yca', action: 'start' }); await post('/api/recovery', { enabled: true });
  session = await ready(base); const ycaPid = session.units.yca.pid;
  const duplicate = launch(); const [duplicateCode] = await once(duplicate, 'exit'); assert.equal(duplicateCode, 1);
  assert.equal((await ready(base)).units.yca.pid, ycaPid);
  await kill(p); p = launch(); session = await ready(base);
  assert.equal(session.units.yca.pid, ycaPid); assert.equal(session.units.yca.owned, true);
  await post('/api/action', { id: 'all', action: 'stop' });
  await kill(p); p = launch(); session = await ready(base);
  assert.equal(session.units.yca.running, false); assert.equal(session.units.yca.desired, 'stopped');
  assert.equal(session.units.tunnel.desired, 'stopped');
});
