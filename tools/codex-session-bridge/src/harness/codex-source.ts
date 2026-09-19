import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PathPolicy } from '../computer/paths.js';
import { sessionPermissionSnapshot } from '../permissions.js';
import type { Source, SourceEvent, SourceRun, SourceSession, Ticket } from './model.ts';

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
    }));
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
