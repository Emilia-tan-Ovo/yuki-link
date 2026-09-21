import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, unlinkSync, renameSync, symlinkSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Client } from '../../codex-session-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../codex-session-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { YcaUnit } from '../src/units.js';
import { WindowsHost } from '../src/host.js';
import { Events, run, sleep } from '../src/common.js';
import { latestDeployment, prepareDeployment, readDeployment, selectDeployment, verifyDeployment } from '../src/deployment.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const fixtureNpm = `const fs = require('node:fs');
if (process.argv[2] === 'run' && process.argv[3] === 'build:ui') {
  if (!fs.existsSync('installed.txt')) process.exit(9);
  fs.mkdirSync('dist/harness-ui/.vite', {recursive:true}); fs.mkdirSync('dist/harness-ui/assets', {recursive:true});
  fs.writeFileSync('dist/harness-ui/index.html', '<div id="root"></div>');
  fs.writeFileSync('dist/harness-ui/assets/index-12345678.js', 'export {};');
  fs.writeFileSync('dist/harness-ui/.vite/manifest.json', JSON.stringify({'index.html':{file:'assets/index-12345678.js',isEntry:true}}));
} else fs.writeFileSync('installed.txt', 'dependencies ready');`;
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn) { const deadline = Date.now() + 20_000; do { const value = await fn(); if (value) return value; await sleep(200); } while (Date.now() < deadline); throw Error('Timed out'); }
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yca-deploy-'));
  t.after(() => { assert.ok(directory.startsWith(path.join(os.tmpdir(), 'yca-deploy-'))); rmSync(directory, { recursive: true, force: true }); });
  const repo = path.join(directory, 'developer'); mkdirSync(repo);
  git(repo, 'init', '-b', 'merged'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  const bridge = path.join(repo, 'tools/codex-session-bridge'); mkdirSync(path.join(bridge, 'src'), { recursive: true });
  writeFileSync(path.join(repo, '.gitignore'), 'installed.txt\nnode_modules/\ndist/\n');
  writeFileSync(path.join(bridge, 'package.json'), JSON.stringify({ type: 'module', dependencies: {} }));
  writeFileSync(path.join(bridge, 'package-lock.json'), '{}');
  writeFileSync(path.join(bridge, 'src/main.js'), '// merged entry\n');
  writeFileSync(path.join(bridge, 'src/diagnostics.js'), `export async function toolSummary() { return { count: 14, sha256: '${'a'.repeat(64)}' }; }`);
  writeFileSync(path.join(bridge, 'src/source.js'), 'export const deploymentProtocol = 1;');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  const remote = path.join(directory, 'remote.git'); git(directory, 'clone', '--bare', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote);
  const npmCli = path.join(directory, 'npm-cli.cjs');
  writeFileSync(npmCli, fixtureNpm);
  const root = path.join(directory, 'deployment');
  return { directory, repo, remote, root, bridge, npmCli, options: { repo, root, node: process.execPath, npmCli } };
}

test('prepare follows remote HEAD beside a dirty developer branch and reuses one immutable release', async t => {
  const f = fixture(t), commit = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'switch', '-c', 'unfinished');
  writeFileSync(path.join(f.bridge, 'src/main.js'), '// uncommitted work\n');
  const before = git(f.repo, 'status', '--porcelain');
  const first = await prepareDeployment(f.options);
  assert.equal(first.commit, commit); assert.equal(first.branch, 'merged'); assert.equal(first.dependencies, 'installed');
  assert.equal(readFileSync(first.entry, 'utf8').trim(), '// merged entry');
  const second = await prepareDeployment(f.options);
  assert.equal(second.entry, first.entry); assert.equal(second.dependencies, 'reused');
  assert.equal((await readDeployment(f.root)).commit, commit);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'unfinished');
  assert.equal(git(f.repo, 'status', '--porcelain'), before);
  assert.equal(readFileSync(path.join(f.bridge, 'src/main.js'), 'utf8'), '// uncommitted work\n');
});

test('remote default branch changes create a new release and preserve the previous source', async t => {
  const f = fixture(t), first = await prepareDeployment(f.options);
  assert.deepEqual(await latestDeployment(f.repo), { branch: 'merged', commit: first.commit });
  git(f.repo, 'switch', '-c', 'new-default');
  writeFileSync(path.join(f.bridge, 'src/main.js'), '// second release\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'second');
  git(f.repo, 'push', 'origin', 'new-default'); git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/new-default');
  const remote = await latestDeployment(f.repo);
  assert.equal(remote.branch, 'new-default'); assert.equal(remote.commit, git(f.repo, 'rev-parse', 'HEAD'));
  const second = await prepareDeployment(f.options);
  assert.equal(second.branch, 'new-default'); assert.notEqual(second.commit, first.commit);
  assert.equal(readFileSync(first.entry, 'utf8').trim(), '// merged entry');
  assert.equal(readFileSync(second.entry, 'utf8').trim(), '// second release');
  await selectDeployment(f.root, first.commit);
  assert.equal((await readDeployment(f.root)).commit, first.commit);
  await assert.rejects(selectDeployment(f.root, 'f'.repeat(40)));
  assert.equal((await readDeployment(f.root)).commit, first.commit);
});

test('UI production artifacts are built after dependencies and sealed against missing, changed or added bytes', async t => {
  const f = fixture(t), prepared = await prepareDeployment(f.options);
  assert.match(prepared.uiHash, /^[a-f0-9]{64}$/);
  const artifact = path.join(prepared.cwd, 'dist/harness-ui/assets/index-12345678.js');
  const original = readFileSync(artifact, 'utf8');
  writeFileSync(artifact, 'tampered');
  await assert.rejects(readDeployment(f.root), { code: 'DEPLOYMENT_UI_CHANGED' });
  await assert.rejects(verifyDeployment(f.root), { code: 'DEPLOYMENT_UI_CHANGED' });
  writeFileSync(artifact, original); assert.equal((await readDeployment(f.root)).uiHash, prepared.uiHash);
  const extra = path.join(prepared.cwd, 'dist/harness-ui/assets/extra.js'); writeFileSync(extra, 'extra');
  await assert.rejects(readDeployment(f.root), { code: 'DEPLOYMENT_UI_CHANGED' }); unlinkSync(extra);
  unlinkSync(artifact); await assert.rejects(readDeployment(f.root), { code: 'DEPLOYMENT_UI_CHANGED' });
});

test('failed UI build cannot publish a release or change selection', async t => {
  const f = fixture(t), first = await prepareDeployment(f.options);
  writeFileSync(path.join(f.bridge, 'src/main.js'), '// next release\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'next'); git(f.repo, 'push', 'origin', 'merged');
  writeFileSync(f.npmCli, "if (process.argv[2] === 'run') process.exit(1);");
  await assert.rejects(prepareDeployment(f.options), { code: 'DEPLOYMENT_UI_BUILD_FAILED' });
  assert.equal((await readDeployment(f.root)).commit, first.commit);
});

test('dependency failure preserves selection and can retry only the owned unpublished checkout', async t => {
  const f = fixture(t), first = await prepareDeployment(f.options);
  writeFileSync(path.join(f.bridge, 'src/main.js'), '// second release\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'second'); git(f.repo, 'push', 'origin', 'merged');
  writeFileSync(f.npmCli, 'process.exit(1);');
  await assert.rejects(prepareDeployment(f.options), { code: 'DEPLOYMENT_DEPENDENCIES_FAILED' });
  assert.equal((await readDeployment(f.root)).commit, first.commit);
  writeFileSync(f.npmCli, fixtureNpm);
  const second = await prepareDeployment(f.options);
  assert.notEqual(second.commit, first.commit);
});

test('unknown directories, dirty published checkouts and concurrent updates are refused', async t => {
  const f = fixture(t);
  mkdirSync(f.root); writeFileSync(path.join(f.root, 'user-data.txt'), 'keep');
  await assert.rejects(prepareDeployment(f.options), { code: 'DEPLOYMENT_NOT_OWNED' });
  assert.equal(readFileSync(path.join(f.root, 'user-data.txt'), 'utf8'), 'keep');
  const root = path.join(f.directory, 'owned');
  const prepared = await prepareDeployment({ ...f.options, root });
  writeFileSync(prepared.entry, '// operator change');
  await assert.rejects(prepareDeployment({ ...f.options, root }), { code: 'DEPLOYMENT_CHANGED' });
  writeFileSync(path.join(root, 'prepare.lock'), 'unknown owner');
  await assert.rejects(prepareDeployment({ ...f.options, root }), { code: 'DEPLOYMENT_BUSY' });
});

test('a lost manifest never authorizes reinstalling dependencies in a published release', async t => {
  const f = fixture(t), prepared = await prepareDeployment(f.options);
  unlinkSync(path.join(f.root, 'manifests', prepared.commit + '.json'));
  await assert.rejects(prepareDeployment(f.options), { code: 'DEPLOYMENT_INCOMPLETE' });
});

test('runtime without deployment provenance support is rejected before it can be selected', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.bridge, 'src/source.js'), 'export const deploymentProtocol = 0;');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'unsupported'); git(f.repo, 'push', 'origin', 'merged');
  await assert.rejects(prepareDeployment(f.options), { code: 'DEPLOYMENT_PROTOCOL_UNSUPPORTED' });
});

test('a replaced releases directory is refused before checkout writes outside the owned root', async t => {
  const f = fixture(t); await prepareDeployment(f.options);
  const releases = path.join(f.root, 'releases'), outside = path.join(f.directory, 'outside');
  mkdirSync(outside); renameSync(releases, path.join(f.root, 'original-releases'));
  symlinkSync(outside, releases, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(path.join(f.repo, 'next.txt'), 'next'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'next'); git(f.repo, 'push', 'origin', 'merged');
  await assert.rejects(prepareDeployment(f.options), { code: 'DEPLOYMENT_LINK_REFUSED' });
  assert.deepEqual(readdirSync(outside), []);
});

test('real deployed YCA reports the target commit and YCA-002 contract; preparation leaves it running', { skip: process.platform !== 'win32', timeout: 90_000 }, async t => {
  const f = fixture(t);
  const actual = fileURLToPath(new URL('../../codex-session-bridge/', import.meta.url));
  cpSync(path.join(actual, 'src'), path.join(f.bridge, 'src'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.ui.json']) cpSync(path.join(actual, name), path.join(f.bridge, name));
  cpSync(path.join(actual, 'ui'), path.join(f.bridge, 'ui'), { recursive: true });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'real YCA'); git(f.repo, 'push', 'origin', 'merged');
  const options = { ...f.options, npmCli: path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') };
  const first = await prepareDeployment(options);
  const workspace = path.join(f.directory, 'workspace'); mkdirSync(workspace);
  const controlRoot = path.join(f.directory, 'private-control'); mkdirSync(controlRoot);
  writeFileSync(path.join(controlRoot, 'config.json'), '{"local":"private"}');
  const pwsh = process.env.CC_TEST_PWSH ?? (await run('pwsh.exe', ['-NoProfile', '-Command', '[Console]::Write((Get-Process -Id $PID).Path)'])).output.trim();
  const config = { node: process.execPath, pwsh, codex: process.execPath, entry: path.join(f.bridge, 'src/main.js'), cwd: f.bridge,
    repo: workspace, runtime: path.join(f.directory, 'service'), deploymentRoot: f.root, controlRoots: [controlRoot], port: await port(), controlPort: await port() };
  const state = {}, host = new WindowsHost(pwsh), events = new Events(f.directory);
  let unit = new YcaUnit(config, host, state, () => {}, events);
  const client = new Client({ name: 'deployment-acceptance', version: '1' });
  try {
    await unit.start();
    const running = await until(async () => { const o = await unit.observe(); return o.healthy && o; });
    assert.equal(running.deployment.state, 'verified'); assert.equal(running.deployment.running.commit, first.commit);
    assert.equal(running.tools.sha256, first.tools.sha256);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`)));
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'filesystem_read');
    assert.match(tool.description, /outside read roots/);
    const outside = path.join(f.directory, 'outside.txt'); writeFileSync(outside, '区外 UTF-8 样本\r\n');
    const result = await client.callTool({ name: 'filesystem_read', arguments: { path: outside } });
    assert.notEqual(result.isError, true); assert.match(JSON.stringify(result), /区外 UTF-8 样本/);
    const protectedResult = await client.callTool({ name: 'filesystem_read', arguments: { path: path.join(controlRoot, 'config.json') } });
    assert.equal(protectedResult.isError, true); assert.match(JSON.stringify(protectedResult), /PROTECTED_PATH/);
    writeFileSync(path.join(config.runtime, 'history-marker.txt'), 'preserved history');
    const mcpFile = path.join(f.bridge, 'src/mcp.js');
    const mcpSource = readFileSync(mcpFile, 'utf8');
    assert.match(mcpSource, /  return server;\r?\n}/);
    writeFileSync(mcpFile, mcpSource.replace(/  return server;\r?\n}/,
      "  register('observe', 'deployment_test_marker', 'Deployment lifecycle test marker.', {}, () => ({ marker: true }), true);\n  return server;\n}"));
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'next'); git(f.repo, 'push', 'origin', 'merged');
    const second = await prepareDeployment(options);
    assert.equal(second.tools.count, first.tools.count + 1); assert.notEqual(second.tools.sha256, first.tools.sha256);
    unit = new YcaUnit(config, host, state, () => {}, events); // manager reconstruction retains the old entry
    const pending = await unit.observe();
    assert.equal(pending.pid, running.pid); assert.equal(pending.owned, true); assert.equal(pending.deployment.state, 'update-pending');
    assert.equal(pending.deployment.running.commit, first.commit); assert.equal(pending.deployment.target.commit, second.commit);
    assert.equal(pending.tools.sha256, first.tools.sha256, 'prepared candidate must not replace running tool evidence');
    await client.close(); await unit.stop();
    await unit.start({ recovery: true });
    const recovered = await until(async () => { const o = await unit.observe(); return o.healthy && o; });
    assert.equal(recovered.deployment.running.commit, first.commit);
    await unit.stop(); await unit.start();
    const switched = await until(async () => { const o = await unit.observe(); return o.healthy && o; });
    assert.equal(switched.deployment.running.commit, second.commit);
    assert.equal(switched.tools.sha256, second.tools.sha256);
    const switchedClient = new Client({ name: 'deployment-switched', version: '1' });
    try {
      await switchedClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`)));
      assert.ok((await switchedClient.listTools()).tools.some(tool => tool.name === 'deployment_test_marker'));
    } finally { await switchedClient.close(); }
    assert.equal(readFileSync(path.join(config.runtime, 'history-marker.txt'), 'utf8'), 'preserved history');
  } finally { await client.close(); await unit.stop(); }
});
