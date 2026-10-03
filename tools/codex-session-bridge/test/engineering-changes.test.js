import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Harness } from '../src/harness/harness.ts';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('current layers survive net cancellation; commit/editor/index changes invalidate old revisions', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yer-diff-'));
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const write = (file, value) => writeFileSync(path.join(root, file), value, 'utf8');
  write('code.txt', 'base\n'); write('deleted.txt', 'delete\n'); write('.env.private', 'private fixture text\n');
  write('retained.txt', 'still on disk\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  const head = git(root, 'rev-parse', 'HEAD');
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'yer-diff-runtime-'));
  const harness = new Harness(runtime, { session: () => { throw Error('none'); }, runs: () => [], events: () => [], attribution: () => null });
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); rmSync(runtime, { recursive: true, force: true }); });
  const id = harness.register({ project_key: 'p', project_name: 'p', ticket_key: 't', title: 't', reference: 'local:t',
    expected_worktree: root, fixed_point: head }).ticket_id, ticket = harness.tickets.get(id);
  const view = mode => harness.changes.view(ticket, [], null, mode);
  write('code.txt', 'staged\n'); git(root, 'add', 'code.txt');
  write('code.txt', 'base\n'); // HEAD equals worktree, while index differs.
  let current = view('current');
  const staged = current.files.find(file => file.path === 'code.txt' && file.layer === 'staged');
  const unstaged = current.files.find(file => file.path === 'code.txt' && file.layer === 'unstaged');
  assert.ok(staged && unstaged);
  assert.equal(view('cumulative').files.some(file => file.path === 'code.txt'), false);
  const patch = file => harness.changes.patch(ticket, file.file_id, file.revision, 'current');
  assert.match(patch(staged).patch, /\+staged/);
  assert.match(patch(unstaged).patch, /-staged/);
  assert.match(patch(unstaged).patch, /\+base/);
  git(root, 'add', 'code.txt');
  assert.equal(patch(staged).state, 'stale');

  write('code.txt', 'native edit\n'); write('new.txt', 'untracked\n');
  current = view('current');
  const prior = current.files.find(file => file.path === 'code.txt');
  const cumulativePrior = view('cumulative').files.find(file => file.path === 'code.txt');
  git(root, 'add', 'code.txt'); // Same file bytes; index alone invalidates both views.
  assert.equal(patch(prior).state, 'stale');
  assert.equal(harness.changes.patch(ticket, cumulativePrior.file_id, cumulativePrior.revision, 'cumulative').state, 'stale');
  git(root, 'commit', '-qm', 'native commit');
  current = view('current');
  assert.deepEqual(current.files.map(file => file.path), ['new.txt']);
  const cumulative = view('cumulative');
  assert.equal(cumulative.baseline.commit_oid, head);
  assert.equal(cumulative.commits.length, 1);
  assert.ok(cumulative.files.some(file => file.path === 'code.txt'));
  const untracked = current.files[0]; assert.match(patch(untracked).patch, /new file mode/);
  write('new.txt', 'edited externally\n'); assert.equal(patch(untracked).state, 'stale');

  write('binary.bin', Buffer.from([0, 1, 2])); git(root, 'add', 'binary.bin');
  unlinkSync(path.join(root, 'deleted.txt'));
  git(root, 'mv', '.env.private', 'renamed.txt');
  current = view('current');
  assert.equal(patch(current.files.find(file => file.path === 'binary.bin')).state, 'binary');
  assert.equal(patch(current.files.find(file => file.path === 'deleted.txt')).state, 'deleted');
  const renamed = current.files.find(file => file.path === 'renamed.txt');
  assert.equal(patch(renamed).state, 'protected'); assert.equal(renamed.content.sha256, null);
  assert.doesNotMatch(JSON.stringify(current), /private fixture text/);

  // SP-2: the same path has independent staged-deletion and untracked layers.
  git(root, 'rm', '--cached', 'retained.txt');
  current = view('current');
  const retained = current.files.filter(file => file.path === 'retained.txt');
  assert.equal(retained.length, 2);
  const removed = retained.find(file => file.layer === 'staged');
  const kept = retained.find(file => file.layer === 'untracked');
  assert.equal(removed.change_kind, 'deleted');
  assert.equal(patch(removed).state, 'deleted');
  assert.equal(kept.change_kind, 'added');
  assert.notEqual(kept.file_id, removed.file_id);
  assert.match(patch(kept).patch, /\+still on disk/);
  write('retained.txt', 'edited on disk\n');
  assert.equal(patch(kept).state, 'stale');
});
