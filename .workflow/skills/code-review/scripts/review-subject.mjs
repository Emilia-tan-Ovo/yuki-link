// 只读 Git/文件证据采集；不选择 review mode、不调用模型、不修改 index。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
try {
  const [input, fixed, previous, ...extra] = process.argv.slice(2);
  if (!input || !fixed || extra.length) throw new Error('Usage: node review-subject.mjs <repo> <fixed-point> [previous.json]');
  const repo = fs.realpathSync(input);
  const insideRepo = candidate => {
    const relative = path.relative(repo, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  // Resolve anew from trusted absolute PATH entries, never from the subject cwd or its aliases.
  let executable;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory) || insideRepo(directory)) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    if (!fs.existsSync(candidate)) continue;
    const canonical = fs.realpathSync.native(candidate);
    if (insideRepo(canonical) || !fs.statSync(canonical).isFile()) continue;
    executable = canonical;
    break;
  }
  if (!executable) throw new Error('GIT_UNAVAILABLE');
  const git = (...args) => execFileSync(executable, ['--no-replace-objects', '--no-optional-locks',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args],
  { cwd: repo, shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (fs.realpathSync(git('rev-parse', '--show-toplevel').toString().trim()) !== repo) throw new Error('REPOSITORY_ROOT_REQUIRED');
  const resolve = ref => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
  const fixedPoint = resolve(fixed);
  const names = buffer => buffer.toString('utf8').split('\0').filter(Boolean);
  function file(relative) {
    const absolute = path.join(repo, relative);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return { path: relative, kind: 'missing', sha256: null };
    if (stat.isSymbolicLink()) return { path: relative, kind: 'symlink', sha256: hash(fs.readlinkSync(absolute)) };
    if (!stat.isFile()) throw new Error(`UNSUPPORTED_FILE_KIND: ${relative}`);
    return { path: relative, kind: 'file', sha256: hash(fs.readFileSync(absolute)) };
  }
  function capture() {
    if (git('ls-files', '-u', '-z').length) throw new Error('UNMERGED_INDEX');
    const hidden = names(git('ls-files', '-v', '-z')).find(entry => !entry.startsWith('H '));
    if (hidden) throw new Error(`HIDDEN_INDEX_STATE: ${hidden}`);
    const index = git('ls-files', '--stage', '-z');
    for (const entry of names(index)) {
      const mode = entry.slice(0, 6);
      if (!['100644', '100755', '120000'].includes(mode)) throw new Error(`UNSUPPORTED_INDEX_MODE: ${entry}`);
    }
    const head = resolve('HEAD');
    const base = git('merge-base', fixedPoint, head).toString().trim();
    const diff = (...args) => git('diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', ...args, '--').toString('utf8');
    const patches = { committed: diff(base, head), staged: diff('--cached', head), unstaged: diff() };
    const tracked = [...new Set(names(git('ls-files', '-z')))].sort().map(file);
    const untracked = names(git('ls-files', '--others', '--exclude-standard', '-z')).sort().map(file);
    return { schema_version: 1, repo, fixed_point: fixedPoint, merge_base: base, head,
      index_sha256: hash(index), tracked, untracked, patches,
      empty: !Object.values(patches).some(Boolean) && !untracked.length };
  }
  const subject = capture();
  const digest = hash(JSON.stringify(subject));
  if (digest !== hash(JSON.stringify(capture()))) throw new Error('SUBJECT_CHANGED_DURING_CAPTURE');
  let status = 'captured';
  if (previous) {
    const old = JSON.parse(fs.readFileSync(previous, 'utf8'));
    const { digest: oldDigest, status: oldStatus, ...oldSubject } = old;
    if (oldSubject.schema_version !== 1 || !['captured', 'matched', 'stale'].includes(oldStatus)
      || hash(JSON.stringify(oldSubject)) !== oldDigest) throw new Error('INVALID_PREVIOUS_SUBJECT');
    status = oldDigest === digest ? 'matched' : 'stale';
  }
  console.log(JSON.stringify({ ...subject, digest, status }));
  if (status === 'stale') process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: error.message }));
  process.exitCode = 1;
}
