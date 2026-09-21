import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redact } from '../errors.js';
import type { BaselineGap, ComparisonBaseline } from './model.ts';

const now = () => new Date().toISOString();
const MAX_FILES = 2048;
const MAX_CONTENT = 64 * 1024;
const MAX_PATCH = 128 * 1024;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type PatchState = 'available' | 'binary' | 'deleted' | 'protected' | 'too-large' | 'truncated' | 'stale' | 'unavailable';
export interface PatchContent {
  state: PatchState; patch: string | null;
  integrity: { redacted: boolean; complete: boolean; reason: string | null };
}
const protectedPart = /^(?:\.env(?:\..*)?|\.git|\.codex|\.agents|\.ssh|\.aws|\.azure|\.kube|\.npmrc|\.netrc|runtime|secrets?|credentials?|select-key|tunnel-client|auth\.json|.*(?:api[-_]?key|runtime[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token).*|.*\.(?:key|pem|pfx|p12))$/i;
const protectedPath = (value: string) => value.split(/[\\/]+/).filter(Boolean).some(part => protectedPart.test(part));
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;
const slash = (value: string) => value.replaceAll('\\', '/');
const splitZero = (value: Buffer) => value.toString('utf8').split('\0').filter(Boolean);

export interface EvidenceGap {
  code: string;
  source: 'git' | 'filesystem' | 'event-store' | 'workflow';
  impact: string;
  path?: string | null;
}

export interface FileFact {
  path: string;
  old_path: string | null;
  change_kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unmerged' | 'unknown';
  fact_source: 'git-tree-to-worktree' | 'filesystem-untracked';
  content: { state: 'observed' | 'unavailable' | 'truncated'; size: number | null; sha256: string | null;
    preview: string | null; content_type: 'text' | 'binary' | 'unknown' };
}

export interface CommitFact {
  oid: string;
  authored_at: string;
  subject: string;
}

export interface CurrentChangesFacts {
  checked_at: string;
  current_head: string;
  files: FileFact[];
  commits: CommitFact[];
  gaps: EvidenceGap[];
  sources: { git: { state: 'observed'; observed_at: string }; filesystem: { state: 'observed' | 'incomplete'; observed_at: string } };
}

export class ChangesSourceError extends Error {
  code: BaselineGap['code'];
  outputLimit: boolean;
  constructor(code: BaselineGap['code'], outputLimit = false) { super(code); this.code = code; this.outputLimit = outputLimit; }
}

export interface ChangesSourceOptions { git?: () => string; spawn?: typeof spawnSync }

export class ChangesSource {
  git: () => string;
  spawn: typeof spawnSync;
  constructor(options: ChangesSourceOptions = {}) {
    this.git = options.git ?? (() => 'git');
    this.spawn = options.spawn ?? spawnSync;
  }

  private run(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024) {
    const result = this.spawn(this.git(), ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=', '-c', 'core.quotepath=false', ...args], {
      cwd, encoding: 'buffer', windowsHide: true, shell: false, timeout: 5000, maxBuffer,
    });
    if (result.status !== 0 || result.error) throw new ChangesSourceError('GIT_UNAVAILABLE', (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS');
    return result.stdout ?? Buffer.alloc(0);
  }

  private line(cwd: string, args: string[]) { return this.run(cwd, args).toString('utf8').trim(); }

  fileIdentity(ticketId: string, baseline: ComparisonBaseline, head: string, file: FileFact) {
    let metadata: unknown = null;
    // Metadata is part of the revision even when the content budget prevents a hash.
    const target = path.resolve(baseline.worktree_root, file.path);
    if (inside(baseline.worktree_root, target)) {
      try { const s = lstatSync(target); metadata = [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.nlink]; } catch { /* absent */ }
    }
    return { file_id: digest([ticketId, file.path, file.old_path]),
      revision: digest([ticketId, baseline.repository_id, baseline.repository_instance_id, baseline.worktree_root,
        baseline.commit_oid, head, file.path, file.old_path, file.change_kind, file.fact_source, file.content, metadata]) };
  }

  patch(baseline: ComparisonBaseline, file: FileFact): PatchContent {
    const result = (state: PatchState, reason: string | null = state): PatchContent => ({ state, patch: null,
      integrity: { redacted: false, complete: false, reason } });
    const paths = [file.path, ...(file.old_path ? [file.old_path] : [])];
    if (paths.some(p => !p || path.isAbsolute(p) || /[\x00-\x1f]/.test(p) || p.split(/[\\/]/).some(s => s === '..' || s === '.')
      || protectedPath(p) || !inside(baseline.worktree_root, path.resolve(baseline.worktree_root, p)))) return result('protected');
    if (file.change_kind === 'deleted') return result('deleted');
    if (file.content.size !== null && file.content.size > MAX_CONTENT) return result('too-large');
    if (file.content.state === 'unavailable') return result('unavailable', 'unsafe-or-unreadable-file');
    if (file.content.content_type === 'binary') return result('binary');
    if (!file.content.sha256) return result('truncated');
    try {
      // Revalidate the destination before invoking Git; never follow special files.
      const current = this.content(baseline.worktree_root, file.path).content;
      if (!current.sha256 || current.sha256 !== file.content.sha256) return result('stale');
      let patch: string;
      if (file.fact_source === 'filesystem-untracked') {
        const bytes = readFileSync(path.resolve(baseline.worktree_root, file.path));
        if (bytes.length > MAX_CONTENT) return result('too-large');
        if (createHash('sha256').update(bytes).digest('hex') !== current.sha256) return result('stale');
        const text = bytes.toString('utf8'), lines = text ? text.replace(/\n$/, '').split('\n') : [];
        const a = JSON.stringify('a/' + file.path), b = JSON.stringify('b/' + file.path);
        patch = `diff --git ${a} ${b}\nnew file mode 100644\n--- /dev/null\n+++ ${b}\n`
          + (lines.length ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line + '\n').join('')
            + (text.endsWith('\n') ? '' : '\\ No newline at end of file\n') : '');
      } else {
        // Bound both sides before diffing. Blob reads bypass filters/textconv and symlink contents.
        const oldPath = file.old_path ?? file.path;
        const entry = this.run(baseline.worktree_root, ['ls-tree', '-z', baseline.commit_oid, '--', oldPath]).toString('utf8');
        if (entry) {
          const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(entry);
          if (!match) return result('protected', 'special-baseline-entry');
          if (Number(this.line(baseline.worktree_root, ['cat-file', '-s', match[2]])) > MAX_CONTENT) return result('too-large');
          if (this.run(baseline.worktree_root, ['cat-file', 'blob', match[2]], MAX_CONTENT + 1).includes(0)) return result('binary');
        }
        patch = this.run(baseline.worktree_root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative',
          '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '-M', '-U3', baseline.commit_oid, '--', ...paths], MAX_PATCH + 1).toString('utf8');
        // Git attributes can classify NUL-free content as binary. Hunk lines have a prefix,
        // so only Git's own unprefixed marker should override the text classification.
        if (/^Binary files .+ and .+ differ$/m.test(patch) || /^GIT binary patch$/m.test(patch)) return result('binary');
      }
      if (Buffer.byteLength(patch) > MAX_PATCH) return result('truncated', 'patch-size-limit');
      const safe = redact(patch);
      return { state: 'available', patch: safe, integrity: { redacted: safe !== patch, complete: true, reason: null } };
    } catch (error) { return error instanceof ChangesSourceError && error.outputLimit
      ? result('truncated', 'patch-size-limit') : result('unavailable', 'patch-source-unavailable'); }
  }

  private identity(worktree: string) {
    let root: string, repository: string;
    try {
      root = realpathSync.native(this.line(worktree, ['rev-parse', '--show-toplevel']));
      repository = realpathSync.native(this.line(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    } catch (error) {
      if (error instanceof ChangesSourceError) throw error;
      throw new ChangesSourceError('GIT_UNAVAILABLE');
    }
    try {
      const info = statSync(repository);
      return { root, repository, instance: `${info.dev}:${info.ino}:${info.birthtimeMs}` };
    } catch { throw new ChangesSourceError('GIT_UNAVAILABLE'); }
  }

  private content(root: string, relative: string) {
    const gaps: EvidenceGap[] = [];
    const unavailable = (code: string, impact: string, state: 'unavailable' | 'truncated' = 'unavailable') => ({
      content: { state, size: null, sha256: null, preview: null, content_type: 'unknown' as const },
      gaps: [{ code, source: 'filesystem' as const, impact, path: relative }],
    });
    if (!relative || path.isAbsolute(relative) || /[\x00-\x1f]/.test(relative) || protectedPath(relative)) {
      return unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'unsafe or protected path is not read');
    }
    const target = path.resolve(root, relative), parts = path.relative(root, target).split(path.sep);
    if (!inside(root, target) || parts.some(part => protectedPart.test(part))) return unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'protected path is not read');
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'special file is not read');
      if (stat.size > 64 * 1024) {
        return { content: { state: 'truncated' as const, size: stat.size, sha256: null, preview: null, content_type: 'unknown' as const },
          gaps: [{ code: 'CONTENT_TRUNCATED', source: 'filesystem' as const, impact: 'file exceeds the safe content limit', path: relative }] };
      }
      const resolved = realpathSync.native(target);
      const resolvedRelative = path.relative(root, resolved);
      if (!inside(root, resolved) || protectedPath(resolvedRelative)) {
        return unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'resolved path escapes the worktree or is protected');
      }
      const bytes = readFileSync(resolved), sha256 = createHash('sha256').update(bytes).digest('hex');
      const binary = bytes.includes(0);
      const preview = binary ? null : redact(bytes.toString('utf8').slice(0, 8192));
      if (!binary && bytes.length > 8192) gaps.push({ code: 'CONTENT_TRUNCATED', source: 'filesystem', impact: 'preview is truncated', path: relative });
      return { content: { state: bytes.length > 8192 ? 'truncated' as const : 'observed' as const,
        size: stat.size, sha256, preview, content_type: binary ? 'binary' as const : 'text' as const }, gaps };
    } catch { return unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'file cannot be safely read'); }
  }

  private startEntries(root: string) {
    const areas: Array<['staged' | 'unstaged' | 'untracked', string[]]> = [
      ['staged', splitZero(this.run(root, ['diff', '--cached', '--name-only', '-z', '--']))],
      ['unstaged', splitZero(this.run(root, ['diff', '--name-only', '-z', '--']))],
      ['untracked', splitZero(this.run(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']))],
    ];
    let incomplete = false;
    const observed = areas.flatMap(([area, files]) => files.map(file => {
      const result = this.content(root, file);
      const state = result.content.state;
      incomplete ||= state !== 'observed';
      return { path: slash(file), area, state, sha256: result.content.sha256 };
    }));
    incomplete ||= observed.length > MAX_FILES;
    const entries = observed.slice(0, MAX_FILES);
    return { entries, integrity: incomplete ? 'incomplete' as const : 'complete' as const };
  }

  capture(worktree: string, fixedPoint: string): ComparisonBaseline {
    const identity = this.identity(worktree);
    let oid: string;
    try { oid = this.line(identity.root, ['rev-parse', '--verify', fixedPoint + '^{commit}']); }
    catch { throw new ChangesSourceError('BASELINE_COMMIT_UNAVAILABLE'); }
    const observedAt = now(), start = this.startEntries(identity.root);
    return { repository_id: identity.repository, repository_instance_id: identity.instance,
      worktree_root: identity.root, commit_oid: oid, recorded_at: observedAt,
      adoption: 'at-registration', start_observation: { head: this.line(identity.root, ['rev-parse', 'HEAD']),
        entries: start.entries, integrity: start.integrity, observed_at: observedAt }, integrity: start.integrity };
  }

  private tracked(root: string, baseline: string) {
    const tokens = splitZero(this.run(root, ['diff', '--name-status', '-z', '-M', baseline, '--']));
    const result: Array<{ status: string; path: string; old_path: string | null }> = [];
    for (let index = 0; index < tokens.length;) {
      let status = tokens[index++]!, first: string;
      const tab = status.indexOf('\t');
      if (tab >= 0) { first = status.slice(tab + 1); status = status.slice(0, tab); }
      else first = tokens[index++] ?? '';
      if (/^[RC]/.test(status)) result.push({ status, old_path: slash(first), path: slash(tokens[index++] ?? '') });
      else result.push({ status, old_path: null, path: slash(first) });
    }
    return result;
  }

  inspect(baseline: ComparisonBaseline): CurrentChangesFacts {
    const checkedAt = now(), identity = this.identity(baseline.worktree_root);
    if (!samePath(identity.root, baseline.worktree_root) || !samePath(identity.repository, baseline.repository_id)
      || baseline.repository_instance_id !== undefined && identity.instance !== baseline.repository_instance_id) {
      throw new ChangesSourceError('REPOSITORY_MISMATCH');
    }
    try { this.run(identity.root, ['cat-file', '-e', baseline.commit_oid + '^{commit}']); }
    catch { throw new ChangesSourceError('BASELINE_COMMIT_UNAVAILABLE'); }
    const currentHead = this.line(identity.root, ['rev-parse', 'HEAD']);
    const gaps: EvidenceGap[] = [];
    const files: FileFact[] = [];
    const kind = (status: string): FileFact['change_kind'] => ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed',
      C: 'copied', T: 'type-changed', U: 'unmerged' }[status[0]!] as FileFact['change_kind'] | undefined) ?? 'unknown';
    const tracked = this.tracked(identity.root, baseline.commit_oid);
    for (const item of tracked.slice(0, MAX_FILES)) {
      const content = item.old_path && protectedPath(item.old_path) ? { content: { state: 'unavailable' as const, size: null, sha256: null,
        preview: null, content_type: 'unknown' as const }, gaps: [{ code: 'UNTRACKED_CONTENT_UNAVAILABLE', source: 'filesystem' as const,
          impact: 'renamed protected content is not read', path: item.path }] }
        : item.status.startsWith('D') ? { content: { state: 'observed' as const, size: 0, sha256: null,
        preview: null, content_type: 'unknown' as const }, gaps: [] as EvidenceGap[] } : this.content(identity.root, item.path);
      gaps.push(...content.gaps);
      files.push({ path: item.path, old_path: item.old_path, change_kind: kind(item.status),
        fact_source: 'git-tree-to-worktree', content: content.content });
    }
    const trackedPaths = new Set(files.map(file => file.path));
    const untracked = splitZero(this.run(identity.root, ['ls-files', '--others', '--exclude-standard', '-z', '--'])).map(slash);
    for (const file of untracked) {
      if (files.length >= MAX_FILES) break;
      if (trackedPaths.has(file)) continue;
      const content = this.content(identity.root, file); gaps.push(...content.gaps);
      files.push({ path: file, old_path: null, change_kind: 'added', fact_source: 'filesystem-untracked', content: content.content });
    }
    if (tracked.length + untracked.length > MAX_FILES) gaps.push({ code: 'CONTENT_TRUNCATED', source: 'git',
      impact: `file list is limited to ${MAX_FILES} entries` });
    let commits: CommitFact[] = [];
    const ancestor = this.spawn(this.git(), ['--no-optional-locks', '-c', 'core.hooksPath=', 'merge-base', '--is-ancestor',
      baseline.commit_oid, currentHead], { cwd: identity.root, windowsHide: true, shell: false, timeout: 5000 });
    if (ancestor.error || ancestor.status === null || ancestor.status > 1) throw new ChangesSourceError('GIT_UNAVAILABLE');
    if (ancestor.status === 0) {
      const fields = splitZero(this.run(identity.root, ['log', '-z', '--format=%H%x00%aI%x00%s', baseline.commit_oid + '..' + currentHead, '--']));
      for (let index = 0; index + 2 < fields.length; index += 3) commits.push({ oid: fields[index]!, authored_at: fields[index + 1]!, subject: redact(fields[index + 2]!) });
    } else gaps.push({ code: 'HISTORY_DIVERGED', source: 'git', impact: 'commit drilldown is incomplete because baseline is not an ancestor of HEAD' });
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { checked_at: checkedAt, current_head: currentHead, files, commits, gaps,
      sources: { git: { state: 'observed', observed_at: checkedAt },
        filesystem: { state: gaps.some(gap => gap.source === 'filesystem') ? 'incomplete' : 'observed', observed_at: checkedAt } } };
  }

  summary(baseline: ComparisonBaseline) {
    const checkedAt = now(), identity = this.identity(baseline.worktree_root);
    if (!samePath(identity.root, baseline.worktree_root) || !samePath(identity.repository, baseline.repository_id)
      || baseline.repository_instance_id !== undefined && identity.instance !== baseline.repository_instance_id) {
      throw new ChangesSourceError('REPOSITORY_MISMATCH');
    }
    try { this.run(identity.root, ['cat-file', '-e', baseline.commit_oid + '^{commit}']); }
    catch { throw new ChangesSourceError('BASELINE_COMMIT_UNAVAILABLE'); }
    const currentHead = this.line(identity.root, ['rev-parse', 'HEAD']);
    const tracked = splitZero(this.run(identity.root, ['diff', '--name-only', '-z', baseline.commit_oid, '--'], 256 * 1024)).map(slash);
    const deleted = new Set(splitZero(this.run(identity.root, ['diff', '--diff-filter=D', '--name-only', '-z', baseline.commit_oid, '--'], 256 * 1024)).map(slash));
    const untracked = splitZero(this.run(identity.root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], 256 * 1024)).map(slash);
    const paths = [...new Set([...tracked, ...untracked])];
    const gaps: EvidenceGap[] = [];
    if (paths.length > MAX_FILES) gaps.push({ code: 'CONTENT_TRUNCATED', source: 'git', impact: `file count is limited to ${MAX_FILES} entries` });
    for (const relative of paths.slice(0, MAX_FILES)) {
      if (deleted.has(relative)) continue;
      const unavailable = (code: string, impact: string) => gaps.push({ code, source: 'filesystem' as const, impact, path: relative });
      if (!relative || path.isAbsolute(relative) || /[\x00-\x1f]/.test(relative) || protectedPath(relative)) {
        unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'unsafe or protected content is not materialized in summary');
        continue;
      }
      const target = path.resolve(identity.root, relative);
      if (!inside(identity.root, target) || protectedPath(path.relative(identity.root, target))) {
        unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'protected content is not materialized in summary');
        continue;
      }
      try {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'special content is not materialized in summary');
          continue;
        }
        if (stat.size > 64 * 1024) {
          unavailable('CONTENT_TRUNCATED', 'file exceeds the safe content limit');
          continue;
        }
        const resolved = realpathSync.native(target);
        if (!inside(identity.root, resolved) || protectedPath(path.relative(identity.root, resolved))) {
          unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'resolved content is protected or escapes the worktree');
        }
      } catch {
        unavailable('UNTRACKED_CONTENT_UNAVAILABLE', 'content metadata cannot be safely inspected');
      }
    }
    const ancestor = this.spawn(this.git(), ['--no-optional-locks', '-c', 'core.hooksPath=', 'merge-base', '--is-ancestor',
      baseline.commit_oid, currentHead], { cwd: identity.root, windowsHide: true, shell: false, timeout: 5000 });
    if (ancestor.error || ancestor.status === null || ancestor.status > 1) throw new ChangesSourceError('GIT_UNAVAILABLE');
    let commitCount: number | null = null;
    if (ancestor.status === 0) commitCount = Number(this.line(identity.root, ['rev-list', '--count', baseline.commit_oid + '..' + currentHead]));
    else gaps.push({ code: 'HISTORY_DIVERGED', source: 'git', impact: 'commit count is unavailable because baseline is not an ancestor of HEAD' });
    return { checked_at: checkedAt, current_head: currentHead, file_count: Math.min(paths.length, MAX_FILES),
      file_count_limited: paths.length > MAX_FILES, commit_count: commitCount, gaps,
      sources: { git: { state: 'observed' as const, observed_at: checkedAt },
        filesystem: { state: gaps.some(gap => gap.source === 'filesystem') ? 'incomplete' as const : 'observed' as const, observed_at: checkedAt } } };
  }
}
