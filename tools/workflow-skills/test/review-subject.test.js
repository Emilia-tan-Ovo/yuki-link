import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, git } from './helpers.js';

function capture(f, fixed = f.head, previous) {
  const script = path.join(f.repo, '.workflow/skills/code-review/scripts/review-subject.mjs');
  const result = spawnSync(process.execPath, [script, f.repo, fixed, ...(previous ? [previous] : [])],
    { encoding: 'utf8', shell: false, windowsHide: true });
  let data;
  try { data = JSON.parse(result.stdout); } catch { /* Show raw output on failure. */ }
  return { ...result, data };
}

test('review subject includes staged, unstaged and new bytes even when committed diff is empty', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.repo, 'logic.txt'), 'baseline\n');
  const fixed = f.commit();
  writeFileSync(path.join(f.repo, 'logic.txt'), 'staged\n');
  git(f.repo, 'add', 'logic.txt');
  writeFileSync(path.join(f.repo, 'logic.txt'), 'working\n');
  writeFileSync(path.join(f.repo, '新增 [1].txt'), 'new\n');
  const before = git(f.repo, 'status', '--porcelain=v1');
  const result = capture(f, fixed);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.data.patches.committed, '');
  assert.match(result.data.patches.staged, /\+staged/);
  assert.match(result.data.patches.unstaged, /\+working/);
  assert.deepEqual(result.data.untracked.map(file => file.path), ['新增 [1].txt']);
  assert.match(result.data.untracked[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.data.empty, false);
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), before, 'capture is read-only');
  mkdirSync(path.join(f.repo, '.local'), { recursive: true });
  const saved = path.join(f.repo, '.local/subject.json');
  writeFileSync(saved, JSON.stringify(result.data));
  assert.equal(capture(f, fixed, saved).data.status, 'matched');
  writeFileSync(path.join(f.repo, '新增 [1].txt'), 'changed new bytes\n');
  const changed = capture(f, fixed, saved);
  assert.equal(changed.status, 1);
  assert.equal(changed.data.status, 'stale');
});

test('committed changes, binary bytes, deletion and index drift invalidate old review evidence', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.repo, 'baseline.txt'), 'before\n');
  const fixed = f.commit();
  writeFileSync(path.join(f.repo, 'baseline.txt'), 'committed\n');
  writeFileSync(path.join(f.repo, 'binary.bin'), Buffer.from([0, 1, 2]));
  f.commit();
  const first = capture(f, fixed);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.match(first.data.patches.committed, /\+committed/);
  assert.match(first.data.patches.committed, /GIT binary patch/);
  assert.notEqual(first.data.head, fixed);
  mkdirSync(path.join(f.repo, '.local'), { recursive: true });
  const saved = path.join(f.repo, '.local/subject.json');
  writeFileSync(saved, JSON.stringify(first.data));
  writeFileSync(path.join(f.repo, 'binary.bin'), Buffer.from([0, 1, 3]));
  assert.equal(capture(f, fixed, saved).data.status, 'stale');
  unlinkSync(path.join(f.repo, 'baseline.txt'));
  const deleted = capture(f, fixed);
  assert.equal(deleted.data.tracked.find(file => file.path === 'baseline.txt').kind, 'missing');
  writeFileSync(saved, JSON.stringify(deleted.data));
  git(f.repo, 'add', '-u');
  assert.equal(capture(f, fixed, saved).data.status, 'stale', 'unchanged working bytes do not hide a changed index');
  assert.equal(capture(f, '--bad-ref').data.status, 'error');
  assert.notEqual(capture(f, fixed, saved).status, 0);
});

test('unchanged worktree with a new HEAD and tampered saved evidence cannot reuse the old identity', t => {
  const f = fixture(t);
  const first = capture(f);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(first.data.empty, true);
  mkdirSync(path.join(f.repo, '.local'), { recursive: true });
  const saved = path.join(f.repo, '.local/subject.json');
  writeFileSync(saved, JSON.stringify(first.data));
  git(f.repo, 'commit', '--allow-empty', '--quiet', '-m', 'new HEAD');
  assert.equal(capture(f, f.head, saved).data.status, 'stale');
  first.data.head = git(f.repo, 'rev-parse', 'HEAD');
  writeFileSync(saved, JSON.stringify(first.data));
  assert.equal(capture(f, f.head, saved).data.error, 'INVALID_PREVIOUS_SUBJECT');
});
