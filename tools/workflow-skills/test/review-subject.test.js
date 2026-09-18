import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, copyFileSync, symlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, git } from './helpers.js';

function capture(f, fixed = f.head, previous, env = process.env) {
  const script = path.join(f.repo, '.workflow/skills/code-review/scripts/review-subject.mjs');
  const result = spawnSync(process.execPath, [script, f.repo, fixed, ...(previous ? [previous] : [])],
    { encoding: 'utf8', shell: false, windowsHide: true, env });
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

for (const flags of [['--assume-unchanged'], ['--skip-worktree'], ['--assume-unchanged', '--skip-worktree']]) {
  test(`hidden index flags ${flags.join(' ')} fail closed without changing the caller index`, t => {
    const f = fixture(t);
    const name = 'hidden [1].txt';
    writeFileSync(path.join(f.repo, name), 'baseline\n');
    const fixed = f.commit();
    for (const flag of flags) git(f.repo, 'update-index', flag, '--', name);
    writeFileSync(path.join(f.repo, name), 'unreviewed implementation\n');
    const indexPath = path.resolve(f.repo, git(f.repo, 'rev-parse', '--git-path', 'index'));
    const before = readFileSync(indexPath);
    const result = capture(f, fixed);
    assert.equal(result.status, 1, 'hidden working bytes must never produce captured/empty');
    assert.equal(result.data.status, 'error');
    assert.match(result.data.error, /HIDDEN_INDEX_STATE/);
    assert.equal(result.data.empty, undefined);
    assert.deepEqual(readFileSync(indexPath), before, 'do not clear flags or refresh caller index');
  });
}

test('Windows repository git.exe and PATH aliases never shadow the external Git executable',
  { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t);
    // Trusted Node is a harmless sentinel: executing it as Git would emit "bad option".
    const shadow = path.join(f.repo, 'git.exe');
    copyFileSync(process.execPath, shadow);
    const alias = path.join(f.root, 'repository-alias');
    symlinkSync(f.repo, alias, 'junction');
    const indexPath = path.resolve(f.repo, git(f.repo, 'rev-parse', '--git-path', 'index'));
    const before = readFileSync(indexPath);
    const env = { ...process.env, PATH: [f.repo, '.', alias, process.env.PATH].join(path.delimiter) };
    const result = capture(f, f.head, undefined, env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.data.status, 'captured');
    assert.equal(result.data.head, f.head);
    assert.ok(result.data.untracked.some(file => file.path === 'git.exe'));
    assert.deepEqual(readFileSync(indexPath), before);
    assert.deepEqual(readFileSync(shadow), readFileSync(process.execPath));
    // With no tree-external canonical Git, fail before executing either same-name file.
    const unavailable = capture(f, f.head, undefined, { ...env, PATH: [f.repo, '.', alias].join(path.delimiter) });
    assert.equal(unavailable.status, 1);
    assert.equal(unavailable.data.error, 'GIT_UNAVAILABLE');
  });

for (const state of ['uninitialized', 'committed-directory-removed']) {
  test(`index gitlink ${state} fails closed even without a directory and preserves the index`, t => {
    const f = fixture(t);
    const submodule = path.join(f.repo, 'dependency');
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${f.head},dependency`);
    let fixed = f.head;
    if (state === 'committed-directory-removed') {
      mkdirSync(submodule);
      git(f.repo, 'commit', '--quiet', '-m', 'fixture gitlink');
      fixed = git(f.repo, 'rev-parse', 'HEAD');
      rmdirSync(submodule); // Only this fixture's newly created empty directory.
    }
    const indexPath = path.resolve(f.repo, git(f.repo, 'rev-parse', '--git-path', 'index'));
    const before = readFileSync(indexPath);
    const result = capture(f, fixed);
    assert.equal(result.status, 1, 'a missing gitlink is not an ordinary deleted file');
    assert.equal(result.data.status, 'error');
    assert.match(result.data.error, /UNSUPPORTED_INDEX_MODE: 160000/);
    assert.equal(result.data.tracked, undefined);
    assert.deepEqual(readFileSync(indexPath), before);
  });
}
