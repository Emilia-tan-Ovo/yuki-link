import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PathPolicy } from '../computer/paths.js';
import { sessionPermissionSnapshot } from '../permissions.js';
import { HarnessError } from './model.ts';
import type { Source, SourceEvent, SourceRun, SourceSession, Ticket } from './model.ts';

const samePath = (left: string, right: string) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

// Only this adapter knows the legacy manager/store shape. No private Codex files.
interface Manager {
  allowedCwds: string[];
  store: {
    directory: string;
    state: { runs: Record<string, SourceRun> };
    eventFile(id: string): string;
    readEvents(run: SourceRun): SourceEvent[];
  };
  session(id: string): SourceSession;
  status(input: { session_id: string; run_id: string }): { run: SourceRun | null; session_status: string };
  stopRun(sessionId: string, runId: string): { outcome: string };
  lookupRequest(requestId: string): { request_id: string; fingerprint: string; session_id: string; run_id: string; status: string } | null;
}
export class CodexSource implements Source {
  manager: Manager;
  paths: PathPolicy;
  constructor(manager: Manager, controlRoots: string[] = []) {
    this.manager = manager;
    this.paths = new PathPolicy(manager.allowedCwds, [], manager.store.directory, controlRoots);
  }
  session(id: string): SourceSession {
    const session = this.manager.session(id);
    return { id: session.id, cwd: session.cwd, codex_thread_id: session.codex_thread_id,
      permissions: sessionPermissionSnapshot(session) };
  }
  runs(sessionId: string): SourceRun[] {
    return Object.values(this.manager.store.state.runs).filter(r => r.session_id === sessionId).map(r => ({
      id: r.id, session_id: r.session_id, created_at: r.created_at, model: r.model, reasoning: r.reasoning,
      status: r.status, config_source: r.config_source, timeout_ms: r.timeout_ms ?? null, exit_code: r.exit_code,
      started_at: r.started_at ?? null, finished_at: r.finished_at ?? null, error: (r as SourceRun).error ?? null,
    }));
  }
  status(sessionId: string, runId: string) { return this.manager.status({ session_id: sessionId, run_id: runId }); }
  stop(sessionId: string, runId: string) { return this.manager.stopRun(sessionId, runId); }
  lookupRequest(requestId: string) { return this.manager.lookupRequest(requestId); }
  activeRuns() { return Object.values(this.manager.store.state.runs).filter(run =>
    ['queued', 'starting', 'running', 'stopping'].includes(run.status)); }
  worktree(ticket: Ticket) {
    let directory: string;
    try {
      directory = this.paths.resolve(ticket.expected_worktree);
      if (!statSync(directory).isDirectory()) throw new Error('Not a directory');
    } catch { throw new HarnessError('WORKTREE_UNAVAILABLE'); }
    const baseline = ticket.comparison_baseline;
    if (!baseline) throw new HarnessError('WORKTREE_UNAVAILABLE');
    const git = spawnSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
      'rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], {
      cwd: directory, encoding: 'utf8', windowsHide: true, shell: false, timeout: 2000, maxBuffer: 8192,
    });
    if (git.status !== 0 || git.error) throw new HarnessError('WORKTREE_UNAVAILABLE');
    try {
      const [rootValue, repositoryValue] = git.stdout.trim().split(/\r?\n/);
      const root = realpathSync.native(rootValue);
      const repository = realpathSync.native(repositoryValue);
      const info = statSync(repository);
      const instance = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      if (!samePath(root, directory) || !samePath(root, baseline.worktree_root)
        || !samePath(repository, baseline.repository_id)
        || baseline.repository_instance_id !== undefined && instance !== baseline.repository_instance_id) {
        throw new HarnessError('WORKTREE_MISMATCH');
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('WORKTREE_UNAVAILABLE');
    }
    return directory;
  }
  events(run: SourceRun) {
    const file = this.manager.store.eventFile(run.id);
    const text = readFileSync(file, 'utf8');
    if (text && !text.endsWith('\n')) throw new Error('Incomplete source tail');
    const events = this.manager.store.readEvents(run);
    for (const [seq, event] of events.entries()) {
      if (event.seq !== seq || event.run_id !== run.id || event.session_id !== run.session_id
        || typeof event.type !== 'string' || typeof event.at !== 'string') throw new Error('Invalid source record');
    }
    return events;
  }
  attribution(ticket: Ticket, session?: SourceSession) {
    const observed: Record<string, unknown> = { cwd: session?.cwd ?? null, git: null, checkpoint: null };
    const mismatches: string[] = [];
    const unknown: string[] = [];
    try {
      const cwd = this.paths.resolve(session?.cwd ?? ticket.expected_worktree);
      if (ticket.expected_worktree && this.paths.resolve(ticket.expected_worktree) !== cwd) mismatches.push('cwd');
      const git = spawnSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
        'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], {
        cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 2000, maxBuffer: 8192,
      });
      if (git.status === 0) {
        const [root, branch] = git.stdout.trim().split(/\r?\n/);
        observed.git = { root, branch, source: 'git rev-parse' };
      } else unknown.push('git');
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(ticket.key)) throw new Error('Checkpoint key unavailable');
      const checkpoint = this.paths.resolve(path.join(cwd, '.local/workflow-state', ticket.key + '.md'));
      if (statSync(checkpoint).size > 64 * 1024) throw new Error('Checkpoint too large');
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(checkpoint, 'utf8'))?.[1];
      if (!front) throw new Error('Checkpoint unavailable');
      const fields: Record<string, string | null> = {};
      for (const field of ['ticket', 'worktree', 'branch']) {
        const scalar = new RegExp('^' + field + ': *(.+)$', 'm').exec(front)?.[1]?.trim();
        fields[field] = scalar?.startsWith('"') ? JSON.parse(scalar) : scalar && !/[\[\]{}&*!|>]/.test(scalar) ? scalar : null;
      }
      observed.checkpoint = { ...fields, source: 'workflow checkpoint front matter' };
      // A checkpoint may name "HARNESS-001 / GitHub #40". Compare its ticket key.
      if (fields.ticket && fields.ticket.split(/\s+\/\s+/)[0] !== ticket.key) mismatches.push('checkpoint.ticket');
      if (fields.worktree && this.paths.resolve(fields.worktree) !== cwd) mismatches.push('checkpoint.worktree');
      const branch = (observed.git as { branch?: string } | null)?.branch;
      if (fields.branch && branch && fields.branch !== branch) mismatches.push('checkpoint.branch');
    } catch { unknown.push('cwd-or-checkpoint'); }
    return { state: mismatches.length ? 'attribution mismatch' : unknown.length ? 'unknown' : 'matched',
      expected_worktree: ticket.expected_worktree, observed, mismatches, unknown,
      source: 'session / local Git / explicit checkpoint; attribution remains registered' };
  }
}
