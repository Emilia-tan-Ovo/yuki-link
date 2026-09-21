import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { YcaUnit } from '../src/units.js';
import { WindowsHost } from '../src/host.js';
import { Events, run, sleep } from '../src/common.js';

async function port() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const value = server.address().port;
  await new Promise(r => server.close(r));
  return value;
}

test('Control Center starts and restarts YCA after saved Desktop hash disappears', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yca-refresh-'));
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin');
  const install = hash => {
    const directory = path.join(bin, hash); mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, 'codex.exe');
    copyFileSync(process.execPath, executable); return executable;
  };
  const bridge = fileURLToPath(new URL('../../codex-session-bridge/', import.meta.url));
  const pwsh = (await run('pwsh.exe', ['-NoProfile', '-Command', '[Console]::Write((Get-Process -Id $PID).Path)'])).output.trim();
  const config = { node: process.execPath, pwsh, codex: path.join(bin, 'removed-hash', 'codex.exe'),
    entry: path.join(bridge, 'src/main.js'), cwd: bridge, repo: root, runtime: path.join(root, 'runtime'), port: await port(), controlPort: await port() };
  const unit = new YcaUnit(config, new WindowsHost(pwsh), {}, () => {}, new Events(root));
  t.after(async () => {
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
    await unit.stop();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'yca-refresh-')));
    rmSync(root, { recursive: true, force: true });
  });
  const first = install('first-hash');
  const start = async expected => {
    const startDeadline = Date.now() + 20_000;
    for (;;) {
      try { await unit.start(); break; }
      catch (error) {
        if (error?.code !== 'CODEX_EXECUTABLE_UNAVAILABLE' || error?.details?.spawn_code !== 'ETIMEDOUT' || Date.now() >= startDeadline) throw error;
        await sleep(200);
      }
    }
    const deadline = Date.now() + 20_000;
    while (!(await unit.observe()).healthy) { assert.ok(Date.now() < deadline); await sleep(200); }
    assert.equal(unit.codexResolution.executable, expected);
    assert.equal(unit.config.codex, config.codex, 'saved preference is not overwritten');
  };
  await start(first); await unit.stop();
  rmSync(first);
  await start(install('second-hash'));
});
