import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { fail, readJson, saveJson, run } from './common.js';

const bridgePath = 'tools/codex-session-bridge';
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function uiArtifactHash(cwd) {
  const root = path.join(cwd, 'dist/harness-ui');
  try {
    noLinks(root);
    const digest = createHash('sha256'), files = [];
    function walk(directory) {
      for (const name of readdirSync(directory).sort()) {
        const file = path.join(directory, name), stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw fail('DEPLOYMENT_UI_CHANGED');
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile() && stat.nlink === 1) files.push(file);
        else throw fail('DEPLOYMENT_UI_CHANGED');
      }
    }
    walk(root);
    const relative = files.map(file => path.relative(root, file).replaceAll('\\', '/'));
    if (!relative.includes('index.html') || !relative.includes('.vite/manifest.json') || !relative.some(p => p.startsWith('assets/'))) throw fail('DEPLOYMENT_UI_CHANGED');
    for (let i = 0; i < files.length; i++) digest.update(relative[i] + '\0' + hash(files[i]) + '\n');
    return digest.digest('hex');
  } catch { throw fail('DEPLOYMENT_UI_CHANGED'); }
}
function noLinks(file) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw fail('DEPLOYMENT_LINK_REFUSED'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
}
function ownedRoot(root, remote) {
  noLinks(root);
  for (const name of ['owner.json', 'repository.git', 'releases', 'builds', 'manifests', 'selected.json']) noLinks(path.join(root, name));
  const owner = readJson(path.join(root, 'owner.json'), {});
  if (owner.kind !== 'yca-deployment-v1' || owner.root !== root || (remote && owner.remote !== remote)) throw fail('DEPLOYMENT_NOT_OWNED');
  return owner;
}
async function cleanRelease(root, commit) {
  const release = path.join(root, 'releases', commit);
  noLinks(release); noLinks(path.join(release, bridgePath, 'node_modules'));
  const common = await git(release, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (realpathSync(common) !== realpathSync(path.join(root, 'repository.git'))
      || await git(release, 'rev-parse', 'HEAD') !== commit
      || await git(release, 'status', '--porcelain', '--untracked-files=all')) throw fail('DEPLOYMENT_CHANGED');
}
async function command(executable, args, cwd, code, timeout = 120_000) {
  const result = await run(executable, args, { cwd, timeout, limit: 2 * 1024 * 1024 });
  if (result.code !== 0) throw fail(code);
  return result.output.trim();
}
const git = (cwd, ...args) => command('git', ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], cwd, 'DEPLOYMENT_GIT_FAILED');

async function deploymentSource(repo) {
  repo = path.resolve(repo);
  const remote = await git(repo, 'remote', 'get-url', 'origin');
  const head = await git(repo, 'ls-remote', '--symref', remote, 'HEAD');
  const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(head)?.[1];
  const commit = /^([a-f0-9]{40})\s+HEAD$/m.exec(head)?.[1];
  if (!branch) throw fail('DEPLOYMENT_DEFAULT_BRANCH_UNKNOWN');
  if (!sha(commit)) throw fail('DEPLOYMENT_INVALID');
  return { remote, branch, commit };
}

export async function latestDeployment(repo) {
  const { branch, commit } = await deploymentSource(repo);
  return { branch, commit };
}

async function probe(node, cwd) {
  const source = pathToFileURL(path.join(cwd, 'src/source.js')).href;
  await command(node, ['--input-type=module', '-e', `const source=await import(${JSON.stringify(source)}); if(source.deploymentProtocol!==1) process.exit(1);`], cwd, 'DEPLOYMENT_PROTOCOL_UNSUPPORTED');
  const url = pathToFileURL(path.join(cwd, 'src/diagnostics.js')).href;
  const output = await command(node, ['--input-type=module', '-e', `const {toolSummary}=await import(${JSON.stringify(url)}); console.log(JSON.stringify(await toolSummary()));`], cwd, 'DEPLOYMENT_PROBE_FAILED');
  let tools;
  try { tools = JSON.parse(output); } catch { throw fail('DEPLOYMENT_PROBE_FAILED'); }
  if (!Number.isInteger(tools.count) || tools.count < 1 || !/^[a-f0-9]{64}$/.test(tools.sha256 ?? '')) throw fail('DEPLOYMENT_PROBE_FAILED');
  return tools;
}

async function probeLauncherFlags(node, cwd) {
  const result = await run(node, [path.join(cwd, 'src/main.js'), '--help'], { cwd, timeout: 15_000, limit: 64 * 1024 });
  if (result.code !== 0) throw fail('DEPLOYMENT_LAUNCHER_PROBE_FAILED');
  return {
    implementationLaunchAuthority: result.output.includes('--implementation-launch-authority ABSOLUTE_JSON_PATH'),
    reviewLaunchAuthority: result.output.includes('--review-launch-authority ABSOLUTE_JSON_PATH'),
  };
}

export async function readDeployment(root, commit) {
  root = path.resolve(root);
  ownedRoot(root);
  commit ??= readJson(path.join(root, 'selected.json')).commit;
  if (!sha(commit)) throw fail('DEPLOYMENT_INVALID');
  const release = path.join(root, 'releases', commit), cwd = path.join(release, bridgePath);
  noLinks(path.join(root, 'manifests', commit + '.json'));
  const manifest = readJson(path.join(root, 'manifests', commit + '.json'));
  if (manifest.commit !== commit || manifest.entry !== path.join(cwd, 'src/main.js') || manifest.cwd !== cwd
      || manifest.lockHash !== hash(path.join(cwd, 'package-lock.json'))) throw fail('DEPLOYMENT_CHANGED');
  if (!/^[a-f0-9]{64}$/.test(manifest.uiHash ?? '') || manifest.uiHash !== uiArtifactHash(cwd)) throw fail('DEPLOYMENT_UI_CHANGED');
  await cleanRelease(root, commit);
  return manifest;
}

export function deploymentTarget(root) {
  ownedRoot(path.resolve(root));
  const { commit } = readJson(path.join(root, 'selected.json'));
  if (!sha(commit)) throw fail('DEPLOYMENT_INVALID');
  const manifest = readJson(path.join(root, 'manifests', commit + '.json'));
  return { commit, tools: manifest.tools };
}

export async function verifyDeployment(root, commit, node = process.execPath) {
  const manifest = await readDeployment(root, commit);
  const version = await command(node, ['--version'], manifest.cwd, 'DEPLOYMENT_NODE_UNSUPPORTED');
  if (Number(/^v(\d+)\./.exec(version)?.[1]) !== manifest.nodeMajor) throw fail('DEPLOYMENT_NODE_CHANGED');
  if (JSON.stringify(await probe(node, manifest.cwd)) !== JSON.stringify(manifest.tools)) throw fail('DEPLOYMENT_PROBE_FAILED');
  if (manifest.launcherFlags) {
    const observed = await probeLauncherFlags(node, manifest.cwd);
    for (const [flag, supported] of Object.entries(manifest.launcherFlags)) {
      if (observed[flag] !== supported) throw fail('DEPLOYMENT_LAUNCHER_CHANGED');
    }
  }
  return { ...manifest, launcherFlags: {
    implementationLaunchAuthority: manifest.launcherFlags?.implementationLaunchAuthority === true,
    reviewLaunchAuthority: manifest.launcherFlags?.reviewLaunchAuthority === true,
  } };
}

function claimPreparation(root) {
  const lock = path.join(root, 'prepare.lock');
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', encoding: 'utf8' }); }
  catch (e) { if (e.code === 'EEXIST') throw fail('DEPLOYMENT_BUSY'); throw e; }
  return lock;
}

export async function selectDeployment(root, commit, node = process.execPath) {
  root = path.resolve(root); ownedRoot(root);
  const lock = claimPreparation(root);
  try {
    const manifest = await verifyDeployment(root, commit, node);
    saveJson(path.join(root, 'selected.json'), { commit });
    return { ...manifest, dependencies: 'reused' };
  } finally { unlinkSync(lock); }
}

// Preparing never stops a service or rewrites a published release. Selection is
// consumed only at a subsequent Control Center start; the old process stays put.
export async function prepareDeployment({ repo, root, node = process.execPath, npmCli = path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js') }) {
  repo = path.resolve(repo); root = path.resolve(root);
  noLinks(root);
  const { remote, branch, commit } = await deploymentSource(repo);
  if (!existsSync(root)) {
    mkdirSync(path.dirname(root), { recursive: true });
    // Exclusive creation prevents two first-time preparers claiming one root.
    try { mkdirSync(root); } catch (e) { if (e.code === 'EEXIST') throw fail('DEPLOYMENT_BUSY'); throw e; }
    saveJson(path.join(root, 'owner.json'), { kind: 'yca-deployment-v1', root, remote });
  }
  ownedRoot(root, remote);
  const lock = claimPreparation(root);
  let uncertain = false;
  try {
    const bare = path.join(root, 'repository.git');
    noLinks(bare);
    if (!existsSync(bare)) await git(root, 'clone', '--bare', '--', remote, bare);
    if (await git(bare, 'remote', 'get-url', 'origin') !== remote) throw fail('DEPLOYMENT_NOT_OWNED');
    await git(bare, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/deployment/default`);
    try { await git(bare, 'cat-file', '-e', `${commit}^{commit}`); }
    catch { throw fail('DEPLOYMENT_SOURCE_CHANGED'); }
    const release = path.join(root, 'releases', commit), cwd = path.join(release, bridgePath);
    const manifestFile = path.join(root, 'manifests', commit + '.json');
    const buildFile = path.join(root, 'builds', commit + '.json');
    for (const file of [release, manifestFile, buildFile]) noLinks(file);
    let manifest, dependencies;
    if (existsSync(manifestFile)) {
      manifest = await verifyDeployment(root, commit, node);
      dependencies = 'reused';
    } else {
      mkdirSync(path.dirname(release), { recursive: true });
      if (!existsSync(release)) {
        saveJson(buildFile, { commit, stage: 'building' });
        await git(bare, 'worktree', 'add', '--detach', release, commit);
      } else if (readJson(buildFile, {}).stage !== 'building') throw fail('DEPLOYMENT_INCOMPLETE');
      await cleanRelease(root, commit);
      await command(node, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd, 'DEPLOYMENT_DEPENDENCIES_FAILED');
      await command(node, [npmCli, 'run', 'build:ui'], cwd, 'DEPLOYMENT_UI_BUILD_FAILED');
      const version = await command(node, ['--version'], cwd, 'DEPLOYMENT_NODE_UNSUPPORTED');
      const nodeMajor = Number(/^v(\d+)\./.exec(version)?.[1]);
      if (nodeMajor < 24 || !Number.isInteger(nodeMajor)) throw fail('DEPLOYMENT_NODE_UNSUPPORTED');
      manifest = { version: 1, commit, branch, cwd, entry: path.join(cwd, 'src/main.js'), lockHash: hash(path.join(cwd, 'package-lock.json')),
        tools: await probe(node, cwd), launcherFlags: await probeLauncherFlags(node, cwd), nodeMajor, uiHash: uiArtifactHash(cwd) };
      await cleanRelease(root, commit);
      saveJson(buildFile, { commit, stage: 'published' });
      saveJson(manifestFile, manifest);
      await readDeployment(root, commit);
      dependencies = 'installed';
    }
    saveJson(path.join(root, 'selected.json'), { commit });
    return { ...manifest, dependencies };
    } catch (e) {
    // A timed-out Git/npm child may have descendants. Keep the lock as evidence;
    // no subsequent invocation may mutate this checkout until operator review.
    uncertain = ['COMMAND_TIMEOUT', 'OUTPUT_LIMIT'].includes(e.code);
    throw e;
  } finally { if (!uncertain) unlinkSync(lock); }
}
