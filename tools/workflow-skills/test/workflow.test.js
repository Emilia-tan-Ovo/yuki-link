import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fixture, ok, json } from './helpers.js';

test('preview records a complete source/target/tool-bound diff without changing installed bytes', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.target, 'implement'));
  writeFileSync(path.join(f.target, 'implement/SKILL.md'), '旧内容\r\n', 'utf8');
  const result = ok(f.preview());
  const plan = json(result.plan);
  assert.equal(plan.source.commit, f.head);
  assert.equal(plan.target.root, f.target);
  assert.equal(plan.tool.files.some(file => file.path === 'src/cli.js'), true);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.match(readFileSync(result.diff, 'utf8'), /-旧内容/);
  assert.match(readFileSync(result.diff, 'utf8'), /\+Implement the work/);
  assert.equal(plan.changes.length, 2, 'includes agents/openai.yaml');
  assert.equal(readFileSync(path.join(f.target, 'implement/SKILL.md'), 'utf8'), '旧内容\r\n');
  assert.deepEqual(readdirSync(path.join(f.target, 'implement')), ['SKILL.md']);
});

test('verify requires committed provenance even when dirty source bytes happen to match installed bytes', t => {
  const f = fixture(t);
  const file = path.join(f.repo, '.workflow/skills/ticket-design/SKILL.md');
  writeFileSync(file, 'uncommitted candidate');
  mkdirSync(path.join(f.target, 'ticket-design'));
  writeFileSync(path.join(f.target, 'ticket-design/SKILL.md'), 'uncommitted candidate');
  const preview = ok(f.preview('ticket-design'));
  assert.equal(preview.applyable, false);
  assert.equal(f.call('apply', ['--plan', preview.plan, '--approve', preview.digest]).data.error.code, 'SOURCE_NOT_COMMITTED');
  const verification = f.call('verify', ['--plan', preview.plan]);
  assert.equal(verification.status, 1);
  assert.equal(verification.data.status, 'source-unavailable');
  assert.equal(verification.data.error.code, 'SOURCE_NOT_COMMITTED');
});

test('deleted tracked installer files invalidate provenance and source cannot be its own installation', t => {
  const f = fixture(t);
  const previous = path.join(f.tool, 'src/previous.js');
  writeFileSync(previous, '// previously shipped helper\n'); f.commit(); unlinkSync(previous);
  const preview = ok(f.preview());
  assert.equal(preview.source_clean, false);
  assert.equal(f.call('apply', ['--plan', preview.plan, '--approve', preview.digest]).data.error.code, 'SOURCE_NOT_COMMITTED');
  const overlap = f.call('preview', ['--repo', f.repo, '--target', path.join(f.repo, '.workflow/skills'), '--skills', 'implement']);
  assert.equal(overlap.data.error.code, 'PATH_OVERLAP');
});

test('apply rejects target overrides and verify cannot be used as an implicit apply command', t => {
  const f = fixture(t), preview = ok(f.preview());
  const changed = f.call('apply', ['--plan', preview.plan, '--approve', preview.digest, '--target', f.root]);
  assert.equal(changed.data.error?.code, 'INVALID_ARGUMENTS');
  assert.deepEqual(readdirSync(f.target), []);
  const verify = f.call('verify', ['--plan', preview.plan]);
  assert.equal(verify.status, 1);
  assert.ok(verify.data.files.every(file => file.status === 'missing'));
  assert.deepEqual(readdirSync(f.target), []);
});

test('a multi-Skill installation receipt retains the exact approved plan digest', t => {
  const f = fixture(t), preview = ok(f.preview('implement,ticket-design'));
  const result = ok(f.call('apply', ['--plan', preview.plan, '--approve', preview.digest]));
  assert.equal(result.plan_digest, preview.digest);
  assert.equal(ok(f.call('verify', ['--plan', preview.plan])).plan_digest, preview.digest);
  assert.equal(json(path.join(path.dirname(preview.plan), 'receipt.json')).plan_digest, preview.digest);
});

test('only the approved plan installs exact bytes and independent verify detects later drift', t => {
  const f = fixture(t);
  const preview = ok(f.preview());
  assert.equal(f.call('apply', ['--plan', preview.plan]).data?.error.code, 'APPROVAL_REQUIRED');
  assert.deepEqual(readdirSync(f.target), []);
  const installed = ok(f.call('apply', ['--plan', preview.plan, '--approve', preview.digest]));
  assert.equal(installed.status, 'verified');
  for (const file of ['SKILL.md', 'agents/openai.yaml']) {
    assert.deepEqual(readFileSync(path.join(f.target, 'implement', file)), readFileSync(path.join(f.repo, '.workflow/skills/implement', file)));
  }
  assert.equal(ok(f.call('verify', ['--plan', preview.plan])).source.commit, f.head);
  writeFileSync(path.join(f.target, 'implement/SKILL.md'), 'changed after installation');
  const drift = f.call('verify', ['--plan', preview.plan]);
  assert.equal(drift.status, 1);
  assert.equal(drift.data.status, 'drift');
  assert.equal(drift.data.files.find(file => file.path === 'implement/SKILL.md').status, 'content-drift');
});

test('preview reports unexpected empty directories and refuses an unreviewable oversized diff', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.target, 'implement/unmanaged'), { recursive: true });
  const conflict = ok(f.preview());
  assert.equal(conflict.applyable, false);
  assert.deepEqual(conflict.extras, ['implement/unmanaged/']);
  assert.equal(f.call('apply', ['--plan', conflict.plan, '--approve', conflict.digest]).data.error.code, 'TARGET_CONFLICT');
  // Both individual files are valid UTF-8 within the per-file read budget.
  writeFileSync(path.join(f.repo, '.workflow/skills/ticket-design/SKILL.md'), '新'.repeat(50000));
  mkdirSync(path.join(f.target, 'ticket-design'));
  writeFileSync(path.join(f.target, 'ticket-design/SKILL.md'), '旧'.repeat(50000));
  const overflow = f.preview('ticket-design');
  assert.equal(overflow.data?.error.code, 'PREVIEW_TOO_LARGE');
});
