import { createHash, randomUUID } from 'node:crypto';
import { protectedCopy } from './content-policy.ts';
import { HarnessError } from './model.ts';
import type { Binding, RecordEntry, Source, Ticket } from './model.ts';
import type { Journal } from './journal.ts';
import type { WorkflowHistory } from './workflow.ts';
import { childAssociationSchema } from './conversation-model.ts';
import type { ChildAssociation, ChildConversation, ChildConversationAssociationRecord, IsolationAssessment } from './conversation-model.ts';

const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relationKey = (ticketId: string, relation: ChildAssociation['relation']) => ticketId + ':' + relation.kind + ':'
  + (relation.kind === 'review' ? relation.review_id + ':' + relation.participant : relation.acceptance_id);
const assessmentPriority = { verified: 0, unknown: 1, mismatch: 2 } as const;

export class ConversationHistory {
  journal: Journal;
  source: Source;
  workflow: WorkflowHistory;
  ticket: (id: string) => Ticket;
  bindings: Map<string, Binding>;
  conversations = new Map<string, ChildConversation>();
  relations = new Map<string, ChildConversation>();
  requests = new Map<string, ChildConversationAssociationRecord>();
  assessments = new Map<string, IsolationAssessment>();
  constructor(journal: Journal, source: Source, workflow: WorkflowHistory, ticket: (id: string) => Ticket,
    bindings: Map<string, Binding>) {
    this.journal = journal; this.source = source; this.workflow = workflow; this.ticket = ticket; this.bindings = bindings;
    for (const record of journal.records) this.apply(record);
  }
  apply(record: RecordEntry) {
    if (record.data.kind !== 'child_conversation_associated') return;
    const value = record.data.association;
    this.conversations.set(value.conversation.conversation_id, value.conversation);
    this.relations.set(relationKey(value.conversation.ticket_id, value.conversation.relation), value.conversation);
    this.requests.set(value.conversation.ticket_id + ':' + value.request_id, value);
    this.assessments.set(value.binding.id, value.isolation);
  }
  private relationExecution(input: ChildAssociation) {
    const current = this.workflow.current.get(input.ticket_id)?.snapshot;
    if (!current) throw new HarnessError('ATTRIBUTION_MISMATCH', { reason: 'workflow-not-observed' });
    let refs: string[];
    if (input.relation.kind === 'review') {
      const reviewId = input.relation.review_id;
      const review = current.reviews.find(value => value.review_id === reviewId);
      if (!review) throw new HarnessError('ATTRIBUTION_MISMATCH', { reason: 'review-not-observed' });
      refs = review.execution_refs ?? [];
    } else {
      const acceptance = current.acceptance;
      if (acceptance.acceptance_id !== input.relation.acceptance_id || acceptance.actor.method !== 'agent') {
        throw new HarnessError('ATTRIBUTION_MISMATCH', { reason: 'agent-acceptance-not-observed' });
      }
      refs = acceptance.execution_refs;
    }
    const matched = refs.some(id => {
      const ref = current.runtime_refs.find(value => value.runtime_ref_id === id);
      return ref?.kind === 'codex-run' && ref.session_id === input.session_id && ref.run_id === input.run_id;
    });
    if (!matched) throw new HarnessError('ATTRIBUTION_MISMATCH', { reason: 'workflow-execution-mismatch' });
    return current;
  }
  private assess(input: ChildAssociation): IsolationAssessment {
    const reasons: IsolationAssessment['reasons'] = [];
    let state: IsolationAssessment['state'] = 'verified';
    const add = (next: IsolationAssessment['state'], code: string, source: string) => {
      reasons.push({ code, source });
      if (assessmentPriority[next] > assessmentPriority[state]) state = next;
    };
    let session;
    try {
      session = this.source.session(input.session_id);
      if (session.id !== input.session_id) add('mismatch', 'SESSION_ID_MISMATCH', 'source.session');
    } catch { add('unknown', 'SESSION_SOURCE_UNAVAILABLE', 'source.session'); }
    let runs = [] as ReturnType<Source['runs']>;
    try {
      runs = this.source.runs(input.session_id);
      const target = runs.find(value => value.id === input.run_id);
      if (!target || target.session_id !== input.session_id) add('mismatch', 'RUN_SESSION_MISMATCH', 'source.runs');
      const first = [...runs].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))[0];
      if (target && first?.id !== target.id) add('mismatch', 'SESSION_REUSED_BEFORE_BOUND_RUN', 'source.runs');
    } catch { add('unknown', 'RUN_SOURCE_UNAVAILABLE', 'source.runs'); }
    const run = runs.find(value => value.id === input.run_id);
    if (run) {
      try {
        const events = this.source.events(run);
        const started = events.filter(event => event.type === 'codex'
          && (event.data as { type?: string } | null)?.type === 'thread.started');
        if (!started.length || !session?.codex_thread_id) add('unknown', 'THREAD_BOUNDARY_NOT_OBSERVED', 'source.events/session');
        else {
          const ids = new Set(started.map(event => (event.data as { thread_id?: string }).thread_id).filter(Boolean));
          if (ids.size !== 1 || !ids.has(session.codex_thread_id)) add('mismatch', 'THREAD_BOUNDARY_MISMATCH', 'source.events/session');
        }
      } catch { add('unknown', 'EVENT_SOURCE_UNAVAILABLE', 'source.events'); }
    }
    if (!reasons.length) reasons.push({ code: 'FRESH_EXECUTION_OBSERVED', source: 'workflow/source session/run/thread' });
    return { state, assessed_at: now(), reasons };
  }
  associate(raw: unknown) {
    let input: ChildAssociation;
    try { input = childAssociationSchema.parse(protectedCopy(childAssociationSchema.parse(raw)).value); }
    catch { throw new HarnessError('INVALID_CHILD_CONVERSATION_ASSOCIATION'); }
    const ticket = this.ticket(input.ticket_id);
    const fingerprint = digest(input);
    const prior = this.requests.get(input.ticket_id + ':' + input.request_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HarnessError('REQUEST_CONFLICT');
      return this.receipt(prior, true);
    }
    this.relationExecution(input);
    const session = this.source.session(input.session_id);
    const run = this.source.runs(session.id).find(value => value.id === input.run_id);
    if (!run || run.session_id !== session.id) throw new HarnessError('ATTRIBUTION_MISMATCH', { reason: 'run-session-mismatch' });
    const conflict = [...this.bindings.values()].find(binding => binding.session_id === input.session_id
      && (binding.scope === 'session' || binding.run_id === input.run_id));
    const key = relationKey(input.ticket_id, input.relation);
    const conversation = this.relations.get(key) ?? { conversation_id: randomUUID(), ticket_id: ticket.id,
      parent_conversation_id: ticket.main_conversation_id, relation: input.relation, created_at: now() };
    if (conflict) {
      if (conflict.conversation_id !== conversation.conversation_id) {
        throw new HarnessError('ATTRIBUTION_CONFLICT', { conversation_id: conflict.conversation_id, binding_id: conflict.id });
      }
      const existing = this.journal.records.find(record => record.data.kind === 'child_conversation_associated'
        && record.data.association.binding.id === conflict.id);
      if (existing?.data.kind === 'child_conversation_associated') return this.receipt(existing.data.association, true);
    }
    const previous = [...this.bindings.values()].filter(binding => binding.conversation_id === conversation.conversation_id).at(-1);
    const binding: Binding = { id: randomUUID(), ticket_id: ticket.id, conversation_id: conversation.conversation_id,
      source_id: this.journal.sourceId, session_id: input.session_id, scope: 'run', run_id: input.run_id, attached_at: now() };
    const association: ChildConversationAssociationRecord = { request_id: input.request_id, fingerprint, conversation,
      binding, previous_session_id: previous?.session_id ?? null, isolation: this.assess(input) };
    const entry = this.journal.append({ kind: 'child_conversation_associated', association });
    this.bindings.set(binding.id, binding); this.apply(entry);
    return this.receipt(association, false);
  }
  private receipt(value: ChildConversationAssociationRecord, deduplicated: boolean) {
    const entry = this.journal.records.find(record => record.data.kind === 'child_conversation_associated'
      && record.data.association.binding.id === value.binding.id)!;
    return { conversation_id: value.conversation.conversation_id, parent_conversation_id: value.conversation.parent_conversation_id,
      binding_id: value.binding.id, isolation: value.isolation, event_id: entry.event_id, cursor: entry.cursor, deduplicated,
      recording: { state: this.journal.failure ? 'recording-failed' : 'recording', reason: this.journal.failure,
        source_id: this.journal.sourceId } };
  }
  private summaryFor(conversation: ChildConversation) {
    const bindings = [...this.bindings.values()].filter(value => value.conversation_id === conversation.conversation_id);
    const assessments = bindings.map(value => this.assessments.get(value.id)).filter(Boolean) as IsolationAssessment[];
    const isolation = assessments.reduce((result, value) => assessmentPriority[value.state] > assessmentPriority[result.state] ? value : result,
      assessments[0] ?? { state: 'unknown', assessed_at: conversation.created_at,
        reasons: [{ code: 'SOURCE_NOT_PROVIDED', source: 'child conversation binding' }] });
    const snapshot = this.workflow.current.get(conversation.ticket_id)?.snapshot;
    const relation = conversation.relation.kind === 'review' ? (() => {
      const reviewRelation = conversation.relation;
      const review = snapshot?.reviews.find(value => value.review_id === reviewRelation.review_id);
      return { ...reviewRelation, original_review_id: review?.original_review_id ?? null,
        finding_refs: review?.finding_refs ?? [], workflow_isolated: review?.isolated ?? 'unknown' };
    })() : conversation.relation;
    return { ...conversation, relation, isolation, bindings: bindings.map(binding => ({ ...binding,
      isolation: this.assessments.get(binding.id) ?? null,
      thread_ids: [...new Set(this.journal.records.filter(record => record.data.kind === 'event'
        && record.data.event.binding_id === binding.id && record.data.event.thread_id).map(record =>
          record.data.kind === 'event' ? record.data.event.thread_id : null).filter(Boolean))] })) };
  }
  summary(ticketId: string) {
    return [...this.conversations.values()].filter(value => value.ticket_id === ticketId).map(value => this.summaryFor(value));
  }
  projectWorkflow(ticketId: string, workflow: ReturnType<WorkflowHistory['detail']>) {
    if (!workflow.current) return workflow;
    const children = this.summary(ticketId);
    return { ...workflow, current: { ...workflow.current,
      reviews: workflow.current.reviews.map(review => ({ ...review, child_conversations: children
        .filter(child => child.relation.kind === 'review' && child.relation.review_id === review.review_id)
        .map(child => ({ conversation_id: child.conversation_id, participant: child.relation.kind === 'review' ? child.relation.participant : null,
          isolation: child.isolation })) })),
      acceptance: { ...workflow.current.acceptance, child_conversations: children
        .filter(child => child.relation.kind === 'acceptance' && child.relation.acceptance_id === workflow.current!.acceptance.acceptance_id)
        .map(child => ({ conversation_id: child.conversation_id, isolation: child.isolation })) },
    } };
  }
  detail(id: string, after = 0) {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new HarnessError('CONVERSATION_NOT_FOUND');
    if (!Number.isSafeInteger(after) || after < 0 || after > this.journal.records.length) throw new HarnessError('INVALID_CURSOR');
    const all = this.journal.records.filter(record => record.cursor > after && (
      record.data.kind === 'child_conversation_associated' && record.data.association.conversation.conversation_id === id
      || record.data.kind === 'event' && record.data.event.conversation_id === id));
    const records = all.slice(0, 100), summary = this.summaryFor(conversation);
    return { ...summary, records, next_cursor: records.at(-1)?.cursor ?? after, has_more: all.length > records.length };
  }
}
