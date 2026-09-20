import { randomUUID } from 'node:crypto';
import { redact } from '../errors.js';
import { Journal } from './journal.ts';
import { ComputerCalls } from './computer-calls.ts';
import { TaskCollector } from './task-collector.ts';
import { WorkflowHistory } from './workflow.ts';
import { ConversationHistory } from './conversations.ts';
import { WorkflowSource } from './workflow-source.ts';
import { ChangesSource, ChangesSourceError } from './changes-source.ts';
import { Changes } from './changes.ts';
import { HarnessControls } from './controls.ts';
import type { HarnessControlOptions } from './controls.ts';
import type { WorkflowSourceOptions } from './workflow-source.ts';
import type { TaskSource } from './task-source.ts';
import { HarnessError, registrationSchema, attachSchema } from './model.ts';
import type { Source, Project, Ticket, Binding, Event, Operation, RecordEntry } from './model.ts';

export type HarnessExecutionCategory = 'record-only' | 'observe' | 'new-side-effect' | 'manage-existing';

const unavailableRecording = {
  state: 'unavailable', reason: 'harness-unavailable', source_id: null, observed_at: null, sources: {},
};

export function gateHarnessExecution(harness: { executionGate?: Harness['executionGate'] } | null | undefined,
  category: HarnessExecutionCategory) {
  if (typeof harness?.executionGate === 'function') return harness.executionGate(category);
  if (category === 'record-only' || category === 'new-side-effect') {
    throw new HarnessError('HARNESS_UNAVAILABLE', { category, recording: unavailableRecording });
  }
  return { recording: unavailableRecording, evidence_gap: {
    state: 'unavailable', reason: unavailableRecording.reason, observed_at: null, source_id: null,
  } };
}

const now = () => new Date().toISOString();
const integrity = () => ({ source_redaction: 'unknown' as const, redacted: false, truncated: 'unknown' as const });
const safe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'string' ? redact(v) : v));
const unavailable = { state: 'unavailable', reason: 'source-not-provided' };

export class Harness {
  journal: Journal;
  source: Source;
  computerCalls: ComputerCalls;
  taskHistory: TaskCollector;
  workflowHistory: WorkflowHistory;
  conversations: ConversationHistory;
  changes: Changes;
  controls: HarnessControls;
  projects = new Map<string, Project>();
  tickets = new Map<string, Ticket>();
  bindings = new Map<string, Binding>();
  imported = new Set<string>();
  observations = new Map<string, string>();
  threads = new Map<string, string>();
  attributions = new Map<string, unknown>();
  sourceFailure: string | null = null;
  checkedAt: string | null = null;
  timer: ReturnType<typeof setInterval> | null = null;
  startupCursor = 0;
  recoveryReconciled = false;
  constructor(runtime: string, source: Source, tasks?: TaskSource, workflowOptions: WorkflowSourceOptions = {},
    controlOptions: HarnessControlOptions = {}) {
    this.source = source;
    this.journal = new Journal(runtime);
    for (const record of this.journal.records) this.apply(record);
    this.startupCursor = this.journal.records.length;
    this.computerCalls = new ComputerCalls(this.journal, id => this.ticket(id));
    this.taskHistory = new TaskCollector(this.journal, id => this.ticket(id), tasks);
    this.workflowHistory = new WorkflowHistory(this.journal, id => this.ticket(id), new WorkflowSource(source, workflowOptions));
    this.conversations = new ConversationHistory(this.journal, source, this.workflowHistory, id => this.ticket(id), this.bindings);
    this.changes = new Changes(source, new ChangesSource({ git: workflowOptions.git }));
    this.controls = new HarnessControls(this.journal, source, this.taskHistory, id => this.ticket(id),
      this.bindings, this.observations, controlOptions);
  }
  private apply(record: RecordEntry) {
    const data = record.data;
    if (data.kind === 'registered') {
      this.projects.set(data.project.id, data.project); this.tickets.set(data.ticket.id, data.ticket);
    } else if (data.kind === 'attached') this.bindings.set(data.binding.id, data.binding);
    else if (data.kind === 'child_conversation_associated') this.bindings.set(data.association.binding.id, data.association.binding);
    else if (data.kind === 'event') {
      const e = data.event;
      if (e.source_seq !== null) this.imported.add(e.run_id + ':' + e.source_seq);
      if (e.kind === 'source.snapshot') this.observations.set(e.binding_id + ':' + e.run_id, JSON.stringify(e.payload));
      if (e.thread_id) this.threads.set(e.session_id, e.thread_id);
    }
  }
  private write(data: Operation) { const record = this.journal.append(data); this.apply(record); return record; }
  private ticket(id: string) { const ticket = this.tickets.get(id); if (!ticket) throw new HarnessError('TICKET_NOT_FOUND'); return ticket; }
  register(input: unknown) {
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) throw new HarnessError('INVALID_REGISTRATION');
    const value = safe(parsed.data) as typeof parsed.data;
    const project = [...this.projects.values()].find(p => p.key === value.project_key)
      ?? { id: randomUUID(), key: value.project_key, name: value.project_name };
    if (project.name !== value.project_name) throw new HarnessError('REGISTRATION_CONFLICT');
    const old = [...this.tickets.values()].find(t => t.project_id === project.id && t.key === value.ticket_key);
    if (old && (old.title !== value.title || old.reference !== value.reference || old.expected_worktree !== (value.expected_worktree ?? null))) throw new HarnessError('REGISTRATION_CONFLICT');
    let comparisonBaseline = null, comparisonBaselineGap = null;
    if (value.expected_worktree && value.fixed_point) {
      try { comparisonBaseline = this.changes.facts.capture(value.expected_worktree, value.fixed_point); }
      catch (error) {
        const code = error instanceof ChangesSourceError ? error.code : 'GIT_UNAVAILABLE';
        comparisonBaselineGap = { code, source: 'git/filesystem' as const, impact: 'comparison baseline could not be recorded at registration' };
      }
    } else comparisonBaselineGap = { code: 'BASELINE_NOT_RECORDED' as const, source: 'git/filesystem' as const,
      impact: 'expected_worktree and fixed_point are both required to record a comparison baseline' };
    if (old) {
      const sameBaseline = old.comparison_baseline && comparisonBaseline
        ? old.comparison_baseline.repository_id === comparisonBaseline.repository_id
          && old.comparison_baseline.repository_instance_id === comparisonBaseline.repository_instance_id
          && old.comparison_baseline.worktree_root === comparisonBaseline.worktree_root
          && old.comparison_baseline.commit_oid === comparisonBaseline.commit_oid
        : old.comparison_baseline === comparisonBaseline
          && old.comparison_baseline_gap?.code === comparisonBaselineGap?.code;
      if (!sameBaseline) throw new HarnessError('REGISTRATION_CONFLICT');
    }
    const ticket = old ?? { id: randomUUID(), project_id: project.id, key: value.ticket_key,
      title: value.title, reference: value.reference, main_conversation_id: randomUUID(), expected_worktree: value.expected_worktree ?? null,
      comparison_baseline: comparisonBaseline, comparison_baseline_gap: comparisonBaselineGap };
    if (!old) this.write({ kind: 'registered', project, ticket });
    return { project_id: project.id, ticket_id: ticket.id, conversation_id: ticket.main_conversation_id, deduplicated: !!old };
  }
  recordWorkflow(input: unknown) { return this.workflowHistory.record(input); }
  associateChildConversation(input: unknown) { const result = this.conversations.associate(input); this.scan(true); return result; }
  attach(input: unknown) {
    const parsed = attachSchema.safeParse(input);
    if (!parsed.success) throw new HarnessError('INVALID_ATTACHMENT');
    const value = parsed.data, ticket = this.ticket(value.ticket_id);
    const session = this.source.session(value.session_id);
    const runs = this.source.runs(session.id);
    if (value.run_id && !runs.some(r => r.id === value.run_id)) throw new HarnessError('ATTRIBUTION_MISMATCH', { reason: 'run-session-mismatch' });
    const others = [...this.bindings.values()].filter(b => b.session_id === session.id);
    const conflict = others.find(b => (b.ticket_id !== ticket.id || b.conversation_id !== ticket.main_conversation_id)
      && (!value.run_id || b.scope === 'session' || b.run_id === value.run_id));
    if (conflict) throw new HarnessError(conflict.conversation_id === this.tickets.get(conflict.ticket_id)?.main_conversation_id
      ? 'ATTRIBUTION_MISMATCH' : 'ATTRIBUTION_CONFLICT', { ticket_id: conflict.ticket_id, binding_id: conflict.id,
      conversation_id: conflict.conversation_id });
    const old = others.find(b => b.ticket_id === ticket.id && b.run_id === (value.run_id ?? null));
    const binding: Binding = old ?? { id: randomUUID(), ticket_id: ticket.id, conversation_id: ticket.main_conversation_id,
      source_id: this.journal.sourceId, session_id: session.id, scope: value.run_id ? 'run' : 'session',
      run_id: value.run_id ?? null, attached_at: now() };
    if (!old) {
      const previous = [...this.bindings.values()].filter(b => b.ticket_id === ticket.id).at(-1);
      this.write({ kind: 'attached', binding, previous_session_id: previous?.session_id ?? null });
    }
    this.scan(true);
    return { ...binding, deduplicated: !!old, recording: this.health() };
  }
  private event(binding: Binding, fields: Partial<Event> & Pick<Event, 'kind' | 'payload'>) {
    const original = JSON.stringify(fields.payload), payload = safe(fields.payload);
    this.write({ kind: 'event', event: { ticket_id: binding.ticket_id, conversation_id: binding.conversation_id,
      binding_id: binding.id, session_id: binding.session_id, run_id: null, thread_id: null, source_seq: null, source_at: null,
      ...fields, payload, integrity: { ...integrity(), ...fields.integrity, redacted: original !== JSON.stringify(payload) } } });
  }
  private recover() {
    if (this.recoveryReconciled) return;
    this.recoveryReconciled = true;
    if (this.journal.failure) return;
    for (const binding of this.bindings.values()) {
      const gaps = new Set<string>();
      let session: ReturnType<Source['session']> | null = null;
      try { session = this.source.session(binding.session_id); }
      catch { gaps.add('SESSION_UNAVAILABLE'); }
      let runs: ReturnType<Source['runs']> = [];
      try {
        runs = this.source.runs(binding.session_id).filter(run => binding.scope === 'session' || run.id === binding.run_id);
        if (!runs.length) gaps.add('RUN_UNAVAILABLE');
      } catch { gaps.add('RUN_UNAVAILABLE'); }
      for (const run of runs) {
        try { this.source.events(run); }
        catch { gaps.add('SOURCE_EVENTS_UNAVAILABLE'); }
      }
      let attribution: unknown = { state: 'unknown', source: 'current attribution unavailable' };
      try {
        attribution = this.source.attribution(this.ticket(binding.ticket_id), session ?? undefined);
        const state = (attribution as { state?: string } | null)?.state;
        if (state === 'attribution mismatch') gaps.add('ATTRIBUTION_CONFLICT');
        else if (state !== 'matched') gaps.add('ATTRIBUTION_UNAVAILABLE');
      } catch { gaps.add('ATTRIBUTION_UNAVAILABLE'); }
      const highWater = new Map<string, number | null>();
      for (const record of this.journal.records) {
        if (record.data.kind !== 'event' || record.data.event.binding_id !== binding.id || !record.data.event.run_id) continue;
        const runId = record.data.event.run_id, sequence = record.data.event.source_seq;
        const previous = highWater.get(runId) ?? null;
        highWater.set(runId, sequence === null ? previous : previous === null ? sequence : Math.max(previous, sequence));
      }
      for (const run of runs) if (!highWater.has(run.id)) highWater.set(run.id, null);
      if (binding.run_id && !highWater.has(binding.run_id)) highWater.set(binding.run_id, null);
      const sourceHighWater = [...highWater].map(([run_id, source_seq]) => ({ run_id, source_seq }));
      try {
        this.event(binding, { kind: 'recovery.observed', run_id: binding.run_id,
          payload: { journal: { source_id: this.journal.sourceId, startup_cursor: this.startupCursor, source_high_water: sourceHighWater },
            binding: { id: binding.id, ticket_id: binding.ticket_id, conversation_id: binding.conversation_id,
              session_id: binding.session_id, scope: binding.scope, run_id: binding.run_id },
            session: session ? { state: 'observed', id: session.id, cwd: session.cwd, thread_id: session.codex_thread_id }
              : { state: 'unavailable', id: binding.session_id, cwd: null, thread_id: null },
            runs: runs.map(run => ({ id: run.id, status: run.status, exit_code: run.exit_code })),
            attribution, gaps: [...gaps] } });
      } catch (error) {
        if (this.journal.failure) return;
        throw error;
      }
    }
  }
  scan(refresh = false) {
    if (this.journal.failure) return;
    this.taskHistory.scan();
    this.workflowHistory.scan();
    let failure = false;
    for (const binding of this.bindings.values()) {
      try {
        const session = this.source.session(binding.session_id);
        if (refresh || !this.attributions.has(binding.id)) this.attributions.set(binding.id, this.source.attribution(this.ticket(binding.ticket_id), session));
        const runs = this.source.runs(binding.session_id).filter(r => binding.scope === 'session' || r.id === binding.run_id);
        if (!runs.length) throw new Error('Bound source run is unavailable');
        for (const run of runs) {
          const snapshot = safe({ run, permissions: session.permissions, attribution: this.attributions.get(binding.id) });
          const key = binding.id + ':' + run.id;
          if (this.observations.get(key) !== JSON.stringify(snapshot)) this.event(binding, { kind: 'source.snapshot', run_id: run.id, payload: snapshot });
          for (const event of this.source.events(run)) {
            if (this.imported.has(run.id + ':' + event.seq)) continue;
            const data = event.data as { type?: string; thread_id?: string; error?: { code?: string } } | null;
            if (event.type === 'codex' && data?.type === 'thread.started' && data.thread_id) {
              const previous = this.threads.get(session.id);
              if (previous && previous !== data.thread_id) this.event(binding, { kind: 'thread.switched', run_id: run.id,
                thread_id: data.thread_id, payload: { previous_thread_id: previous, thread_id: data.thread_id } });
            }
            this.event(binding, { kind: event.type, run_id: run.id, thread_id: event.type === 'codex' && data?.type === 'thread.started' ? data.thread_id ?? null : this.threads.get(session.id) ?? null,
              source_seq: event.seq, source_at: event.at, payload: event.data,
              integrity: { ...integrity(), truncated: data?.error?.code === 'OUTPUT_LIMIT' ? 'source-output-limit' : 'unknown' } });
          }
        }
      } catch { failure = true; }
    }
    this.sourceFailure = failure ? 'SOURCE_UNAVAILABLE' : null;
    this.checkedAt = now();
  }
  start(interval = 1000) { this.recover(); this.scan(true); this.timer ??= setInterval(() => this.scan(), interval); this.timer.unref(); }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; this.scan(); this.taskHistory.close(); }
  health() {
    const computer = this.computerCalls.health();
    const tasks = this.taskHistory.health();
    const workflow = { state: this.journal.failure ? 'recording-failed' : 'recording',
      reason: this.journal.failure, source: 'structured-workflow-evidence' };
    return { state: this.journal.failure ? 'recording-failed' : this.sourceFailure || this.computerCalls.collectionFailure || this.taskHistory.collectionFailure ? 'collection-failed' : 'recording',
      reason: this.journal.failure ?? this.sourceFailure ?? computer.reason ?? tasks.reason, source_id: this.journal.sourceId,
      observed_at: this.checkedAt, sources: { computer, tasks, workflow } };
  }
  executionGate(category: HarnessExecutionCategory) {
    const recording = this.health();
    const rejected = category === 'new-side-effect' && recording.state !== 'recording'
      || category === 'record-only' && recording.state === 'recording-failed';
    if (rejected) {
      const code = recording.state === 'recording-failed' ? 'RECORDING_FAILED' : 'COLLECTION_FAILED';
      throw new HarnessError(code, { category, recording });
    }
    return {
      recording,
      evidence_gap: recording.state === 'recording' ? null : {
        state: recording.state,
        reason: recording.reason,
        observed_at: recording.observed_at,
        source_id: recording.source_id,
      },
    };
  }
  overview() {
    return { projects: [...this.projects.values()].map(p => ({ ...p, tickets: [...this.tickets.values()].filter(t => t.project_id === p.id)
      .map(ticket => ({ ...ticket, workflow: this.workflowHistory.summary(ticket.id),
        changes: this.changes.summary(ticket) })) })),
      recording: this.health(), workflow: unavailable,
      changes: { state: 'available', source: 'per-ticket-git-filesystem-refresh' }, acceptance: unavailable, services: unavailable };
  }
  detail(id: string, after = 0) {
    const ticket = this.ticket(id);
    if (!Number.isSafeInteger(after) || after < 0 || after > this.journal.records.length) throw new HarnessError('INVALID_CURSOR');
    const all = this.journal.records.filter(r => r.cursor > after && (
      r.data.kind === 'registered' && r.data.ticket.id === id ||
      r.data.kind === 'attached' && r.data.binding.ticket_id === id ||
      r.data.kind === 'event' && r.data.event.ticket_id === id && r.data.event.conversation_id === ticket.main_conversation_id ||
      r.data.kind === 'computer_call' && r.data.call.ticket_id === id ||
      r.data.kind === 'control_action' && r.data.control.ticket_id === id ||
      r.data.kind === 'owned_task' && r.data.task.binding.ticket_id === id ||
      (r.data.kind === 'workflow_snapshot' || r.data.kind === 'workflow_observation') && r.data.workflow.ticket_id === id));
    const records = all.slice(0, 100);
    const workflow = this.conversations.projectWorkflow(id, this.workflowHistory.detail(id));
    const workflowFixedPoint = (workflow.current as { subject?: { fixed_point?: string | null } } | null)?.subject?.fixed_point ?? null;
    return { ticket, main_conversation: { conversation_id: ticket.main_conversation_id },
      child_conversations: this.conversations.summary(id), records,
      next_cursor: records.at(-1)?.cursor ?? after, has_more: all.length > records.length,
      recording: this.health(), computer_calls: this.computerCalls.status(id),
      owned_tasks: this.taskHistory.status(id), controls: this.controls.view(id, this.sourceFailure),
      current: { state: this.health().state !== 'recording' || !this.checkedAt ? 'unknown' : 'observed', observed_at: this.checkedAt },
      workflow, changes: this.changes.view(ticket, this.bindings.values(), workflowFixedPoint), source_gaps: [
        '未提供的工具正文/重试细节及接入前缺失日志：unavailable / source-not-provided',
        '尚未出现的 thread、消息或结果：unknown / not-yet-observed',
        '旧源逐事件脱敏标志：unknown；记录不是未经处理的完整原文',
      ] };
  }
  conversationDetail(id: string, after = 0) { return this.conversations.detail(id, after); }
  refreshControls(id: string) { this.executionGate('observe'); return this.controls.refresh(id, () => this.scan(true), () => this.sourceFailure); }
  stopRun(id: string, runId: string) { this.executionGate('manage-existing'); return this.controls.stopRun(id, runId); }
  stopTask(id: string, taskId: string) { this.executionGate('manage-existing'); return this.controls.stopTask(id, taskId); }
  openWorktree(id: string) { this.executionGate('manage-existing'); return this.controls.openWorktree(id); }
}
