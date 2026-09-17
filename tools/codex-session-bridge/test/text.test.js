import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectText } from './helpers/text-fixture.js';

test('MCP reads explicitly addressed outside UTF-8 text without changing its bytes', async t => {
  const { outside, call } = await connectText(t);
  const file = path.join(outside, '中文 [1].txt');
  const content = '\ufeff你好 🌸\r\n第二行\n';
  writeFileSync(file, content, 'utf8');
  const result = await call('filesystem_read', { path: file });
  assert.equal(result.isError, false);
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'content', 'encoding', 'isError', 'path', 'sha256']);
  assert.equal(result.content, content);
  assert.equal(result.bytes, Buffer.byteLength(content));
  assert.equal(result.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'));
  assert.equal(result.encoding, 'utf-8');
});

test('MCP preserves all content across short OS reads within a bounded buffer', async t => {
  const { workspace, call } = await connectText(t);
  const file = path.join(workspace, 'short-reads.txt');
  const content = '\ufeff中文🌸\r\n'.repeat(30);
  writeFileSync(file, content, 'utf8');
  const originalRead = fs.readSync;
  let reads = 0;
  const read = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    reads++;
    assert.ok(buffer.length <= 256 * 1024 + 1);
    return originalRead(fd, buffer, offset, Math.min(length, 7), position);
  });
  syncBuiltinESMExports();
  try {
    const result = await call('filesystem_read', { path: file });
    assert.equal(result.isError, false);
    assert.equal(result.content, content);
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(result.sha256, createHash('sha256').update(Buffer.from(content)).digest('hex'));
    assert.ok(reads > 2, 'The OS actually returned short reads before EOF');
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
});

test('MCP accepts empty and boundary-sized text but rejects overflow and invalid UTF-8', async t => {
  const { outside, call } = await connectText(t);
  for (const size of [0, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1]) {
    const file = path.join(outside, `size-${size}.txt`);
    const bytes = Buffer.alloc(size, 0x61);
    writeFileSync(file, bytes);
    const result = await call('filesystem_read', { path: file });
    if (size > 256 * 1024) {
      assert.equal(result.error.code, 'FILE_TOO_LARGE');
      assert.equal(result.content, undefined);
    } else {
      assert.equal(result.isError, false);
      assert.equal(result.content, bytes.toString('utf8'));
      assert.equal(result.bytes, size);
      assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
  }
  for (const [name, bytes] of [['null-byte', Buffer.from([0x61, 0])], ['invalid', Buffer.from([0xc3, 0x28])]]) {
    const file = path.join(outside, name);
    writeFileSync(file, bytes);
    assert.equal((await call('filesystem_read', { path: file })).error.code, 'NOT_UTF8_TEXT');
  }
  assert.equal((await call('filesystem_read', { path: outside })).error.code, 'NOT_A_FILE');
  assert.equal((await call('filesystem_read', { path: path.join(outside, 'missing') })).error.code, 'PATH_NOT_FOUND');
  assert.equal((await call('filesystem_read', { path: 'relative.txt' })).error.code, 'INVALID_PATH');
});

test('shared text size errors leave write, move and Git callers compatible', async t => {
  const { workspace, call } = await connectText(t);
  const file = path.join(workspace, 'large.txt');
  const destination = path.join(workspace, 'moved.txt');
  const bytes = Buffer.alloc(256 * 1024 + 1, 0x61);
  writeFileSync(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal((await call('filesystem_write', { path: file, content: 'small', expected_sha256: sha256 })).error.code, 'FILE_TOO_LARGE');
  assert.equal((await call('filesystem_move', { source: file, destination, expected_sha256: sha256 })).error.code, 'FILE_TOO_LARGE');
  const git = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  assert.equal((await call('git_diff', { cwd: workspace, path: file })).error.code, 'FILE_TOO_LARGE');
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(fs.existsSync(destination), false);
});

test('MCP reads an opted-in real local Skill without modifying it', { skip: !process.env.YCA_TEST_SKILL }, async t => {
  const file = process.env.YCA_TEST_SKILL;
  assert.match(file.replaceAll('\\', '/'), /\/(?:\.agents|\.codex)\/skills\/.*\/SKILL\.md$/i);
  const before = readFileSync(file);
  const modified = fs.statSync(file).mtimeMs;
  const { call } = await connectText(t);
  const result = await call('filesystem_read', { path: file });
  assert.equal(result.isError, false);
  assert.deepEqual(Buffer.from(result.content, 'utf8'), before);
  assert.equal(result.sha256, createHash('sha256').update(before).digest('hex'));
  assert.equal(result.bytes, before.length);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, modified);
  t.diagnostic(`Real local Skill: ${result.bytes} bytes, SHA-256 ${result.sha256}; no model calls`);
});

test('MCP creates and updates text, Markdown and source with independent-change conflict and no-op compatibility', async t => {
  const { workspace, call } = await connectText(t);
  for (const name of ['note.txt', 'README.md', 'sample.js']) {
    const file = path.join(workspace, name);
    const content = '\ufeff中文 🌸\r\n"quotes"\n';
    const created = await call('filesystem_write', { path: file, content });
    assert.equal(created.changed, true);
    assert.deepEqual(readFileSync(file), Buffer.from(content));
    const initial = await call('filesystem_read', { path: file });
    assert.equal(initial.content, content);
    writeFileSync(file, '独立写入\r\n', 'utf8');
    const conflict = await call('filesystem_write', { path: file, content: 'overwrite', expected_sha256: initial.sha256 });
    assert.equal(conflict.error.code, 'CONTENT_CONFLICT');
    assert.equal(readFileSync(file, 'utf8'), '独立写入\r\n');
    for (const expected_sha256 of [undefined, initial.sha256]) {
      const modified = fs.statSync(file).mtimeMs;
      const noop = await call('filesystem_write', { path: file, content: '独立写入\r\n', ...(expected_sha256 ? { expected_sha256 } : {}) });
      assert.equal(noop.changed, false);
      assert.equal(fs.statSync(file).mtimeMs, modified);
    }
    assert.equal((await call('filesystem_write', { path: file, content: 'different' })).error.code, 'FILE_EXISTS');
    const current = await call('filesystem_read', { path: file });
    const updated = await call('filesystem_write', { path: file, content, expected_sha256: current.sha256 });
    assert.equal(updated.changed, true);
    assert.deepEqual(readFileSync(file), Buffer.from(content));
    const destination = path.join(workspace, `moved-${name}`);
    writeFileSync(destination, 'keep', 'utf8');
    const move = { source: file, destination, expected_sha256: updated.sha256 };
    assert.equal((await call('filesystem_move', move)).error.code, 'FILE_EXISTS');
    assert.equal(readFileSync(destination, 'utf8'), 'keep');
    assert.equal(readFileSync(file, 'utf8'), content);
    const moved = await call('filesystem_move', { ...move, destination: path.join(workspace, `new-${name}`) });
    assert.equal(moved.changed, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(readFileSync(moved.destination, 'utf8'), content);
    assert.equal((await call('filesystem_write', { path: file, content, expected_sha256: updated.sha256 })).error.code, 'CONTENT_CONFLICT');
    assert.equal(fs.existsSync(file), false);
  }
});

test('text read expansion does not expand list, writes, moves, Git or PowerShell cwd', async t => {
  const { outside, workspace, call, computer } = await connectText(t);
  const file = path.join(outside, 'ordinary.txt');
  writeFileSync(file, 'outside', 'utf8');
  const inside = path.join(workspace, 'inside.txt');
  const created = await call('filesystem_write', { path: inside, content: 'inside' });
  assert.throws(() => computer.paths.resolve(file), { code: 'PATH_NOT_ALLOWED' });
  const denied = [
    ['filesystem_list', { path: outside }],
    ['filesystem_write', { path: file, content: 'overwrite' }],
    ['filesystem_write', { path: path.join(outside, 'new.txt'), content: 'new' }],
    ['filesystem_move', { source: inside, destination: path.join(outside, 'moved.txt'), expected_sha256: created.sha256 }],
    ['filesystem_move', { source: file, destination: path.join(workspace, 'moved.txt'), expected_sha256: created.sha256 }],
    ['git_status', { cwd: outside }],
    ['git_diff', { cwd: outside, path: file }],
    ['powershell', { cwd: outside, query: 'location' }],
    ['powershell_execute', { cwd: outside, script: 'throw "must not execute"' }],
  ];
  for (const [name, args] of denied) assert.equal((await call(name, args)).error.code, 'PATH_NOT_ALLOWED', name);
  const git = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  assert.equal((await call('git_diff', { cwd: workspace, path: file })).error.code, 'PATH_NOT_ALLOWED');
  const skill = path.join(workspace, '.agents', 'skills', 'sample', 'SKILL.md');
  mkdirSync(path.dirname(skill), { recursive: true }); writeFileSync(skill, 'skill', 'utf8');
  assert.equal((await call('filesystem_read', { path: skill })).content, 'skill');
  for (const [name, args] of [
    ['filesystem_list', { path: path.dirname(skill) }],
    ['filesystem_write', { path: skill, content: 'changed' }],
    ['filesystem_move', { source: skill, destination: inside, expected_sha256: created.sha256 }],
    ['filesystem_move', { source: inside, destination: skill, expected_sha256: created.sha256 }],
    ['git_status', { cwd: path.dirname(skill) }],
    ['git_diff', { cwd: workspace, path: skill }],
    ['powershell', { cwd: path.dirname(skill), query: 'location' }],
    ['powershell_execute', { cwd: path.dirname(skill), script: 'throw "must not execute"' }],
  ]) assert.equal((await call(name, args)).error.code, 'PROTECTED_PATH', name);
  assert.equal(readFileSync(file, 'utf8'), 'outside');
  assert.equal(readFileSync(skill, 'utf8'), 'skill');
});

test('MCP retains sensitive component, content, runtime, control and link protection outside roots', async t => {
  const { outside, runtime, call } = await connectText(t);
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  for (const file of [
    path.join(runtime, 'ordinary.txt'),
    path.join(repo, '.local/control-center/config.json'),
    ...['.env', '.git/config', '.ssh/note.md', 'credentials/note.md', 'private-key.txt', '.agents/skills/demo/.env', '.codex/skills/demo/runtime/note.txt'].map(name => path.join(outside, name)),
  ]) assert.equal((await call('filesystem_read', { path: file })).error.code, 'PROTECTED_PATH', file);
  const secretLike = 'sk-' + 'TESTONLY'.repeat(5);
  const file = path.join(outside, 'ordinary.txt');
  writeFileSync(file, secretLike, 'utf8');
  assert.equal((await call('filesystem_read', { path: file })).error.code, 'SENSITIVE_CONTENT');
  writeFileSync(file, 'ordinary', 'utf8');
  const linked = path.join(outside, 'linked.txt'); fs.linkSync(file, linked);
  assert.equal((await call('filesystem_read', { path: linked })).error.code, 'LINK_NOT_ALLOWED');
  const junction = path.join(outside, 'shortcut');
  const folder = path.join(outside, 'target'); mkdirSync(folder);
  writeFileSync(path.join(folder, 'note.txt'), 'linked', 'utf8');
  fs.symlinkSync(folder, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('filesystem_read', { path: path.join(junction, 'note.txt') })).error.code, 'LINK_NOT_ALLOWED');
  // A completed ordinary read gives the audit assertions a nonempty record.
  const safe = path.join(outside, 'safe.txt'); writeFileSync(safe, 'private note text', 'utf8');
  assert.equal((await call('filesystem_read', { path: safe })).content, 'private note text');
  const audit = readFileSync(path.join(runtime, 'computer-audit.jsonl'), 'utf8');
  assert.equal(audit.includes(secretLike), false);
  assert.equal(audit.includes('private note text'), false);
  assert.equal(audit.includes(outside.replaceAll('\\', '\\\\')), false);
});

test('MCP rejects all Windows UNC separator forms before filesystem access', { skip: process.platform !== 'win32' }, async t => {
  const { call } = await connectText(t);
  const originalStat = fs.lstatSync;
  let networkAccess = 0;
  const stat = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (typeof file === 'string' && file.replaceAll('/', '\\').startsWith('\\\\')) {
      networkAccess++;
      throw Object.assign(new Error('Network access blocked by test'), { code: 'ENOENT' });
    }
    return originalStat(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    for (const file of ['//server/share/note.txt', '\\/server/share/note.txt', '/\\server/share/note.txt', '\\\\server\\share\\note.txt']) {
      assert.equal((await call('filesystem_read', { path: file })).error.code, 'INVALID_PATH', file);
    }
    assert.equal(networkAccess, 0, 'No filesystem traversal of any network path');
  } finally { stat.mock.restore(); syncBuiltinESMExports(); }
});

test('MCP text reads preserve Windows path validation and canonical Skill exceptions', { skip: process.platform !== 'win32' }, async t => {
  const { outside, call } = await connectText(t);
  for (const file of ['\\\\server\\share\\note.txt', '\\\\?\\C:\\note.txt', path.join(outside, 'a.txt:stream'), path.join(outside, 'note.txt.'), path.join(outside, 'CON.txt')]) {
    assert.equal((await call('filesystem_read', { path: file })).error.code, 'INVALID_PATH', file);
  }
  const skill = path.join(outside, '.agents/skills/example/SKILL.md');
  mkdirSync(path.dirname(skill), { recursive: true }); writeFileSync(skill, 'canonical skill', 'utf8');
  const protectedFile = path.join(outside, '.agents/config.toml'); writeFileSync(protectedFile, 'fixture', 'utf8');
  let aliases = 0;
  for (const file of [skill, protectedFile]) {
    // Metadata-only Windows short-name lookup on test-owned paths.
    const result = spawnSync('cmd.exe', ['/d', '/u', '/c', `for %I in ("${file}") do @echo %~sI`], { encoding: 'utf16le', shell: false, windowsHide: true, windowsVerbatimArguments: true });
    assert.equal(result.status, 0, result.stderr);
    const alias = result.stdout.trim();
    if (alias.toLowerCase() === file.toLowerCase()) continue;
    aliases++;
    const read = await call('filesystem_read', { path: alias });
    if (file === skill) {
      assert.equal(read.content, 'canonical skill', JSON.stringify(read));
      assert.equal(read.path, fs.realpathSync.native(skill));
    } else assert.equal(read.error.code, 'PROTECTED_PATH');
  }
  t.diagnostic(`Windows 8.3 alias cases exercised: ${aliases}/2`);
  assert.equal((await call('filesystem_read', { path: path.join(outside, '.agents/skills/../config.toml') })).error.code, 'PROTECTED_PATH');
});

test('MCP rejects a file growing past 256 KiB after its metadata check', async t => {
  const { workspace, call } = await connectText(t);
  const file = path.join(workspace, 'growing.txt');
  writeFileSync(file, 'small', 'utf8');
  const identity = fs.statSync(file);
  const originalStat = fs.fstatSync;
  let grew = false;
  // The OS boundary is injected only to make concurrent growth deterministic.
  // The request and all observable assertions still cross real HTTP/MCP.
  const stat = t.mock.method(fs, 'fstatSync', descriptor => {
    const info = originalStat(descriptor);
    if (!grew && info.dev === identity.dev && info.ino === identity.ino) {
      grew = true;
      fs.appendFileSync(file, Buffer.alloc(256 * 1024, 0x61));
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    const result = await call('filesystem_read', { path: file });
    assert.equal(grew, true);
    assert.equal(result.error?.code, 'FILE_TOO_LARGE');
    assert.equal(result.content, undefined, 'Never return successful truncated or oversized content');
  } finally { stat.mock.restore(); syncBuiltinESMExports(); }
});

test('MCP reads Skill bodies and supporting text, exempting only their configuration component', async t => {
  const { outside, call } = await connectText(t);
  for (const config of ['.agents', '.codex']) {
    for (const name of ['SKILL.md', 'references/example.js', 'templates/no-extension']) {
      const file = path.join(outside, config, 'skills', 'sample', name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '# 学习资料\n只读，不执行。', 'utf8');
      const result = await call('filesystem_read', { path: file });
      assert.equal(result.isError, false, file);
      assert.equal(result.content, '# 学习资料\n只读，不执行。');
    }
    for (const relative of ['config.toml', 'skills-not/a.md', 'skills/sample/.env', 'skills/sample/.codex/config.toml', 'skills/sample/.ssh/note.md', 'skills/sample/credentials/note.md']) {
      const file = path.join(outside, config, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'test fixture, not a credential', 'utf8');
      assert.equal((await call('filesystem_read', { path: file })).error.code, 'PROTECTED_PATH', relative);
    }
  }
});
