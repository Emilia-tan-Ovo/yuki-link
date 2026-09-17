import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { resolveCodexExecutable } from '../src/codex-executable.js';
import { CodexExecutor } from '../src/executor.js';
import { spawnDirect } from '../src/process.js';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'codex-discovery-'))); rmSync(root, { recursive: true, force: true }); });
  const install = hash => {
    const directory = path.join(root, 'OpenAI', 'Codex', 'bin', hash); mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, 'codex.exe'); copyFileSync(process.execPath, executable); return executable;
  };
  const options = { env: { LOCALAPPDATA: root, PATH: '' }, platform: 'win32' };
  return { root, install, resolve: configured => resolveCodexExecutable(configured, options) };
}

test('stale saved path discovers new hash without PATH and revalidates cached files after replacement', t => {
  const f = fixture(t), old = f.install('old');
  assert.equal(f.resolve(old).source, 'configured');
  rmSync(old); const current = f.install('current');
  const resolved = f.resolve(old);
  assert.equal(resolved.executable, current); assert.equal(resolved.source, 'desktop'); assert.equal(resolved.refreshed, true);
  rmSync(current); const next = f.install('next');
  assert.equal(f.resolve(old).executable, next);
  // Same pathname, different bytes: the prior successful probe must not survive.
  writeFileSync(next, 'not an executable', 'utf8');
  assert.throws(() => f.resolve(next), { code: 'CODEX_EXECUTABLE_UNAVAILABLE' });
});

test('valid explicit native executable wins; invalid/newest candidate is skipped', t => {
  const f = fixture(t), valid = f.install('valid'), newer = f.install('newer');
  utimesSync(valid, new Date(1000), new Date(1000));
  assert.equal(f.resolve(valid).executable, valid);
  writeFileSync(newer, 'broken update', 'utf8');
  assert.equal(f.resolve(path.join(f.root, 'missing.exe')).executable, valid);
  const directory = path.join(f.root, 'directory.exe'); mkdirSync(directory);
  assert.equal(f.resolve(directory).executable, valid);
});

test('missing installation gives actionable, path-free diagnostics and rejects shell shims', t => {
  const f = fixture(t);
  const shim = path.join(f.root, 'private-account.cmd'); writeFileSync(shim, '@echo should never run', 'utf8');
  assert.throws(() => f.resolve(shim), error => {
    assert.equal(error.code, 'CODEX_EXECUTABLE_UNAVAILABLE');
    assert.equal(error.details.configured_status, 'ENOEXEC');
    assert.match(error.message, /automatic discovery/);
    assert.ok(!JSON.stringify(error).includes(f.root)); return true;
  });
  assert.throws(() => f.resolve(path.join(f.root, 'absent.exe')), error => error.details.spawn_code === 'ENOENT');
});

test('catalog refresh and successive session launches rediscover hashes while objects stay alive', async t => {
  const f = fixture(t), saved = path.join(f.root, 'missing.exe');
  const first = f.install('first');
  const app = path.join(f.root, 'app-server');
  writeFileSync(app, `const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line); if (r.id == null) return;
      console.log(JSON.stringify({id:r.id,result:r.method === 'initialize' ? {userAgent:process.execPath} : {
        data:[{model:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}}));
    });`, 'utf8');
  // app-server is a Node fixture, so isolate its cwd in a child test process.
  const code = `import { ModelCatalog } from ${JSON.stringify(new URL('../src/catalog.js', import.meta.url).href)};
    import assert from 'node:assert/strict';
    import { copyFileSync, rmSync, mkdirSync } from 'node:fs';
    import { resolveCodexExecutable } from ${JSON.stringify(new URL('../src/codex-executable.js', import.meta.url).href)};
    const catalog = new ModelCatalog(${JSON.stringify(saved)}, { resolveExecutable: p => resolveCodexExecutable(p, {
      platform:'win32', env:{LOCALAPPDATA:${JSON.stringify(f.root)},PATH:''}}) });
    const result = await catalog.list(true); assert.equal(result.user_agent, ${JSON.stringify(first)});
    mkdirSync(${JSON.stringify(path.join(f.root, 'OpenAI', 'Codex', 'bin', 'catalog-next'))});
    const next = ${JSON.stringify(path.join(f.root, 'OpenAI', 'Codex', 'bin', 'catalog-next', 'codex.exe'))};
    copyFileSync(${JSON.stringify(first)}, next);
    // Discovery sends EOF and allows a short graceful child shutdown. Windows
    // keeps its executable locked until that owned fixture process exits.
    const deadline = Date.now() + 5000;
    for (;;) {
      try { rmSync(${JSON.stringify(first)}); break; }
      catch (error) { if (error.code !== 'EPERM' || Date.now() >= deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await catalog.list(true)).user_agent, next);
    console.log(result.models[0].model);`;
  const child = spawnDirect(process.execPath, ['--input-type=module', '-e', code], { cwd: f.root });
  child.stdin.end(); let output = '', errors = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
  assert.equal(await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }), 0, errors);
  assert.match(output, /fixture/);
  const current = f.resolve(saved).executable;
  const selected = [];
  const executor = new CodexExecutor(saved, (executable, args, options) => {
    selected.push(executable);
    return spawnDirect(executable, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"fixture"})));'], options);
  }, f.resolve);
  const launch = () => new Promise(resolve => executor.start({ model: 'fixture', reasoning: 'low' }, { cwd: f.root }, 'hello', {
    onEvent() {}, onStderr() {}, onSpawn() {}, onDone: resolve,
  }));
  assert.equal((await launch()).code, 0);
  rmSync(current); const second = f.install('second');
  assert.equal((await launch()).code, 0);
  assert.deepEqual(selected, [current, second]);
});
