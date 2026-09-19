import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Source, Ticket } from './model.ts';
import type { WorkflowAssessment, WorkflowSnapshot } from './workflow-model.ts';

const now = () => new Date().toISOString();
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const priority = { 'not-applicable': 0, verified: 1, unknown: 2, stale: 3, mismatch: 4 } as const;
type State = keyof typeof priority;
const protectedPart = /^(?:\.git|\.codex|\.agents|\.ssh|\.aws|\.azure|\.kube|runtime|secrets?|credentials?|.*(?:api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token).*)$/i;
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const canonical = (value: string) => realpathSync.native(path.resolve(value));
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;
const scalar = (front: string, name: string) => {
  const raw = new RegExp('^' + name + ': *(.+)$', 'm').exec(front)?.[1]?.trim();
  if (!raw) return null;
  try { return raw.startsWith('"') ? JSON.parse(raw) as string : raw; }
  catch { return null; }
};

interface GitResult { status: number | null; stdout: string; stderr: string }
export interface WorkflowSourceOptions { git?: () => string }

export class WorkflowSource {
  source: Source;
  git: () => string;
  constructor(source: Source, options: WorkflowSourceOptions = {}) {
    this.source = source;
    this.git = options.git ?? (() => 'git');
  }
  validate(ticket: Ticket, snapshot: WorkflowSnapshot) {
    if (!ticket.expected_worktree) return;
    const root = path.resolve(ticket.expected_worktree);
    for (const artifact of snapshot.artifacts) {
      if (artifact.kind !== 'file') continue;
      if (!path.isAbsolute(artifact.location) || /[\x00-\x1f]/.test(artifact.location)) throw new Error('unsafe artifact path');
      const target = path.resolve(artifact.location), relative = path.relative(root, target);
      if (!inside(root, target) || relative.split(path.sep).some(part => protectedPart.test(part))) throw new Error('protected artifact path');
    }
    for (const item of [...snapshot.subject.staged, ...snapshot.subject.unstaged, ...snapshot.subject.untracked]) {
      if (path.isAbsolute(item.path) || /[\x00-\x1f]/.test(item.path)) throw new Error('unsafe subject path');
      const target = path.resolve(root, item.path), relative = path.relative(root, target);
      if (!inside(root, target) || relative.split(path.sep).some(part => protectedPart.test(part))) throw new Error('protected subject path');
    }
  }
  private runGit(cwd: string, args: string[]): GitResult {
    const result = spawnSync(this.git(), ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=', ...args], { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 3000, maxBuffer: 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  private file(root: string, location: string) {
    if (!path.isAbsolute(location) || /[\x00-\x1f]/.test(location)) throw new Error('unsafe-path');
    const target = path.resolve(location);
    const relative = path.relative(root, target);
    if (!inside(root, target) || relative.split(path.sep).some(part => protectedPart.test(part))) throw new Error('protected-path');
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('unsupported-file');
    const resolved = canonical(target);
    if (!inside(root, resolved)) throw new Error('escaped-path');
    return resolved;
  }
  assess(ticket: Ticket, snapshot: WorkflowSnapshot): WorkflowAssessment {
    const checked = now();
    const reasons: WorkflowAssessment['reasons'] = [];
    let state: State = 'verified';
    const add = (next: State, code: string, source: string, detail: string | null = null) => {
      reasons.push({ state: next, code, source, detail });
      if (priority[next] > priority[state]) state = next;
    };
    let root: string | null = null;
    try {
      if (!ticket.expected_worktree) throw new Error('expected worktree not registered');
      root = canonical(ticket.expected_worktree);
      const reported = canonical(snapshot.checkpoint.worktree);
      if (!samePath(root, reported)) add('mismatch', 'CHECKPOINT_WORKTREE_MISMATCH', 'ticket/checkpoint', snapshot.checkpoint.worktree);
      if (snapshot.checkpoint.ticket_key.split(/\s+\/\s+/)[0] !== ticket.key) add('mismatch', 'CHECKPOINT_TICKET_MISMATCH', 'ticket/checkpoint', snapshot.checkpoint.ticket_key);
      if (snapshot.subject.ticket_ref !== ticket.reference) add('mismatch', 'SUBJECT_TICKET_MISMATCH', 'ticket/subject', snapshot.subject.ticket_ref);
    } catch (error) { add('unknown', 'WORKTREE_UNAVAILABLE', 'ticket/checkpoint', error instanceof Error ? error.message : null); }

    const artifactPaths = new Set<string>();
    const artifacts: WorkflowAssessment['artifacts'] = snapshot.artifacts.map(artifact => {
      let artifactState: State = 'verified', reason = 'artifact revision matches';
      let observed: string | null = null;
      try {
        if (!root || artifact.kind !== 'file') throw new Error(artifact.kind === 'file' ? 'worktree unavailable' : 'reference source not readable');
        const file = this.file(root, artifact.location);
        artifactPaths.add(path.relative(root, file).replaceAll('\\', '/'));
        observed = hash(file);
        if (!artifact.revision) { artifactState = 'unknown'; reason = 'reported revision unavailable'; }
        else if (artifact.revision !== observed) { artifactState = 'stale'; reason = 'artifact revision changed'; }
        if (artifact.artifact_id === snapshot.checkpoint.artifact_id) {
          const content = readFileSync(file, 'utf8');
          const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
          if (!front) { artifactState = 'unknown'; reason = 'checkpoint schema unavailable'; }
          else {
            const reported = { ticket: scalar(front, 'ticket'), worktree: scalar(front, 'worktree'), branch: scalar(front, 'branch'),
              fixed_point: scalar(front, 'fixed_point'), head: scalar(front, 'head'), phase: scalar(front, 'phase'), schema_version: scalar(front, 'schema_version') };
            if (reported.ticket?.split(/\s+\/\s+/)[0] !== ticket.key || reported.phase !== snapshot.phase
              || reported.fixed_point !== snapshot.subject.fixed_point || reported.head !== snapshot.subject.head
              || reported.branch !== snapshot.checkpoint.branch || reported.schema_version !== String(snapshot.checkpoint.schema_version)
              || !reported.worktree || !samePath(canonical(reported.worktree), root)) {
              artifactState = 'mismatch'; reason = 'checkpoint fields conflict with submitted subject';
            }
          }
        }
      } catch (error) {
        artifactState = 'unknown'; reason = error instanceof Error ? error.message : 'artifact unavailable';
      }
      add(artifactState, 'ARTIFACT_' + artifactState.toUpperCase().replace('-', '_'), artifact.source, artifact.artifact_id + ': ' + reason);
      return { artifact_id: artifact.artifact_id, state: artifactState, reason, checked_at: checked, observed_revision: observed };
    });

    if (root) {
      const head = this.runGit(root, ['rev-parse', 'HEAD']);
      const branch = this.runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (head.status !== 0 || branch.status !== 0) add('unknown', 'GIT_UNAVAILABLE', 'git', (head.stderr || branch.stderr).trim() || null);
      else {
        if (snapshot.subject.head && head.stdout.trim() !== snapshot.subject.head) add('stale', 'HEAD_CHANGED', 'git rev-parse', head.stdout.trim());
        if (snapshot.checkpoint.head && head.stdout.trim() !== snapshot.checkpoint.head) add('stale', 'CHECKPOINT_HEAD_STALE', 'git rev-parse', head.stdout.trim());
        if (snapshot.checkpoint.branch && branch.stdout.trim() !== snapshot.checkpoint.branch) add('mismatch', 'BRANCH_MISMATCH', 'git rev-parse', branch.stdout.trim());
        const status = this.runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        if (status.status !== 0) add('unknown', 'GIT_STATUS_UNAVAILABLE', 'git status', status.stderr.trim() || null);
        else {
          const actual = { staged: new Set<string>(), unstaged: new Set<string>(), untracked: new Set<string>() };
          const entries = status.stdout.split('\0');
          for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (!entry) continue;
            const code = entry.slice(0, 2), name = entry.slice(3).replaceAll('\\', '/');
            // In porcelain v1 -z, rename/copy records are `XY destination\0source\0`.
            // The source path is metadata for the same record, not a new status entry.
            if (code.includes('R') || code.includes('C')) index++;
            if (artifactPaths.has(name)) continue;
            if (code === '??') actual.untracked.add(name);
            else { if (code[0] !== ' ') actual.staged.add(name); if (code[1] !== ' ') actual.unstaged.add(name); }
          }
          for (const kind of ['staged', 'unstaged', 'untracked'] as const) {
            const reported = new Set(snapshot.subject[kind].map(file => file.path.replaceAll('\\', '/')));
            if (reported.size !== actual[kind].size || [...reported].some(file => !actual[kind].has(file))) add('stale', 'SUBJECT_CONTENT_CHANGED', 'git status', kind);
            for (const item of snapshot.subject[kind]) {
              if (!item.sha256) continue;
              try {
                const file = this.file(root, path.join(root, item.path));
                if (hash(file) !== item.sha256) add('stale', 'SUBJECT_FILE_CHANGED', 'filesystem', item.path);
              } catch { add('unknown', 'SUBJECT_FILE_UNAVAILABLE', 'filesystem', item.path); }
            }
          }
        }
      }
    }

    const runtime: WorkflowAssessment['runtime'] = snapshot.runtime_refs.map(reference => {
      let runtimeState: State = 'unknown', reason = 'runtime source unavailable', observed: string | null = null;
      if (reference.kind === 'codex-run' && reference.session_id && reference.run_id) {
        try {
          const run = this.source.runs(reference.session_id).find(value => value.id === reference.run_id);
          if (run) {
            observed = run.status;
            runtimeState = reference.expected_state && reference.expected_state !== run.status ? 'mismatch' : 'verified';
            reason = runtimeState === 'verified' ? 'Codex run observed' : 'Codex run state conflicts';
          } else reason = 'Codex run not observed';
        } catch { reason = 'Codex runtime source unavailable'; }
      } else if (!reference.expected_state) { runtimeState = 'not-applicable'; reason = 'no runtime state dependency declared'; }
      add(runtimeState, 'RUNTIME_' + runtimeState.toUpperCase().replace('-', '_'), reference.source, reference.runtime_ref_id + ': ' + reason);
      return { runtime_ref_id: reference.runtime_ref_id, state: runtimeState, reason, checked_at: checked, observed_state: observed };
    });
    if (!reasons.length) add('unknown', 'NO_VERIFIABLE_SOURCE', 'workflow', null);
    return { state, checked_at: checked, reasons, artifacts, runtime };
  }
}
