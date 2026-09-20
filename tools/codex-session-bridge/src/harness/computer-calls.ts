import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { publicError } from '../errors.js';
import { HarnessError } from './model.ts';
import type { ComputerCall, ComputerTool, Ticket, RecordEntry } from './model.ts';
import type { Journal } from './journal.ts';
import { protectedCopy, sourceIntegrity } from './content-policy.ts';

type SaveState = 'recorded' | 'collection-failed' | 'recording-failed';
const now = () => new Date().toISOString();

export class ComputerCalls {
  journal: Journal;
  ticket: (id: string) => Ticket;
  pending = new Set<Promise<unknown>>();
  active = new Set<string>();
  latest = new Map<string, ComputerCall>();
  collectionFailure: string | null = null;
  observedAt: string | null = null;
  closing = false;
  constructor(journal: Journal, ticket: (id: string) => Ticket) {
    this.journal = journal; this.ticket = ticket;
    for (const record of journal.records) this.apply(record);
  }
  private apply(record: RecordEntry) {
    if (record.data.kind !== 'computer_call') return;
    const call = record.data.call;
    this.latest.set(call.call_id, call);
    this.observedAt = record.observed_at;
    if (call.capture === 'collection-failed') this.collectionFailure = 'SYNC_CONTENT_COLLECTION_FAILED';
  }
  private save(call: ComputerCall): SaveState {
    let safe: ComputerCall;
    let state: SaveState = 'recorded';
    try {
      const copy = protectedCopy(call);
      safe = copy.value;
      safe.integrity.redacted = copy.redacted;
    } catch {
      state = 'collection-failed';
      this.collectionFailure = 'SYNC_CONTENT_COLLECTION_FAILED';
      // Never reuse suspect payload, attribution, error messages or raw input.
      safe = { call_id: call.call_id, ticket_id: call.ticket_id, conversation_id: call.conversation_id,
        tool: call.tool, stage: call.stage, outcome: call.outcome, source: call.source, source_at: call.source_at,
        capture: 'collection-failed', input: null, result: null, error: null, attribution: null,
        integrity: { policy: 'bridge-redact-v1', redacted: false, source_redaction: 'unknown', truncated: 'unknown',
          incomplete: 'unknown', stdout: 'collection-failed', stderr: 'collection-failed', exit_code: 'collection-failed' } };
    }
    this.observedAt = now();
    try { this.apply(this.journal.append({ kind: 'computer_call', call: safe })); }
    catch (error) {
      if (error instanceof HarnessError && error.code === 'RECORDING_FAILED') return 'recording-failed';
      this.collectionFailure = 'SYNC_CONTENT_COLLECTION_FAILED';
      return 'collection-failed';
    }
    return state;
  }
  private attribution(ticket: Ticket, input: Record<string, unknown>) {
    const expected = ticket.expected_worktree;
    const observed = Object.fromEntries(['cwd', 'path', 'source', 'destination'].filter(k => typeof input[k] === 'string').map(k => [k, input[k] as string]));
    const mismatches = expected ? Object.entries(observed).filter(([key, value]) => {
      const relative = path.relative(expected, value);
      return key === 'cwd' ? relative !== '' : relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
    }).map(([key]) => key) : [];
    return { state: mismatches.length ? 'attribution mismatch' : expected && Object.keys(observed).length ? 'matched' : 'unknown',
      expected_worktree: expected, observed, mismatches, source: 'registered Ticket / explicit call arguments', observed_at: now() };
  }
  run(tool: ComputerTool, ticketId: string, input: Record<string, unknown>, action: () => unknown,
      failClosedOnRecordingFailure = false) {
    if (this.closing) throw new HarnessError('SHUTTING_DOWN');
    const ticket = this.ticket(ticketId); // Input/attribution error, never a recording gate.
    const work = this.perform(tool, ticket, input, action, failClosedOnRecordingFailure);
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  private async perform(tool: ComputerTool, ticket: Ticket, input: Record<string, unknown>, action: () => unknown,
      failClosedOnRecordingFailure: boolean) {
    const callId = randomUUID();
    const context = { call_id: callId, ticket_id: ticket.id, conversation_id: ticket.main_conversation_id,
      tool, source: 'yca-sync-public-result' as const, attribution: this.attribution(ticket, input) };
    this.active.add(callId);
    try {
      const started = this.save({ ...context, stage: 'started', source_at: now(), outcome: 'not-yet-observed',
        capture: 'observed', input, result: null, error: null, integrity: sourceIntegrity('started', null, null) });
      if (started === 'recording-failed' && failClosedOnRecordingFailure) throw new HarnessError('RECORDING_FAILED');
      let result: unknown = null, error: unknown = null, isError = false;
      try { result = await action(); }
      catch (cause) { isError = true; error = publicError(cause); }
      const saved = this.save({ ...context, stage: 'result', source_at: now(), outcome: isError ? 'failed' : 'succeeded',
        capture: 'observed', input: null, result, error, integrity: sourceIntegrity('result', result, error) });
      const receipt = { call_id: callId, ticket_id: ticket.id, started, result: saved,
        state: this.health().state, observed_at: this.observedAt };
      return { isError, response: { ...(isError ? { error } : result as Record<string, unknown>), harness_recording: receipt } };
    } finally { this.active.delete(callId); }
  }
  health() {
    return { state: this.journal.failure ? 'recording-failed' : this.collectionFailure ? 'collection-failed' : 'recording',
      reason: this.journal.failure ?? this.collectionFailure, observed_at: this.observedAt, source: 'yca-sync-public-result' };
  }
  status(ticketId: string) {
    return [...this.latest.values()].filter(c => c.ticket_id === ticketId).map(c => ({
      call_id: c.call_id, tool: c.tool, state: c.stage === 'result' ? c.outcome : 'unknown',
      reason: c.stage === 'result' ? null : this.active.has(c.call_id) ? 'not-yet-observed' : 'completion-not-recorded',
      capture: c.capture, source_at: c.source_at, current_process_state: 'unknown',
    }));
  }
  async drain() { this.closing = true; await Promise.allSettled([...this.pending]); }
}
