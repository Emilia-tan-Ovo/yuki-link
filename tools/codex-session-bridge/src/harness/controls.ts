import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HarnessError } from './model.ts';
import type { Binding, Operation, Source, SourceRun, Ticket } from './model.ts';
import type { Journal } from './journal.ts';
import type { TaskCollector } from './task-collector.ts';

const terminalRuns = new Set(['completed', 'failed', 'stopped', 'timed_out', 'interrupted']);
const terminalTasks = new Set(['completed', 'failed', 'stopped']);
const now = () => new Date().toISOString();

export interface HarnessControlOptions {
  openFolder?: (directory: string) => void;
}

const systemOpenFolder = (directory: string) => {
  const child = spawn('explorer.exe', [directory], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
};

export class HarnessControls {
  private journal: Journal;
  private source: Source;
  private tasks: TaskCollector;
  private ticket: (id: string) => Ticket;
  private bindings: Map<string, Binding>;
  private observations: Map<string, string>;
  private options: HarnessControlOptions;
  constructor(journal: Journal, source: Source, tasks: TaskCollector, ticket: (id: string) => Ticket,
    bindings: Map<string, Binding>, observations: Map<string, string>, options: HarnessControlOptions = {}) {
    this.journal = journal; this.source = source; this.tasks = tasks; this.ticket = ticket;
    this.bindings = bindings; this.observations = observations; this.options = options;
  }

  private evidenceGap() {
    return this.journal.failure ? { state: 'recording-failed', reason: this.journal.failure,
      observed_at: now(), source_id: this.journal.sourceId } : null;
  }

  private record(ticketId: string, action: 'refresh' | 'run.stop' | 'task.stop' | 'worktree.open',
    stage: 'requested' | 'result', outcome: string, target: unknown, sourceStatus: unknown, controlId: string) {
    if (this.journal.failure) return false;
    const data: Operation = { kind: 'control_action', control: { control_id: controlId, ticket_id: ticketId,
      action, stage, outcome, target, source_status: sourceStatus, occurred_at: now(),
      integrity: { capture: 'recorded', redacted: false } } };
    try { this.journal.append(data); return true; }
    catch { return false; }
  }

  private runProjection(binding: Binding, run: SourceRun, state: 'current' | 'unavailable' | 'unknown', error: string | null = null) {
    return { binding_id: binding.id, session_id: binding.session_id, run_id: run.id,
      execution: { status: run.status, error: run.error ?? null, finished_at: run.finished_at ?? null },
      observation: { state, observed_at: state === 'current' ? now() : null, source: 'codex-manager', error },
      manageable: !terminalRuns.has(run.status) && state === 'current' };
  }

  view(ticketId: string, sourceFailure: string | null = null) {
    this.ticket(ticketId);
    const runs: unknown[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.ticket_id !== ticketId) continue;
      try {
        for (const run of this.source.runs(binding.session_id).filter(value => binding.scope === 'session' || value.id === binding.run_id)) {
          runs.push(this.runProjection(binding, run, sourceFailure ? 'unavailable' : 'current', sourceFailure));
        }
      } catch {
        for (const [key, value] of this.observations) {
          if (!key.startsWith(binding.id + ':')) continue;
          try {
            const snapshot = JSON.parse(value) as { run: SourceRun };
            runs.push(this.runProjection(binding, snapshot.run, 'unavailable', 'SOURCE_UNAVAILABLE'));
          } catch { /* Ignore malformed historical projection; journal validation remains authoritative. */ }
        }
      }
    }
    const taskStatus = this.journal.failure ? this.tasks.currentStatus(ticketId) : this.tasks.status(ticketId);
    const tasks = taskStatus.map(value => ({ task_id: value.binding.task_id,
      execution: { status: value.snapshot?.status ?? 'unknown', error: value.snapshot?.error ?? null,
        finished_at: value.snapshot?.finished_at ?? null },
      observation: { state: value.current.state === 'observed' ? 'current'
        : value.source_state === 'collection-failed' ? 'unknown' : 'unavailable',
        observed_at: value.current.observed_at, source: 'yca-owned-task', error: value.source_state === 'observed' ? null : value.source_state },
      manageable: !terminalTasks.has(value.snapshot?.status ?? 'unknown') && value.source_state === 'observed',
      binding: value.binding }));
    return { runs, tasks, evidence_gap: this.evidenceGap() };
  }

  refresh(ticketId: string, observe: () => void, sourceFailure: () => string | null) {
    const controlId = randomUUID();
    const target = { ticket_id: ticketId };
    const intent = this.record(ticketId, 'refresh', 'requested', 'requested', target, null, controlId);
    observe();
    const view = this.view(ticketId, sourceFailure());
    const saved = this.record(ticketId, 'refresh', 'result', 'observed', target, view, controlId);
    return { ...view, control_id: controlId, outcome: 'observed', evidence_gap: intent && saved ? view.evidence_gap : this.evidenceGap() ?? {
      state: 'recording-failed', reason: 'CONTROL_RECORD_NOT_SAVED', observed_at: now(), source_id: this.journal.sourceId } };
  }

  stopRun(ticketId: string, runId: string) {
    const binding = [...this.bindings.values()].find(value => value.ticket_id === ticketId
      && (value.scope === 'session' || value.run_id === runId)
      && this.source.runs(value.session_id).some(run => run.id === runId));
    if (!binding) throw new HarnessError('RUN_NOT_FOUND');
    if (!this.source.stop || !this.source.status) throw new HarnessError('RUN_CONTROL_UNAVAILABLE');
    const controlId = randomUUID(), target = { binding_id: binding.id, session_id: binding.session_id, run_id: runId };
    const intent = this.record(ticketId, 'run.stop', 'requested', 'requested', target, null, controlId);
    let outcome = 'request_failed';
    try { outcome = this.source.stop(binding.session_id, runId).outcome; }
    catch { outcome = 'request_failed'; }
    let run: SourceRun | null = null;
    try { run = this.source.status(binding.session_id, runId).run; } catch { /* receipt keeps observation gap */ }
    const execution = { status: run?.status ?? 'unknown', error: run?.error ?? null, finished_at: run?.finished_at ?? null };
    const saved = this.record(ticketId, 'run.stop', 'result', outcome, target, execution, controlId);
    return { control_id: controlId, action: 'run.stop', outcome, target, execution,
      observation: { state: run ? 'current' : 'unavailable', observed_at: run ? now() : null, source: 'codex-manager' },
      evidence_gap: intent && saved ? this.evidenceGap() : this.evidenceGap() ?? { state: 'recording-failed',
        reason: 'CONTROL_RECORD_NOT_SAVED', observed_at: now(), source_id: this.journal.sourceId } };
  }

  stopTask(ticketId: string, taskId: string) {
    const { binding, source } = this.tasks.target(ticketId, taskId);
    const controlId = randomUUID(), target = { binding_id: binding.binding_id, task_id: taskId, service_epoch: binding.service_epoch };
    const intent = this.record(ticketId, 'task.stop', 'requested', 'requested', target, null, controlId);
    let outcome = 'requested', snapshot: ReturnType<typeof source.stop> | null = null;
    try {
      snapshot = source.stop(taskId);
      if (snapshot.termination.error || snapshot.termination.tree_kill === 'failed') outcome = 'request_failed';
      else if (terminalTasks.has(snapshot.status)) outcome = 'already_terminal';
    } catch { outcome = 'request_failed'; }
    const execution = { status: snapshot?.status ?? 'unknown',
      error: snapshot?.error ?? snapshot?.termination.error ?? null, finished_at: snapshot?.finished_at ?? null };
    const saved = this.record(ticketId, 'task.stop', 'result', outcome, target, execution, controlId);
    return { control_id: controlId, action: 'task.stop', outcome, target, execution,
      evidence_gap: intent && saved ? this.evidenceGap() : this.evidenceGap() ?? { state: 'recording-failed',
        reason: 'CONTROL_RECORD_NOT_SAVED', observed_at: now(), source_id: this.journal.sourceId } };
  }

  openWorktree(ticketId: string) {
    const ticket = this.ticket(ticketId);
    if (!ticket.expected_worktree || !this.source.worktree) throw new HarnessError('WORKTREE_UNAVAILABLE');
    let directory: string;
    try { directory = this.source.worktree(ticket); }
    catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('WORKTREE_UNAVAILABLE');
    }
    const controlId = randomUUID(), target = { expected_worktree: directory };
    const intent = this.record(ticketId, 'worktree.open', 'requested', 'requested', target, null, controlId);
    let outcome = 'open_requested';
    try { (this.options.openFolder ?? systemOpenFolder)(directory); }
    catch { outcome = 'request_failed'; }
    const saved = this.record(ticketId, 'worktree.open', 'result', outcome, target, null, controlId);
    return { control_id: controlId, action: 'worktree.open', outcome, target,
      evidence_gap: intent && saved ? this.evidenceGap() : this.evidenceGap() ?? { state: 'recording-failed',
        reason: 'CONTROL_RECORD_NOT_SAVED', observed_at: now(), source_id: this.journal.sourceId } };
  }
}
