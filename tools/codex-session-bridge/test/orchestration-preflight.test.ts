import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectHostCapabilities, inspectDependency } from '../src/orchestration/preflight.ts';

test('capability facts follow the target PATH and name available fallbacks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'preflight-capability-'));
  try {
    const worktree = path.join(root, 'worktree'); mkdirSync(worktree);
    const empty = inspectHostCapabilities(worktree, { PATH: root });
    assert.equal(empty.rg.state, 'unavailable');
    assert.deepEqual(empty.fallbacks, []);
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    for (const name of process.platform === 'win32' ? ['rg.exe', 'git.exe', 'pwsh.exe'] : ['rg', 'git', 'pwsh']) {
      writeFileSync(path.join(bin, name), 'fixture');
    }
    const invalid = inspectHostCapabilities(worktree, { PATH: bin });
    assert.equal(invalid.git.state, 'unavailable');
    assert.equal(invalid.pwsh.state, 'unavailable');
    assert.equal(invalid.git.reason, 'version-probe-failed');
    assert.deepEqual(invalid.fallbacks, []);
    const found = inspectHostCapabilities(worktree, { PATH: bin }, (_executable, args) => {
      if (args[0] === '-NoProfile') return 'PowerShell 7.5';
      return 'verified version';
    });
    assert.equal(found.rg.state, 'available');
    assert.deepEqual(found.fallbacks, ['git grep', 'PowerShell Select-String']);
    assert.notEqual(found.path_digest, empty.path_digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dependency fact requires lock agreement and resolvable modules after preparation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'preflight-dependency-'));
  try {
    const pkg = path.join(root, 'tools', 'example'); mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'example', dependencies: { sample: '1.0.0' } }));
    writeFileSync(path.join(pkg, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies: { sample: '1.0.0' } } } }));
    assert.equal(inspectDependency(root, 'tools/example').state, 'missing');
    mkdirSync(path.join(pkg, 'node_modules', 'sample'), { recursive: true });
    writeFileSync(path.join(pkg, 'node_modules', 'sample', 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', main: 'index.js' }));
    writeFileSync(path.join(pkg, 'node_modules', 'sample', 'index.js'), 'module.exports = 1;');
    assert.equal(inspectDependency(root, 'tools/example').state, 'ready');
    writeFileSync(path.join(pkg, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies: { sample: '2.0.0' } } } }));
    assert.equal(inspectDependency(root, 'tools/example').state, 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a package with no dependencies needs no installation or lockfile', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'preflight-empty-package-'));
  try {
    const pkg = path.join(root, 'tools', 'empty'); mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'empty', dependencies: {} }));
    const fact = inspectDependency(root, 'tools/empty');
    assert.equal(fact.state, 'ready');
    assert.equal(fact.reason, 'no-dependencies');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
