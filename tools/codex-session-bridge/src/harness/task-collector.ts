import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HarnessError } from './model.ts';
import type { Ticket, RecordEntry } from './model.ts';
import type { Journal } from './journal.ts';
import { protectedCopy } from './content-policy.ts';
import { taskIdentitySchema, taskRecordSchema, taskSnapshotSchema } from './task-model.ts';
import type { TaskBinding, TaskIdentity, TaskNotice, TaskRecord, TaskSnapshot } from './task-model.ts';
import type { TaskSource } from './task-source.ts';

const now = () => new Date().toISOString();
type Availability = 'observed' | 'collection-failed' | 'source-unavailable' | 'source-expired' | 'source-epoch-expired';
export class TaskCollector {
  journal: Journal;
  ticket: (id: string) => Ticket;
  source?: TaskSource;
  bindings = new Map<string, TaskBinding>();
  imported = new Set<string>();
  outputNext = new Map<string, number>();
  streamsObserved = new Map<string, Set<string>>();
  lifecycleNext = new Map<string, number>();
  snapshots = new Map<string, TaskSnapshot>();
  availability = new Map<string, Availability>();
  observed = new Map<string, string>();
  gaps = new Set<string>();
  collectionFailure: string | null = null;
  unsubscribe?: () => unknown;

  constructor(journal: Journal, ticket: (id: string) => Ticket, source?: TaskSource) {
    this.journal = journal; this.ticket = ticket; this.source = source;
    for (const record of journal.records) this.apply(record);
    this.unsubscribe = source?.subscribe((identity, event) => this.receive(identity, event));
  }
  validateTicket(id: string) { this.ticket(id); }
  private key(task: TaskRecord) {
    return [task.binding.source_id, task.binding.service_epoch, task.binding.task_id, task.category, task.seq].join(':');
  }
  private apply(record: RecordEntry) {
    if (record.data.kind !== 'owned_task') return;
    const task = record.data.task, id = task.binding.task_id;
    this.bindings.set(id, task.binding);
    if (task.seq !== null) {
      this.imported.add(this.key(task));
      if (task.category === 'output') {
        let next = this.outputNext.get(id) ?? 0;
        while (this.imported.has(this.key({ ...task, seq: next }))) next++;
        this.outputNext.set(id, next);
        const streams = this.streamsObserved.get(id) ?? new Set<string>();
        streams.add((task.payload as { stream: string }).stream);
        this.streamsObserved.set(id, streams);
      } else this.lifecycleNext.set(id, Math.max(this.lifecycleNext.get(id) ?? 0, task.seq + 1));
    }
    if (task.snapshot) this.snapshots.set(id, task.snapshot);
    if (['source-unavailable', 'source-expired', 'source-epoch-expired', 'collection-failed', 'observed'].includes(task.kind)) {
      this.availability.set(id, task.kind as Availability);
    }
    if (task.kind === 'lifecycle-gap') this.gaps.add(id + ':' + JSON.stringify(task.payload));
    if (task.integrity.capture === 'collection-failed') this.collectionFailure = 'TASK_COLLECTION_GAP';
  }
  private binding(identity: TaskIdentity) {
    const old = this.bindings.get(identity.task_id);
    if (old) {
      if (old.ticket_id !== identity.ticket_id || old.service_epoch !== identity.service_epoch) throw new HarnessError('ATTRIBUTION_MISMATCH');
      return old;
    }
    const copy = protectedCopy(identity);
    const parsed = taskIdentitySchema.parse(copy.value), ticket = this.ticket(parsed.ticket_id);
    const binding = { ...parsed, binding_id: randomUUID(), conversation_id: ticket.main_conversation_id,
      source_id: this.journal.sourceId, metadata_redacted: copy.redacted };
    // Accepted tasks retain in-epoch ownership even when durable recording fails.
    this.bindings.set(binding.task_id, binding);
    return binding;
  }
  private record(binding: TaskBinding, category: TaskRecord['category'], seq: number | null, kind: string,
    sourceAt: string | null, payload: unknown, snapshot: TaskSnapshot | null, failed = false): TaskRecord {
    const output = snapshot?.output;
    const stream = category === 'output' ? (payload as { stream?: string })?.stream : null;
    const seen = this.streamsObserved.get(binding.task_id);
    return { binding, category, seq, kind, source_at: sourceAt, source: 'yca-owned-task', payload, snapshot,
      integrity: { policy: 'bridge-redact-v1', script: 'source-not-provided', capture: failed ? 'collection-failed' : 'observed',
        redacted: false, source_redaction: output?.redacted ?? 'unknown',
        truncated: output ? output.stdout_truncated || output.stderr_truncated : 'unknown', incomplete: output?.incomplete ?? 'unknown',
        stdout: failed ? 'collection-failed' : output?.pipes_closed || stream === 'stdout' || seen?.has('stdout') ? 'observed' : 'not-yet-observed',
        stderr: failed ? 'collection-failed' : output?.pipes_closed || stream === 'stderr' || seen?.has('stderr') ? 'observed' : 'not-yet-observed',
        exit_code: failed ? 'collection-failed' : snapshot?.root_state === 'exited' ? 'observed'
          : snapshot?.finished_at ? 'source-not-provided' : 'not-yet-observed' } };
  }
  private save(task: TaskRecord) {
    if (task.seq !== null && this.imported.has(this.key(task))) return;
    const copy = protectedCopy(task);
    copy.value.integrity.redacted = copy.redacted || task.binding.metadata_redacted;
    this.apply(this.journal.append({ kind: 'owned_task', task: taskRecordSchema.parse(copy.value) }));
  }
  private gap(binding: TaskBinding) {
    this.collectionFailure = 'TASK_COLLECTION_GAP';
    if (this.availability.get(binding.task_id) === 'collection-failed') return;
    // Never reuse a suspect payload or an exception's potentially sensitive message.
    try { this.save(this.record(binding, 'observation', null, 'collection-failed', null, null, null, true)); }
    catch { /* Journal failure remains separately visible in health(). */ }
  }
  private receive(identity: TaskIdentity, event: TaskNotice) {
    let binding: TaskBinding | undefined;
    try {
      binding = this.binding(identity);
      if (event.category === 'lifecycle') this.lifecycleGap(binding, event.seq);
      this.save(this.record(binding, event.category, event.seq, event.kind, event.source_at, event.payload, event.snapshot));
      this.observed.set(binding.task_id, now());
    } catch {
      if (binding && !this.journal.failure) this.gap(binding);
      else if (!this.journal.failure) this.collectionFailure = 'TASK_COLLECTION_GAP';
    }
  }
  private lifecycleGap(binding: TaskBinding, next: number) {
    const recorded = this.lifecycleNext.get(binding.task_id) ?? 0;
    if (next <= recorded) return;
    const missing = { from: recorded, to_exclusive: next };
    const gapKey = binding.task_id + ':' + JSON.stringify(missing);
    if (!this.gaps.has(gapKey)) this.save(this.record(binding, 'observation', null, 'lifecycle-gap', null, missing, null, true));
  }
  private setAvailability(binding: TaskBinding, state: Availability) {
    if (this.availability.get(binding.task_id) === state) return;
    this.save(this.record(binding, 'observation', null, state, null, { state }, null));
    this.availability.set(binding.task_id, state);
  }
  scan() {
    if (this.journal.failure) return;
    if (this.source) {
      try { for (const identity of this.source.identities()) this.binding(identity); }
      catch { this.collectionFailure = 'TASK_COLLECTION_GAP'; }
    }
    for (const binding of this.bindings.values()) {
      try {
        if (!this.source) { this.setAvailability(binding, 'source-unavailable'); continue; }
        if (binding.service_epoch !== this.source.epoch()) { this.setAvailability(binding, 'source-epoch-expired'); continue; }
        const { snapshot, lifecycle_next } = this.source.observation(binding.task_id);
        let cursor = this.outputNext.get(binding.task_id) ?? 0;
        let more = true;
        while (more) {
          const page = this.source.output(binding.task_id, cursor);
          for (const line of page.events) {
            if (line.seq !== cursor++) throw Error('Invalid source output sequence');
            this.save(this.record(binding, 'output', line.seq, 'output', null, line, snapshot));
          }
          if (page.next_cursor !== cursor || (page.has_more && !page.events.length)) throw Error('Invalid source page');
          more = page.has_more;
        }
        this.lifecycleGap(binding, lifecycle_next);
        const safeSnapshot = protectedCopy(snapshot).value;
        if (JSON.stringify(this.snapshots.get(binding.task_id)) !== JSON.stringify(safeSnapshot)) {
          this.save(this.record(binding, 'observation', null, 'source.snapshot', null, null, snapshot));
        }
        // Availability is independent from historical collection gaps.
        if (this.availability.has(binding.task_id) && this.availability.get(binding.task_id) !== 'observed') this.setAvailability(binding, 'observed');
        else this.availability.set(binding.task_id, 'observed');
        this.observed.set(binding.task_id, now());
      } catch (error) {
        if (this.journal.failure) return;
        const code = (error as { code?: string })?.code;
        if (code === 'TASK_EXPIRED' || code === 'TASK_NOT_FOUND') {
          try { this.setAvailability(binding, code === 'TASK_EXPIRED' ? 'source-expired' : 'source-unavailable'); }
          catch { if (!this.journal.failure) this.gap(binding); }
        } else this.gap(binding);
      }
    }
  }
  health() {
    return { state: this.journal.failure ? 'recording-failed' : this.collectionFailure ? 'collection-failed' : 'recording',
      reason: this.journal.failure ?? this.collectionFailure, source: 'yca-owned-task' };
  }
  receipt(taskId: string) {
    return { task_id: taskId, ticket_id: this.bindings.get(taskId)?.ticket_id ?? null, ...this.health(),
      accepted: [...this.journal.records].some(r => r.data.kind === 'owned_task' && r.data.task.binding.task_id === taskId && r.data.task.kind === 'accepted')
        ? 'recorded' : this.journal.failure ? 'recording-failed' : 'collection-failed' };
  }
  target(ticketId: string, taskId: string) {
    const binding = this.bindings.get(taskId);
    if (!binding) throw new HarnessError('TASK_NOT_FOUND');
    if (binding.ticket_id !== ticketId) throw new HarnessError('TASK_NOT_FOUND');
    if (!this.source) throw new HarnessError('TASK_SOURCE_UNAVAILABLE');
    if (binding.service_epoch !== this.source.epoch()) throw new HarnessError('TASK_EPOCH_EXPIRED');
    return { binding, source: this.source };
  }
  currentStatus(ticketId: string) {
    this.ticket(ticketId);
    return [...this.bindings.values()].filter(binding => binding.ticket_id === ticketId).map(binding => {
      const fallback = this.snapshots.get(binding.task_id) ?? null;
      if (!this.source) return this.statusProjection(ticketId, binding, fallback, 'source-unavailable', null);
      if (binding.service_epoch !== this.source.epoch()) {
        return this.statusProjection(ticketId, binding, fallback, 'source-epoch-expired', null);
      }
      try {
        const snapshot = taskSnapshotSchema.parse(protectedCopy(this.source.observation(binding.task_id).snapshot).value);
        return this.statusProjection(ticketId, binding, snapshot, 'observed', now());
      } catch {
        return this.statusProjection(ticketId, binding, fallback, 'source-unavailable', null);
      }
    });
  }
  private statusProjection(ticketId: string, binding: TaskBinding, snapshot: TaskSnapshot | null,
    sourceState: Availability, observedAt: string | null) {
    const ticket = this.ticket(ticketId), expected = ticket.expected_worktree;
    return { binding, snapshot, source_state: sourceState,
      current: { state: sourceState === 'observed' && observedAt ? 'observed' as const : 'unknown' as const,
        observed_at: observedAt },
      attribution: { state: expected ? path.relative(expected, binding.cwd) === '' ? 'matched' : 'attribution mismatch' : 'unknown',
        expected_worktree: expected, cwd: binding.cwd, source: 'registered Ticket / accepted task cwd' } };
  }
  status(ticketId: string) {
    return [...this.bindings.values()].filter(b => b.ticket_id === ticketId).map(binding => {
      const snapshot = this.snapshots.get(binding.task_id) ?? null;
      const sourceState = this.availability.get(binding.task_id) ?? 'source-unavailable';
      return this.statusProjection(ticketId, binding, snapshot, sourceState,
        !this.journal.failure && sourceState === 'observed' ? this.observed.get(binding.task_id) ?? null : null);
    });
  }
  close() { this.scan(); this.unsubscribe?.(); this.unsubscribe = undefined; }
}
