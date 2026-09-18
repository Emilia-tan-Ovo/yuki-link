import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, ok, json, git } from './helpers.js';

function updating(t) {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, 'implement/agents'), { recursive: true });
  fs.writeFileSync(path.join(f.target, 'implement/SKILL.md'), 'old skill');
  fs.writeFileSync(path.join(f.target, 'implement/agents/openai.yaml'), 'old metadata');
  return { ...f, previewed: ok(f.preview()) };
}
function fault(f, source) {
  const preload = path.join(f.root, 'fault.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');\n${source}\n`);
  return { nodeArgs: ['--import', pathToFileURL(preload).href] };
}
function apply(f, options) { return f.call('apply', ['--plan', f.previewed.plan, '--approve', f.previewed.digest], options); }

test('backup failure leaves every installed byte untouched and preserves intent without a success receipt', t => {
  const f = updating(t);
  const result = apply(f, fault(f, `
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (String(file).includes('backup-') && String(file).endsWith('.bin')) throw Object.assign(Error(), { code: 'ENOSPC' });
      return write(file, ...args);
    };`));
  assert.equal(result.status, 1);
  assert.equal(result.data.status, 'not-applied');
  assert.equal(result.data.error.code, 'ENOSPC');
  assert.equal(fs.readFileSync(path.join(f.target, 'implement/SKILL.md'), 'utf8'), 'old skill');
  assert.equal(fs.readFileSync(path.join(f.target, 'implement/agents/openai.yaml'), 'utf8'), 'old metadata');
  assert.ok(fs.existsSync(path.join(path.dirname(f.previewed.plan), 'intent.json')));
  assert.equal(fs.existsSync(path.join(path.dirname(f.previewed.plan), 'receipt.json')), false);
  assert.equal(apply(f).data.error.code, 'APPLY_BUSY');
});

for (const mode of ['write-failure', 'interruption', 'readback-drift']) {
  test(`${mode} never reports installation success or rolls back unrelated writes`, t => {
    const f = updating(t);
    const result = apply(f, fault(f, `
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (${JSON.stringify(mode)} === 'write-failure' && String(to).endsWith('SKILL.md')) throw Object.assign(Error(), { code: 'EIO' });
        const result = rename(from, to);
        if (${JSON.stringify(mode)} === 'interruption') process.exit(91);
        if (${JSON.stringify(mode)} === 'readback-drift' && String(to).endsWith('SKILL.md')) fs.writeFileSync(to, 'external concurrent change');
        return result;
      };`));
    assert.notEqual(result.status, 0);
    if (mode !== 'interruption') assert.equal(result.data.status, 'partial-or-unknown');
    else assert.equal(result.status, 91);
    const recovery = path.dirname(f.previewed.plan);
    assert.equal(fs.existsSync(path.join(recovery, 'receipt.json')), false);
    const backups = fs.readdirSync(recovery).filter(name => name.startsWith('backup-') && name.endsWith('.bin'));
    assert.deepEqual(backups.map(name => fs.readFileSync(path.join(recovery, name), 'utf8')).sort(), ['old metadata', 'old skill']);
    assert.ok(fs.existsSync(path.join(f.target, '.workflow-apply.lock')));
    assert.equal(f.call('verify', ['--plan', f.previewed.plan]).data.status, 'drift');
    assert.notEqual(apply(f).status, 0);
    if (mode === 'readback-drift') assert.equal(fs.readFileSync(path.join(f.target, 'implement/SKILL.md'), 'utf8'), 'external concurrent change');
  });
}

test('two worktrees share the same installation lock and never remove an unknown owner lock', t => {
  const f = updating(t), second = path.join(f.root, 'other-worktree');
  git(f.repo, 'worktree', 'add', '--detach', second, 'HEAD');
  const lock = path.join(f.target, '.workflow-apply.lock');
  fs.writeFileSync(lock, 'unknown owner; preserve');
  assert.equal(apply(f).data.error.code, 'APPLY_BUSY');
  // The plan records the other checkout, while the lock belongs to the installation root.
  const cli = path.join(second, 'tools/workflow-skills/src/cli.js');
  const call = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: second, encoding: 'utf8', shell: false, windowsHide: true });
  const preview = JSON.parse(call('preview', '--repo', second, '--target', f.target, '--skills', 'implement').stdout);
  assert.ok(preview.digest);
  const result = JSON.parse(call('apply', '--plan', preview.plan, '--approve', preview.digest).stdout);
  assert.equal(result.error.code, 'APPLY_BUSY');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'unknown owner; preserve');
});
