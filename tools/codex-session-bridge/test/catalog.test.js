import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { ModelCatalog } from '../src/catalog.js';
import { spawnDirect } from '../src/process.js';
import { resolveCodexExecutable } from '../src/codex-executable.js';

test('missing executable reports an actionable spawn code without leaking its path', async () => {
  const catalog = new ModelCatalog(path.join(os.tmpdir(), 'private-account', 'missing-codex.exe'), {
    resolveExecutable: configured => resolveCodexExecutable(configured, { env: {} }),
  });
  await assert.rejects(catalog.list(true), error => {
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(error.details.spawn_code, 'ENOENT');
    assert.match(error.message, /--codex-bin/);
    assert.ok(!JSON.stringify(error).includes('private-account'));
    return true;
  });
});

test('explicit native executable discovers models when the service PATH has no Codex', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'catalog-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Node is the native test executable; its app-server file speaks the real RPC seam.
  writeFileSync(path.join(root, 'app-server'), `
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id == null) return;
      const result = request.method === 'initialize' ? {userAgent: 'fixture'} : {
        data: [{model: 'fixture-model', supportedReasoningEfforts: [{reasoningEffort: 'low'}]}], nextCursor: null
      };
      console.log(JSON.stringify({id: request.id, result}));
    });
  `, 'utf8');
  const code = `
    import assert from 'node:assert/strict';
    import { ModelCatalog } from ${JSON.stringify(new URL('../src/catalog.js', import.meta.url).href)};
    await assert.rejects(new ModelCatalog().list(true), {code: 'CAPABILITY_UNAVAILABLE'});
    const catalog = await new ModelCatalog(process.execPath).list(true);
    assert.equal(catalog.models[0].model, 'fixture-model');
    console.log('explicit-path-ok');
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = '';
  // Isolate installation discovery too; the developer's Desktop may be installed.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'localappdata') delete env[key];
  const child = spawnDirect(process.execPath, ['--input-type=module', '-e', code], {cwd: root, env});
  child.stdin.end();
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /explicit-path-ok/);
});
