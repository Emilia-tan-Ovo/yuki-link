import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, linkSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ComputerTools } from '../src/computer/tools.js';
import { createHttpServer } from '../src/http.js';
import { spawnSync } from 'node:child_process';
import { PathPolicy } from '../src/computer/paths.js';
import { fileURLToPath } from 'node:url';

async function connect(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-computer-'));
  const workspace = path.join(root, '工作区 空格'); mkdirSync(workspace);
  const readOnly = path.join(root, '只读'); mkdirSync(readOnly);
  const computer = new ComputerTools({ readRoots: [workspace, readOnly], writeRoots: [workspace], runtime: path.join(root, 'runtime') });
  const manager = { closing: false, catalog: { list() { throw Error('Codex unavailable'); } } };
  const server = createHttpServer(manager, computer);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'computer-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  t.after(async () => { await client.close(); await computer.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); rmSync(root, { recursive: true, force: true }); });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    let value = result.structuredContent;
    if (!value) { try { value = JSON.parse(result.content[0].text); } catch { value = { message: result.content[0].text }; } }
    return { ...value, isError: result.isError === true };
  };
  return { root, workspace, readOnly, call, client };
}

test('MCP directly queries PowerShell 7 even when Codex is unavailable', async t => {
  const { workspace, call } = await connect(t);
  const version = await call('powershell', { cwd: workspace, query: 'version' });
  assert.equal(version.isError, false);
  assert.equal(version.exit_code, 0);
  assert.match(version.data.version, /^7\./);
  const location = await call('powershell', { cwd: workspace, query: 'location' });
  assert.equal(location.isError, false);
  assert.equal(location.data.path, workspace);
  const bad = await call('powershell', { cwd: workspace, query: 'Remove-Item' });
  assert.equal(bad.isError, true);
});

test('MCP creates, reads, updates with a hash, lists and moves a UTF-8 workspace file', async t => {
  const { workspace, call } = await connect(t);
  const file = path.join(workspace, '问候 [1].txt');
  const content = '艾米莉亚碳 → 希尔薇酱 🌸\r\n"双引号" \'单引号\' $HOME `tick` C:\\中文 路径\\a.txt';
  const written = await call('filesystem_write', { path: file, content });
  assert.equal(written.isError, false);
  assert.equal(readFileSync(file, 'utf8'), content);
  const read = await call('filesystem_read', { path: file });
  assert.equal(read.content, content); assert.equal(read.sha256, written.sha256);
  const list = await call('filesystem_list', { path: workspace });
  assert.ok(list.entries.some(e => e.name === '问候 [1].txt'));
  const collision = await call('filesystem_write', { path: file, content: 'overwrite' });
  assert.equal(collision.error.code, 'FILE_EXISTS');
  const conflict = await call('filesystem_write', { path: file, content: 'overwrite', expected_sha256: '0'.repeat(64) });
  assert.equal(conflict.error.code, 'CONTENT_CONFLICT');
  const update = await call('filesystem_write', { path: file, content: '第二版', expected_sha256: read.sha256 });
  assert.equal(update.isError, false); assert.equal(readFileSync(file, 'utf8'), '第二版');
  const destination = path.join(workspace, '已移动.txt');
  const moved = await call('filesystem_move', { source: file, destination, expected_sha256: update.sha256 });
  assert.equal(moved.isError, false); assert.equal(existsSync(file), false);
  assert.equal(readFileSync(destination, 'utf8'), '第二版');
});

test('filesystem denies out-of-root, read-only writes, credentials, links and overwrite moves', async t => {
  const { root, workspace, readOnly, call } = await connect(t);
  const publicFile = path.join(readOnly, 'public.txt'); writeFileSync(publicFile, '只读资料', 'utf8');
  assert.equal((await call('filesystem_read', { path: publicFile })).content, '只读资料');
  assert.equal((await call('filesystem_write', { path: publicFile, content: '改写' })).error.code, 'PATH_NOT_ALLOWED');
  const outside = path.join(root, 'outside.txt'); writeFileSync(outside, 'outside', 'utf8');
  assert.equal((await call('filesystem_read', { path: outside })).error.code, 'PATH_NOT_ALLOWED');
  const key = path.join(workspace, '.env'); writeFileSync(key, 'TEST_ONLY=placeholder', 'utf8');
  assert.equal((await call('filesystem_read', { path: key })).error.code, 'PROTECTED_PATH');
  const secretDirectory = path.join(workspace, 'select-key'); mkdirSync(secretDirectory);
  assert.equal((await call('filesystem_list', { path: workspace })).entries.some(e => e.name === 'select-key'), false);
  const link = path.join(workspace, 'escape'); symlinkSync(readOnly, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('filesystem_read', { path: path.join(link, 'public.txt') })).error.code, 'LINK_NOT_ALLOWED');
  const hardlink = path.join(workspace, 'hardlink.txt'); linkSync(outside, hardlink);
  assert.equal((await call('filesystem_read', { path: hardlink })).error.code, 'LINK_NOT_ALLOWED');
  const source = path.join(workspace, 'source.txt');
  const destination = path.join(workspace, 'destination.txt');
  const written = await call('filesystem_write', { path: source, content: 'source' });
  writeFileSync(destination, 'keep', 'utf8');
  assert.equal((await call('filesystem_move', { source, destination, expected_sha256: written.sha256 })).error.code, 'FILE_EXISTS');
  assert.equal(readFileSync(destination, 'utf8'), 'keep'); assert.equal(readFileSync(source, 'utf8'), 'source');
  const credentialLike = path.join(workspace, 'ordinary.txt');
  const sample = 'sk-' + 'TESTONLY'.repeat(5);
  writeFileSync(credentialLike, sample, 'utf8');
  assert.equal((await call('filesystem_read', { path: credentialLike })).error.code, 'SENSITIVE_CONTENT');
  const audit = readFileSync(path.join(root, 'runtime', 'computer-audit.jsonl'), 'utf8');
  assert.equal(audit.includes(sample), false); assert.equal(audit.includes('只读资料'), false);
});

test('git status and a literal file diff are read-only MCP operations', async t => {
  const { workspace, call } = await connect(t);
  const git = args => { const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', shell: false, windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '--quiet']);
  const file = path.join(workspace, '笔记 [1].txt'); writeFileSync(file, 'before\n', 'utf8');
  git(['add', '--', '笔记 [1].txt']);
  git(['-c', 'user.name=Bridge Test', '-c', 'user.email=bridge@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  writeFileSync(file, 'after\n', 'utf8');
  const status = await call('git_status', { cwd: workspace });
  assert.equal(status.isError, false); assert.ok(status.stdout.includes('笔记 [1].txt'));
  const diff = await call('git_diff', { cwd: workspace, path: file });
  assert.equal(diff.isError, false); assert.ok(diff.stdout.includes('-before')); assert.ok(diff.stdout.includes('+after'));
  const directoryDiff = await call('git_diff', { cwd: workspace, path: workspace });
  assert.equal(directoryDiff.error.code, 'NOT_A_FILE');
  assert.equal(readFileSync(file, 'utf8'), 'after\n');
  // A benign configured clean filter writes only a fixture marker. Ordinary
  // Git invokes it; our read-only queries must explicitly suppress it.
  const marker = path.join(workspace, 'filter-ran.txt');
  const script = path.join(workspace, 'filter.cjs');
  writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(fs.readFileSync(0));`, 'utf8');
  writeFileSync(path.join(workspace, '.gitattributes'), '*.txt filter=probe\n', 'utf8');
  git(['config', 'filter.probe.clean', `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`]);
  git(['diff', '--no-ext-diff', '--no-textconv', '--', '笔记 [1].txt']);
  assert.equal(existsSync(marker), true, 'fixture proves native Git invokes the filter');
  rmSync(marker);
  assert.equal((await call('git_status', { cwd: workspace })).isError, false);
  assert.equal((await call('git_diff', { cwd: workspace, path: file })).isError, false);
  assert.equal(existsSync(marker), false, 'read-only queries must not invoke clean filters');
  git(['config', 'filter.probe.process', `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`]);
  git(['config', 'filter.probe.required', 'true']);
  assert.equal((await call('git_status', { cwd: workspace })).isError, false);
  assert.equal((await call('git_diff', { cwd: workspace, path: file })).isError, false);
  assert.equal(existsSync(marker), false, 'required process filters must also remain disabled');
});

test('Windows short names cannot bypass protected installation or Git paths', { skip: process.platform !== 'win32' }, t => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const policy = new PathPolicy([repository], [repository], path.join(repository, 'tools/codex-session-bridge/runtime'));
  // Existing short names are probed as metadata only; no protected content is read.
  const aliases = [
    path.join(repository, 'tools/CODEX-~1/src/computer/query.ps1'),
    path.join(repository, 'tools/CODEX-~1/src/computer/new-test-file.txt'),
    path.join(repository, 'GIT~1/config'),
  ];
  let exercised = 0;
  for (const alias of aliases) {
    if (!existsSync(path.dirname(alias))) continue;
    assert.throws(() => policy.resolve(alias, { write: true, missing: true }), { code: 'PROTECTED_PATH' });
    exercised++;
  }
  if (exercised === 0) t.skip('Volume does not expose the known 8.3 aliases');
});
