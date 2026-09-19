import { randomUUID } from 'node:crypto';
import { redact } from '../errors.js';
import { Journal } from './journal.ts';
import { ComputerCalls } from './computer-calls.ts';
import { TaskCollector } from './task-collector.ts';
import type { TaskSource } from './task-source.ts';
import { HarnessError, registrationSchema, attachSchema } from './model.ts';
import type { Source, Project, Ticket, Binding, Event, Operation, RecordEntry } from './model.ts';

const now = () => new Date().toISOString();
const integrity = () => ({ source_redaction: 'unknown' as const, redacted: false, truncated: 'unknown' as const });
const safe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'string' ? redact(v) : v));
const unavailable = { state: 'unavailable', reason: 'source-not-provided' };

export class Harness {
  journal: Journal;
  source: Source;
  computerCalls: ComputerCalls;
  taskHistory: TaskCollector;
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
  constructor(runtime: string, source: Source, tasks?: TaskSource) {
    this.source = source;
    this.journal = new Journal(runtime);
    for (const record of this.journal.records) this.apply(record);
    this.computerCalls = new ComputerCalls(this.journal, id => this.ticket(id));
    this.taskHistory = new TaskCollector(this.journal, id => this.ticket(id), tasks);
  }
  private apply(record: RecordEntry) {
    const data = record.data;
    if (data.kind === 'registered') {
      this.projects.set(data.project.id, data.project); this.tickets.set(data.ticket.id, data.ticket);
    } else if (data.kind === 'attached') this.bindings.set(data.binding.id, data.binding);
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
    const ticket = old ?? { id: randomUUID(), project_id: project.id, key: value.ticket_key,
      title: value.title, reference: value.reference, main_conversation_id: randomUUID(), expected_worktree: value.expected_worktree ?? null };
    if (!old) this.write({ kind: 'registered', project, ticket });
    return { project_id: project.id, ticket_id: ticket.id, conversation_id: ticket.main_conversation_id, deduplicated: !!old };
  }
  attach(input: unknown) {
    const parsed = attachSchema.safeParse(input);
    if (!parsed.success) throw new HarnessError('INVALID_ATTACHMENT');
    const value = parsed.data, ticket = this.ticket(value.ticket_id);
    const session = this.source.session(value.session_id);
    const runs = this.source.runs(session.id);
    if (value.run_id && !runs.some(r => r.id === value.run_id)) throw new HarnessError('ATTRIBUTION_MISMATCH', { reason: 'run-session-mismatch' });
    const others = [...this.bindings.values()].filter(b => b.session_id === session.id);
    const conflict = others.find(b => b.ticket_id !== ticket.id && (!value.run_id || b.scope === 'session' || b.run_id === value.run_id));
    if (conflict) throw new HarnessError('ATTRIBUTION_MISMATCH', { ticket_id: conflict.ticket_id, binding_id: conflict.id });
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
  scan(refresh = false) {
    if (this.journal.failure) return;
    this.taskHistory.scan();
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
  start(interval = 1000) { this.scan(true); this.timer ??= setInterval(() => this.scan(), interval); this.timer.unref(); }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; this.scan(); this.taskHistory.close(); }
  health() {
    const computer = this.computerCalls.health();
    const tasks = this.taskHistory.health();
    return { state: this.journal.failure ? 'recording-failed' : this.sourceFailure || this.computerCalls.collectionFailure || this.taskHistory.collectionFailure ? 'collection-failed' : 'recording',
      reason: this.journal.failure ?? this.sourceFailure ?? computer.reason ?? tasks.reason, source_id: this.journal.sourceId,
      observed_at: this.checkedAt, sources: { computer, tasks } };
  }
  overview() {
    return { projects: [...this.projects.values()].map(p => ({ ...p, tickets: [...this.tickets.values()].filter(t => t.project_id === p.id) })),
      recording: this.health(), workflow: unavailable, changes: unavailable, acceptance: unavailable, services: unavailable };
  }
  detail(id: string, after = 0) {
    const ticket = this.ticket(id);
    if (!Number.isSafeInteger(after) || after < 0 || after > this.journal.records.length) throw new HarnessError('INVALID_CURSOR');
    const all = this.journal.records.filter(r => r.cursor > after && (
      r.data.kind === 'registered' && r.data.ticket.id === id ||
      r.data.kind === 'attached' && r.data.binding.ticket_id === id ||
      r.data.kind === 'event' && r.data.event.ticket_id === id ||
      r.data.kind === 'computer_call' && r.data.call.ticket_id === id ||
      r.data.kind === 'owned_task' && r.data.task.binding.ticket_id === id));
    const records = all.slice(0, 100);
    return { ticket, records, next_cursor: records.at(-1)?.cursor ?? after, has_more: all.length > records.length,
      recording: this.health(), computer_calls: this.computerCalls.status(id),
      owned_tasks: this.taskHistory.status(id),
      current: { state: this.health().state !== 'recording' || !this.checkedAt ? 'unknown' : 'observed', observed_at: this.checkedAt },
      workflow: unavailable, changes: unavailable, acceptance: unavailable, source_gaps: [
        '未提供的工具正文/重试细节及接入前缺失日志：unavailable / source-not-provided',
        '尚未出现的 thread、消息或结果：unknown / not-yet-observed',
        '旧源逐事件脱敏标志：unknown；记录不是未经处理的完整原文',
      ] };
  }
}
