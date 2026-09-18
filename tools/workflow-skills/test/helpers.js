import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
export const gitExecutable = (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
  .map(directory => path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git')).find(existsSync);
assert.ok(gitExecutable, 'Git must be available on an absolute PATH entry');
export const toolRelative = 'tools/workflow-skills';
export function git(repo, ...args) {
  const result = spawnSync(gitExecutable, ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], {
    cwd: repo, encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
export function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-skills-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'workflow-skills-')));
    rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, '仓库 [1]');
  const target = path.join(root, '用户 空间', '.agents', 'skills');
  mkdirSync(repo); mkdirSync(target, { recursive: true });
  cpSync(path.join(repository, '.workflow'), path.join(repo, '.workflow'), { recursive: true });
  const tool = path.join(repo, toolRelative);
  mkdirSync(tool, { recursive: true });
  cpSync(path.join(repository, toolRelative, 'package.json'), path.join(tool, 'package.json'));
  if (existsSync(path.join(repository, toolRelative, 'src'))) cpSync(path.join(repository, toolRelative, 'src'), path.join(tool, 'src'), { recursive: true });
  writeFileSync(path.join(repo, '.gitignore'), '.local/\n');
  writeFileSync(path.join(repo, '.gitattributes'), '* -text\n');
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  const commit = () => { git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'fixture'); return git(repo, 'rev-parse', 'HEAD'); };
  const head = commit();
  function call(command, args = [], options = {}) {
    const result = spawnSync(process.execPath, [...(options.nodeArgs ?? []), path.join(tool, 'src/cli.js'), command, ...args], {
      cwd: repo, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...options.env },
    });
    let data;
    try { data = JSON.parse(result.stdout); } catch { /* Assertion includes the process output. */ }
    return { ...result, data };
  }
  const preview = (skills = 'implement', options) => call('preview', ['--repo', repo, '--target', target, '--skills', skills], options);
  return { root, repo, target, tool, head, call, preview, commit };
}
export function ok(result) { assert.equal(result.status, 0, result.stderr || result.stdout); assert.ok(result.data); return result.data; }
export const json = file => JSON.parse(readFileSync(file, 'utf8'));
