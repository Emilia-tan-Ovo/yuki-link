import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bytes, hash, digest, fail, safePath, relativeName, readJson, tree, inside } from './files.js';

export const sourceRelative = '.workflow/skills';
export const toolRelative = 'tools/workflow-skills';
export const names = ['pair-with-docs', 'to-spec', 'to-tickets', 'ticket-design', 'implement', 'code-review', 'engineering-workflow', 'review-change'];
const ownRoot = fileURLToPath(new URL('../', import.meta.url));
function gitIdentity(repo) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory) || inside(repo, directory)) continue;
    const file = path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    if (!fs.existsSync(file)) continue;
    // Trusted executable discovery is distinct from managed installation paths:
    // packaged Git binaries may legitimately be linked. Bind the resolved binary.
    const executable = fs.realpathSync.native(file);
    if (!fs.statSync(executable).isFile() || inside(repo, executable)) continue;
    return { path: executable, sha256: hash(fs.readFileSync(executable)) };
  }
  throw fail('GIT_UNAVAILABLE');
}
function git(executable, repo, ...args) {
  // Provenance must read the recorded objects, not local refs/replace substitutes.
  return execFileSync(executable, ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], {
    cwd: repo, shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function committed(executable, repo, commit, files, selection) {
  const tracked = git(executable, repo, 'ls-tree', '-r', '--name-only', '-z', commit, '--', `${sourceRelative}/manifest.json`,
    ...selection.map(name => `${sourceRelative}/${name}`), `${toolRelative}/src`, `${toolRelative}/package.json`).toString('utf8').split('\0').filter(Boolean).sort();
  if (JSON.stringify(tracked) !== JSON.stringify(files.map(file => file.path).sort())) return false;
  return files.every(file => {
    try { return hash(git(executable, repo, 'cat-file', 'blob', `${commit}:${file.path}`)) === file.sha256; }
    catch { return false; }
  });
}
export function sourceState(input, selection, expectedTool) {
  const repo = safePath(input);
  if (safePath(ownRoot).toLowerCase() !== safePath(path.join(repo, toolRelative)).toLowerCase()) throw fail('TOOL_SOURCE_MISMATCH');
  if (!Array.isArray(selection) || !selection.length || new Set(selection).size !== selection.length || selection.some(name => !names.includes(name))) throw fail('INVALID_SELECTION');
  selection = [...selection].sort();
  const sourceRoot = path.join(repo, sourceRelative);
  const manifestFile = path.join(sourceRoot, 'manifest.json');
  const manifest = readJson(manifestFile);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.skills) || manifest.skills.length !== names.length
    || new Set(manifest.skills.map(skill => skill.name)).size !== names.length) throw fail('INVALID_MANIFEST');
  for (const skill of manifest.skills) {
    if (!names.includes(skill.name) || typeof skill.installable !== 'boolean' || !Array.isArray(skill.files) || !skill.files.includes('SKILL.md')) throw fail('INVALID_MANIFEST');
    skill.files.forEach(relativeName);
    if (new Set(skill.files.map(file => file.toLowerCase())).size !== skill.files.length) throw fail('CASE_COLLISION');
  }
  const files = [];
  for (const name of selection) {
    const skill = manifest.skills.find(item => item.name === name);
    if (!skill.installable) throw fail('NOT_INSTALLABLE', { skill: name });
    const actual = tree(path.join(sourceRoot, name)).filter(entry => entry.type === 'file');
    if (JSON.stringify(actual.map(entry => entry.path).sort()) !== JSON.stringify([...skill.files].sort())) throw fail('SOURCE_FILE_SET');
    for (const entry of actual) files.push({ path: `${name}/${entry.path}`, sha256: entry.sha256, size: entry.size });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const toolFiles = [{ path: 'package.json', sha256: hash(bytes(path.join(ownRoot, 'package.json'))) },
    ...tree(path.join(ownRoot, 'src')).filter(file => file.type === 'file').map(file => ({ path: 'src/' + file.path, sha256: file.sha256 }))];
  const tool = { root: safePath(ownRoot), files: toolFiles, git: gitIdentity(repo), node: { path: process.execPath, version: process.version } };
  tool.digest = digest(tool);
  if (expectedTool && digest(tool) !== digest(expectedTool)) throw fail('TOOL_CHANGED');
  const commit = git(tool.git.path, repo, 'rev-parse', 'HEAD').toString('utf8').trim();
  const manifestHash = hash(bytes(manifestFile));
  const managed = [{ path: `${sourceRelative}/manifest.json`, sha256: manifestHash },
    ...files.map(file => ({ path: `${sourceRelative}/${file.path}`, sha256: file.sha256 })),
    ...toolFiles.map(file => ({ path: `${toolRelative}/${file.path}`, sha256: file.sha256 }))];
  return {
    source: { repo, commit, selection, manifest_sha256: manifestHash, files, digest: digest({ manifestHash, files }), clean: committed(tool.git.path, repo, commit, managed, selection) },
    tool,
  };
}
