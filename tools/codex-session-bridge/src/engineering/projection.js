import { HarnessError } from '../harness/model.ts';
import { workDigest } from '../orchestration/work-items.ts';
import { protectedCopy } from '../harness/content-policy.ts';

const dataTicket = data => {
  switch (data.kind) {
    case 'registered': return data.ticket.id;
    case 'attached': return data.binding.ticket_id;
    case 'event': return data.event.ticket_id;
    case 'computer_call': return data.call.ticket_id;
    case 'owned_task': return data.task.binding.ticket_id;
    case 'workflow_snapshot': case 'workflow_observation': return data.workflow.ticket_id;
    case 'child_conversation_associated': return data.association.conversation.ticket_id;
    case 'execution_operation_reserved': case 'execution_operation_transitioned': case 'execution_operation_bound': return data.operation.ticket_id;
    case 'work_item_transitioned': return data.item?.delivery_item_id;
    case 'control_action': return data.control.ticket_id;
    default: return data.ticket_id ?? null;
  }
};
export function projectEngineeringEvent(record, mainConversation) {
  const d = record.data;
  let category = d.kind, payload, conversation = mainConversation, session = null, run = null,
    workItem = null, generation = null, operation = null, sourceAt = null, integrity = { redacted: 'unknown',
      truncated: 'unknown', incomplete: 'unknown', gaps: [] }, backend = null;
  if (d.kind === 'event') {
    const event = d.event;
    conversation = event.conversation_id; session = event.session_id; run = event.run_id;
    sourceAt = event.source_at; integrity = { ...integrity, ...event.integrity };
    const itemType = event.payload?.item?.type ?? event.payload?.type ?? event.kind;
    // Public messages, tools and lifecycle only. Internal reasoning is not a UI transcript.
    if (/reasoning|analysis|chain.of.thought/i.test(itemType)) return null;
    category = /command|tool|mcp|file_change/i.test(itemType) ? 'tool/command'
      : /message|progress|output/i.test(itemType) ? 'message/progress' : 'run-lifecycle';
    payload = { kind: event.kind, ...event.payload };
    backend = event.kind === 'codex' || event.kind === 'source.snapshot' ? 'codex' : event.payload?.backend_kind ?? 'unknown';
  } else if (d.kind.startsWith('execution_operation_')) {
    const op = d.operation;
    category = 'operation'; operation = op.operation_id; conversation = op.destination.conversation_id;
    session = op.runtime.session_id; run = op.runtime.run_id; workItem = op.work_item?.item?.work_item_id ?? null;
    generation = op.work_item?.item?.generations?.at(-1)?.generation ?? null;
    payload = { state: op.state, request_id: op.request_id, work_item: op.work_item?.item ?? null,
      destination: op.destination, runtime: op.runtime, dispatch: op.dispatch ?? null };
    backend = 'codex';
  } else if (d.kind === 'engineering_plan') {
    category = 'plan'; payload = { plan_id: d.plan_id, request_id: d.request_id, kind: d.input.kind,
      action: d.input.input.action ?? 'verification', digest: d.digest };
  } else if (d.kind === 'engineering_preview') {
    category = 'preview'; payload = { preview_id: d.preview_id, plan_id: d.plan_id, digest: d.digest, expires_at: d.expires_at };
  } else if (d.kind === 'engineering_changes') {
    category = 'changes-invalidated'; payload = { digest: d.digest };
  } else if (d.kind === 'computer_call') {
    category = 'tool/command'; conversation = d.call.conversation_id; payload = d.call;
    sourceAt = d.call.source_at; integrity = d.call.integrity; backend = 'yca-sync-public-result';
  } else if (d.kind === 'owned_task') {
    category = 'engineering-task'; conversation = d.task.binding.conversation_id; payload = d.task;
    sourceAt = d.task.source_at; integrity = d.task.integrity; backend = d.task.source;
  } else if (d.kind === 'workflow_snapshot' || d.kind === 'workflow_observation') {
    category = 'workflow/review/acceptance'; payload = d.workflow; conversation = d.workflow.conversation_id;
  } else payload = d;
  const safe = protectedCopy({ schema_version: 1, source_id: record.source_id, event_id: record.event_id,
    cursor: record.cursor, source_at: sourceAt, observed_at: record.observed_at,
    source_ref: 'journal:' + record.source_id + ':' + record.cursor, ticket_id: dataTicket(d),
    conversation_id: conversation, work_item_id: workItem, generation, operation_id: operation,
    session_id: session, run_id: run, backend_kind: backend, category, payload, integrity }).value;
  if (Buffer.byteLength(JSON.stringify(safe.payload)) > 24 * 1024) {
    safe.payload = { preview: JSON.stringify(safe.payload).slice(0, 4096), state: 'truncated' };
    safe.integrity = { ...safe.integrity, truncated: true, incomplete: true, gaps: ['EVENT_PAYLOAD_LIMIT'] };
  }
  return safe;
}

export class EngineeringProjection {
  constructor(manager, authority) { this.manager = manager; this.harness = manager.harness; this.authority = authority; }
  ticket(id) { return this.authority.ticket(id); }
  identity() {
    return { schema_version: 1, protocol_version: 1, service: 'yuki-engineering-runtime',
      source_id: this.harness.journal.sourceId, status: this.manager.closing ? 'stopping' : 'ok',
      capabilities: { managed_workflow: true, durable_events: true, current_diff: true, cumulative_diff: true,
        trusted_confirmation: true, engineering_tasks: true, generic_computer_tools: false,
        backends: { codex: 'implemented', dsh: 'unsupported' } } };
  }
  snapshot(ticketId) {
    const ticket = this.ticket(ticketId);
    this.harness.scan();
    const detail = this.harness.detail(ticketId, { after: 0, limit: 1 });
    const current = this.harness.changes.view(ticket, this.harness.bindings.values(), null, 'current');
    const digest = workDigest({ current: current.content_identity?.digest ?? null,
      files: current.files.map(file => [file.file_id, file.revision]), baseline: ticket.comparison_baseline?.commit_oid });
    const prior = this.authority.records('engineering_changes').filter(record => record.ticket_id === ticketId).at(-1);
    if (prior?.digest !== digest && !this.harness.journal.failure)
      this.harness.journal.append({ kind: 'engineering_changes', ticket_id: ticketId, digest, observed_at: new Date().toISOString() });
    const allItems = [...this.harness.executionOperations.workItems.items.values()].filter(item => item.delivery_item_id === ticketId);
    const allOperations = [...this.harness.executionOperations.operations.values()].filter(op => op.ticket_id === ticketId);
    const workItems = allItems.slice(-100);
    const operations = allOperations
      .slice(-100).map(op => this.harness.executionOperations.query(op.operation_id));
    const runs = [];
    const gaps = [...detail.source_gaps];
    if (allItems.length > 100 || allOperations.length > 100) gaps.push('SNAPSHOT_HISTORY_LIMIT: use durable events for older items/operations');
    for (const binding of this.harness.bindings.values()) {
      if (binding.ticket_id !== ticketId) continue;
      try {
        const session = this.harness.source.session(binding.session_id);
        for (const run of this.harness.source.runs(binding.session_id)) {
          if (binding.scope === 'run' && binding.run_id !== run.id || runs.some(value => value.run_id === run.id)) continue;
          runs.push({ session_id: session.id, run_id: run.id, conversation_id: binding.conversation_id,
            backend_kind: run.backend_kind ?? 'codex', model: run.model ?? null, reasoning: run.reasoning ?? null,
            service_tier: run.service_tier ?? null, permissions: session.permissions, status: run.status,
            source_ref: 'session:' + session.id + '/run:' + run.id });
        }
      } catch { gaps.push('BOUND_RUN_UNAVAILABLE:' + binding.id); }
    }
    const plans = this.authority.records('engineering_plan').filter(plan => plan.ticket_id === ticketId).slice(-50)
      .map(plan => ({ plan_id: plan.plan_id, request_id: plan.request_id, kind: plan.input.kind,
        action: plan.input.input.action ?? 'verification', label: plan.input.input.label ?? plan.input.input.action,
        created_at: plan.created_at, receipt: this.authority.operation(ticketId, plan.request_id) }));
    if (runs.length > 100) gaps.push('SNAPSHOT_RUN_LIMIT: use durable events for older runs');
    return protectedCopy({ ...this.identity(), ticket_id: ticketId, observed_at: new Date().toISOString(),
      high_water_cursor: this.harness.journal.records.at(-1)?.cursor ?? 0,
      ticket, main_conversation: detail.main_conversation, child_conversations: detail.child_conversations,
      work_items: workItems, operations, runs: runs.slice(-100), plans, workflow: detail.workflow,
      changes: { current: this.publicChanges(current), cumulative: this.publicChanges(detail.changes) }, recording: detail.recording,
      controls: detail.controls, owned_tasks: detail.owned_tasks, gaps,
      freshness: detail.recording.state === 'recording' ? 'current' : 'unknown' }).value;
  }
  publicChanges(changes) {
    const { payload: _payload, ...identity } = changes.content_identity ?? {};
    return { ...changes, ...(changes.content_identity ? { content_identity: identity } : {}),
      files: changes.files.map(file => ({ ...file, content: { ...file.content, preview: null } })) };
  }
  events(ticketId, { source_id, after = 0, until, limit = 100, conversation_id } = {}) {
    const ticket = this.ticket(ticketId);
    if (source_id !== this.harness.journal.sourceId) throw new HarnessError('SOURCE_CHANGED');
    const highWater = this.harness.journal.records.at(-1)?.cursor ?? 0;
    const bound = until ?? highWater;
    if (![after, bound, limit].every(Number.isSafeInteger) || after < 0 || bound < after ||
        bound > highWater || limit < 1 || limit > 100) throw new HarnessError('INVALID_CURSOR');
    const conversations = [ticket.main_conversation_id, ...this.harness.conversations.summary(ticketId).map(c => c.conversation_id)];
    if (conversation_id && !conversations.includes(conversation_id)) throw new HarnessError('CONVERSATION_NOT_FOUND');
    const matches = this.harness.journal.records.filter(record => record.cursor > after && record.cursor <= bound &&
      (dataTicket(record.data) ?? this.harness.bindings.get(record.data.binding_id)?.ticket_id) === ticketId)
      .map(record => {
        const event = projectEngineeringEvent(record, ticket.main_conversation_id);
        if (!event) return null;
        const operation = [...this.harness.executionOperations.operations.values()].find(value => value.ticket_id === ticketId
          && value.runtime.run_id === event.run_id && value.runtime.session_id === event.session_id && event.run_id);
        return operation ? { ...event, operation_id: operation.operation_id,
          work_item_id: operation.work_item?.item.work_item_id ?? null,
          generation: operation.work_item?.item.generation ?? null } : event;
      })
      .filter(event => event && (!conversation_id || event.conversation_id === conversation_id));
    const events = matches.slice(0, limit), hasMore = matches.length > events.length;
    return { schema_version: 1, source_id, ticket_id: ticketId, events,
      next_cursor: hasMore ? events.at(-1).cursor : bound, has_more: hasMore, high_water_cursor: bound };
  }
  patch(ticketId, { file_id, revision, mode = 'cumulative' }) {
    if (!['current', 'cumulative'].includes(mode)) throw new HarnessError('INVALID_DIFF_MODE');
    return { schema_version: 1, source_id: this.harness.journal.sourceId, ticket_id: ticketId, mode,
      ...this.harness.changes.patch(this.ticket(ticketId), file_id, revision, mode) };
  }
}
