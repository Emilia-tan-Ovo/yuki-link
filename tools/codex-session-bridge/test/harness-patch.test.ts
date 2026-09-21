import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, linkSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Harness } from '../src/harness/harness.ts';
import { createHarnessServer } from '../src/harness/server.ts';
import { ChangesSource } from '../src/harness/changes-source.ts';
import { parseDiff } from 'react-diff-view';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
test('Git binary markers classify attributes without matching ordinary text records', t => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'harness-patch-attributes-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repo, '.gitattributes'), '*.dat -diff\n', 'utf8');
  writeFileSync(path.join(repo, 'sample.dat'), 'before\n', 'utf8');
  writeFileSync(path.join(repo, 'ordinary.txt'), 'before\n', 'utf8');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const source = new ChangesSource(), baseline = source.capture(repo, 'HEAD');
  writeFileSync(path.join(repo, 'sample.dat'), 'after\n', 'utf8');
  assert.match(git(repo, 'diff', 'HEAD', '--', 'sample.dat'), /^Binary files .* differ$/m);
  const file = source.inspect(baseline).files.find(f => f.path === 'sample.dat')!;
  assert.equal(file.content.content_type, 'text');
  assert.deepEqual(source.patch(baseline, file), { state: 'binary', patch: null,
    integrity: { redacted: false, complete: false, reason: 'binary' } });
  for (const separator of ['', '\r', '\u2028', '\u2029']) {
    for (const marker of ['Binary files a/x and b/x differ', 'GIT binary patch']) {
      const line = (separator ? 'ordinary' + separator : '') + marker;
      writeFileSync(path.join(repo, 'ordinary.txt'), line + '\n', 'utf8');
      const textFile = source.inspect(baseline).files.find(f => f.path === 'ordinary.txt')!;
      const patch = source.patch(baseline, textFile);
      assert.equal(patch.state, 'available', JSON.stringify(line));
      assert.deepEqual(patch.integrity, { redacted: false, complete: true, reason: null });
      assert.ok(patch.patch!.split('\n').includes('+' + line), JSON.stringify(line));
    }
  }
});

test('ticket-scoped patch covers tracked, untracked, rename, structured restrictions and stale identity', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-patch-')), repo = path.join(root, 'repo'); mkdirSync(repo);
  const write = (name: string, text: string | Buffer) => writeFileSync(path.join(repo, name), text, 'utf8');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  for (const name of ['tracked.txt', 'old.txt', 'deleted.txt', 'literal[1].txt']) write(name, name + '\nbefore\nsecond\n');
  write('.env', 'private baseline'); write('.env.renamed', 'protected-renamed-body'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  const harness = new Harness(path.join(root, 'runtime'), { session: () => { throw Error('offline'); }, runs: () => [], events: () => [], attribution: () => null });
  const ticket = harness.register({ project_key: 'p', project_name: 'p', ticket_key: 't', title: 't', reference: 't', expected_worktree: repo, fixed_point: baseline });
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  write('tracked.txt', 'after\nsecond\nAuthorization: Bearer fixture-secret-value-123456\n');
  write('literal[1].txt', 'literal change\n'); write('untracked name.txt', 'new file\nno trailing newline');
  git(repo, 'mv', 'old.txt', 'renamed.txt'); rmSync(path.join(repo, 'deleted.txt'));
  git(repo, 'mv', '.env.renamed', 'public-name.txt');
  write('.env', 'private current'); write('binary.bin', Buffer.from([0, 1, 2])); write('large.txt', 'x'.repeat(65537));
  write('medium.txt', 'm'.repeat(9000)); write('hard.txt', 'hardlink body'); linkSync(path.join(repo, 'hard.txt'), path.join(repo, 'hard-copy.txt'));
  const outside = path.join(root, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'secret.txt'), 'outside value', 'utf8');
  symlinkSync(outside, path.join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const detail = harness.detail(ticket.ticket_id);
  assert.doesNotMatch(JSON.stringify(detail.changes), /protected-renamed-body/);
  const ref = (name: string) => { const file = detail.changes.files.find(f => f.path === name); assert.ok(file, name); return file; };
  const patch = (name: string) => { const file = ref(name); return harness.filePatch(ticket.ticket_id, file.file_id, file.revision); };
  const tracked = patch('tracked.txt'); assert.equal(tracked.state, 'available'); assert.equal(tracked.baseline, baseline);
  assert.equal(tracked.integrity.redacted, true); assert.doesNotMatch(tracked.patch!, /fixture-secret-value/); assert.match(tracked.patch!, /\+after/);
  assert.equal(parseDiff(tracked.patch!)[0].hunks.length, 1);
  const untracked = patch('untracked name.txt'); assert.equal(untracked.state, 'available');
  assert.match(untracked.patch!, /--- \/dev\/null/); assert.match(untracked.patch!, /No newline at end of file/); assert.equal(parseDiff(untracked.patch!)[0].type, 'add');
  const renamed = patch('renamed.txt'); assert.equal(renamed.state, 'available'); assert.match(renamed.patch!, /rename from old.txt/);
  assert.equal(patch('literal[1].txt').state, 'available'); assert.equal(patch('medium.txt').state, 'available');
  for (const [name, state] of [['deleted.txt', 'deleted'], ['.env', 'protected'], ['public-name.txt', 'protected'], ['binary.bin', 'binary'], ['large.txt', 'too-large'], ['hard.txt', 'unavailable']]) {
    const value = patch(name); assert.equal(value.state, state, name); assert.equal(value.patch, null); assert.equal(value.integrity.complete, false);
  }
  for (const file of detail.changes.files.filter(f => f.path.startsWith('linked'))) {
    const value = harness.filePatch(ticket.ticket_id, file.file_id, file.revision); assert.notEqual(value.state, 'available'); assert.doesNotMatch(JSON.stringify(value), /outside value/);
  }
  const previous = ref('tracked.txt'); write('tracked.txt', 'newer\n');
  assert.equal(harness.filePatch(ticket.ticket_id, previous.file_id, previous.revision).state, 'stale');
  const other = harness.register({ project_key: 'p', project_name: 'p', ticket_key: 'other', title: 'other', reference: 'other', expected_worktree: repo, fixed_point: baseline });
  assert.equal(harness.filePatch(other.ticket_id, previous.file_id, previous.revision).state, 'stale');
  assert.throws(() => harness.filePatch(ticket.ticket_id, '../.env', previous.revision), /INVALID_PATCH_REFERENCE/);
  const source = new ChangesSource(), current = source.inspect(detail.ticket.comparison_baseline!);
  const medium = current.files.find(f => f.path === 'medium.txt')!;
  assert.equal(source.patch(detail.ticket.comparison_baseline!, { ...medium, content: { ...medium.content, sha256: null } }).state, 'truncated');
  assert.equal(source.patch(detail.ticket.comparison_baseline!, { ...medium, old_path: '.env' }).state, 'protected');
  const ui = createHarnessServer(harness); await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
  t.after(() => { ui.close(); ui.closeAllConnections(); });
  const base = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`, home = await fetch(base), cookie = home.headers.get('set-cookie')!.split(';')[0];
  const url = `/api/tickets/${ticket.ticket_id}/changes/files/${previous.file_id}/patch?revision=${previous.revision}`;
  const stale = await fetch(base + url, { headers: { cookie } }); assert.equal(stale.status, 409); assert.equal(stale.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + url)).status, 403);
  renameSync(repo, path.join(root, 'moved'));
  assert.equal((await fetch(base + url, { headers: { cookie } })).status, 503);
});
