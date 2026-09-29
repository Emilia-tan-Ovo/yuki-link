import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { permissionSelectionFingerprint } from '../permissions.js';
import type { Journal } from '../harness/journal.ts';
import { HarnessError } from '../harness/model.ts';
import type { Binding, RecordEntry, Source, Ticket } from '../harness/model.ts';
import { executionContentIdentitySchema, executionOperationSchema, executionReserveInputSchema } from '../harness/execution-model.ts';
import type { ExecutionContentIdentity, ExecutionOperation, ExecutionReserveInput, RequestedExecutionDestination,
  ResolvedExecutionDestination } from '../harness/execution-model.ts';
import type { IsolationAssessment } from '../harness/conversation-model.ts';
import { WorkItems, workDigest } from './work-items.ts';
import { verifyManagedReview } from './review-evidence.ts';
import { workItemDecisionSchema, workItemReferenceSchema } from '../harness/work-item-model.ts';

type ChildRelation = Extract<RequestedExecutionDestination, { kind: 'child' }>['relation'];

const now = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const activeRuntimeStatuses = new Set(['queued', 'starting', 'running', 'stopping']);
const claimStates = new Set(['reserved', 'dispatching', 'started', 'reconciliation-required']);

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value as object).sort()
    .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}

function comparisonDigest(kind: 'content_identity' | 'canonical_cwd', value: unknown) {
  return sha256(stable({ schema: 'execution-identity-compare-v1', kind, value }));
}

function destinationKey(ticketId: string, destination: RequestedExecutionDestination | ResolvedExecutionDestination) {
  if (destination.kind === 'main') return `${ticketId}:main`;
  const relation = destination.relation;
  return `${ticketId}:child:${relation.kind}:${relation.kind === 'review'
    ? `${relation.review_id}:${relation.participant}` : relation.acceptance_id}`;
}

export function runtimeRequestId(operationId: string) { return `execution:${operationId}`; }

export interface RuntimeRequestObservation {
  request_id: string;
  fingerprint: string;
  session_id: string;
  run_id: string;
  status: string;
}

type AuthorizationInput = Pick<ExecutionReserveInput, 'ticket_id' | 'destination' | 'authorization_boundary'>;
export type ExecutionAuthorizationValidator = (current: ExecutionOperation[], input: AuthorizationInput,
  runtimeClaims: Array<{ session_id: string; run_id: string; status: string }>) => boolean;

interface ExecutionDependencies {
  ticket(id: string): Ticket;
  bindings: Map<string, Binding>;
  source: Source;
  health(): { state: string; reason: string | null; source_id?: string | null };
  workflow(ticketId: string): { workflow_revision: number; snapshot: { subject: { subject_id: string } } } | undefined;
  currentIdentity(ticket: Ticket): unknown;
  assessWorkflow?(ticketId: string): { state: string };
  existingChild?(ticketId: string, relation: ChildRelation): {
    conversation_id: string; parent_conversation_id: string; relation: ChildRelation; created_at: string;
  } | undefined;
  assessChild?(sessionId: string, runId: string, conversationId: string): IsolationAssessment;
  authorizationValidator?: ExecutionAuthorizationValidator;
  onApplied?(record: RecordEntry): void;
}

export class ExecutionOperations {
  workItems: WorkItems;
  rawExecutions = new Map<string, Extract<RecordEntry['data'], { kind: 'raw_execution' }>>();
  journal: Journal;
  dependencies: ExecutionDependencies;
  operations = new Map<string, ExecutionOperation>();
  requests = new Map<string, ExecutionOperation>();
  reservations = new Map<string, ResolvedExecutionDestination>();
  latest = new Map<string, RecordEntry>();
  replayedDispatching = new Set<string>();
  uncertainRecording = false;

  constructor(journal: Journal, dependencies: ExecutionDependencies) {
    this.journal = journal; this.dependencies = dependencies;
    this.workItems = new WorkItems(dependencies.source);
    for (const record of journal.records) this.apply(record, true);
  }

  private apply(record: RecordEntry, replaying = false) {
    const data = record.data;
    if (data.kind === 'raw_execution') { this.rawExecutions.set(data.request_id, data); return; }
    if (data.kind === 'work_item_transitioned') {
      if (this.workItems.get(data.item.work_item_id).revision !== data.previous_revision)
        throw new HarnessError('WORK_ITEM_JOURNAL_INVALID');
      this.workItems.apply(data.item); return;
    }
    if (data.kind !== 'execution_operation_reserved' && data.kind !== 'execution_operation_transitioned'
      && data.kind !== 'execution_operation_bound') return;
    const operation = data.operation;
    if ('work_item' in operation && operation.work_item) this.workItems.apply(operation.work_item.item);
    const prior = this.operations.get(operation.operation_id);
    if (data.kind === 'execution_operation_reserved') {
      if (prior || operation.revision !== 1 || operation.state !== 'reserved') throw new HarnessError('EXECUTION_JOURNAL_INVALID');
    } else if (!prior || operation.revision !== prior.revision + 1 || data.previous_state !== prior.state) {
      throw new HarnessError('EXECUTION_JOURNAL_INVALID');
    }
    this.operations.set(operation.operation_id, operation);
    this.requests.set(`${operation.ticket_id}:${operation.request_id}`, operation);
    this.reservations.set(destinationKey(operation.ticket_id, operation.destination), operation.destination);
    this.latest.set(operation.operation_id, record);
    if (replaying && operation.state === 'dispatching') this.replayedDispatching.add(operation.operation_id);
    if (data.kind === 'execution_operation_bound') this.dependencies.bindings.set(data.binding.id, data.binding);
    if (!replaying) this.dependencies.onApplied?.(record);
  }

  private append(data: RecordEntry['data'], phase: string) {
    try {
      const record = this.journal.append(data);
      this.apply(record);
      return record;
    } catch (error) {
      this.uncertainRecording = true;
      if (error instanceof HarnessError && error.code === 'EXECUTION_JOURNAL_INVALID') throw error;
      throw new HarnessError('RECORDING_OUTCOME_UNKNOWN', { phase,
        reason: this.journal.failure ?? (error instanceof Error ? error.message : 'append outcome unknown') });
    }
  }

  private protected(input: ExecutionReserveInput) {
    let cwd: string;
    try { cwd = realpathSync(input.launch.cwd); } catch { throw new HarnessError('INVALID_EXECUTION_REQUEST', { field: 'launch.cwd' }); }
    const promptBytes = Buffer.byteLength(input.launch.prompt, 'utf8');
    if (!input.launch.prompt.trim() || promptBytes > 128 * 1024) {
      throw new HarnessError('INVALID_EXECUTION_REQUEST', { field: 'launch.prompt' });
    }
    const intent = {
      ...(input.work_item ? { work_item: input.work_item } : {}),
      ticket_id: input.ticket_id, destination: input.destination,
      expected_workflow_revision: input.expected_workflow_revision, subject_ref: input.subject_ref,
      content_identity: input.content_identity,
      launch: { cwd, prompt_sha256: sha256(input.launch.prompt), prompt_utf8_bytes: promptBytes,
        sender: input.launch.sender, model: input.launch.model, reasoning: input.launch.reasoning,
        timeout_ms: input.launch.timeout_ms,
        permission_selection: permissionSelectionFingerprint(input.launch.permissions ?? undefined) },
      authorization_boundary: input.authorization_boundary,
      ...('implementation' in input ? { implementation: input.implementation } : {}),
      ...('review' in input ? { review: input.review } : {}),
      ...('workflow_agent' in input ? { workflow_agent: input.workflow_agent } : {}),
    };
    return { intent: { ...intent, comparison: { schema_version: 1 as const,
      content_identity_sha256: comparisonDigest('content_identity', input.content_identity),
      canonical_cwd_sha256: comparisonDigest('canonical_cwd', cwd) } },
    fingerprint: sha256(stable(intent)) };
  }

  private runtimeClaim(operation: ExecutionOperation) {
    if (claimStates.has(operation.state)) return 'active';
    if (operation.state !== 'bound') return 'released';
    if (!operation.runtime.session_id || !operation.runtime.run_id) return 'unknown';
    try {
      const run = this.dependencies.source.runs(operation.runtime.session_id).find(value => value.id === operation.runtime.run_id);
      if (!run) return 'unknown';
      return activeRuntimeStatuses.has(run.status) ? 'active' : ['completed', 'failed', 'stopped', 'timed_out', 'interrupted'].includes(run.status)
        ? 'released' : 'unknown';
    } catch { return 'unknown'; }
  }

  private bindingClaims() {
    return [...this.dependencies.bindings.values()].map(binding => {
      try {
        const runs = this.dependencies.source.runs(binding.session_id)
          .filter(run => binding.scope === 'session' || run.id === binding.run_id);
        if (!runs.length) return { binding, state: 'unknown' as const };
        const active = runs.some(run => activeRuntimeStatuses.has(run.status));
        const unknown = runs.some(run => !activeRuntimeStatuses.has(run.status)
          && !['completed', 'failed', 'stopped', 'timed_out', 'interrupted'].includes(run.status));
        return { binding, state: active ? 'active' as const : unknown ? 'unknown' as const : 'released' as const };
      } catch { return { binding, state: 'unknown' as const }; }
    }).filter(value => value.state !== 'released');
  }

  reserve(raw: unknown) {
    const parsed = executionReserveInputSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessError('INVALID_EXECUTION_REQUEST', { issues: parsed.error.issues });
    const input = parsed.data;
    const { intent, fingerprint } = this.protected(input);
    const prior = this.requests.get(`${input.ticket_id}:${input.request_id}`);
    if (prior) {
      if (prior.protected_fingerprint !== fingerprint) throw new HarnessError('REQUEST_CONFLICT', { operation_id: prior.operation_id });
      return this.receipt(prior, true);
    }
    this.assertRawIdle();
    if (this.uncertainRecording || this.journal.failure) throw new HarnessError('RECORDING_OUTCOME_UNKNOWN', {
      phase: 'reserve', reason: this.journal.failure ?? 'prior append outcome unknown; checked restart required',
    });
    const ticket = this.dependencies.ticket(input.ticket_id);
    const key = destinationKey(input.ticket_id, input.destination);
    const active = [...this.operations.values()].filter(value => this.runtimeClaim(value) !== 'released');
    const sameDestination = active.find(value => destinationKey(value.ticket_id, value.destination) === key);
    if (sameDestination) throw new HarnessError('DESTINATION_BUSY', { operation_id: sameDestination.operation_id });
    const bindingClaims = this.bindingClaims();
    const requestedConversation = input.destination.kind === 'main' ? ticket.main_conversation_id
      : this.dependencies.existingChild?.(input.ticket_id, input.destination.relation)?.conversation_id ?? null;
    const bindingDestination = requestedConversation && bindingClaims.find(value => value.binding.conversation_id === requestedConversation);
    if (bindingDestination) throw new HarnessError('DESTINATION_BUSY', { binding_id: bindingDestination.binding.id });
    if (active.length || bindingClaims.length) {
      const allowed = this.dependencies.authorizationValidator?.(active, input, []) ?? false;
      if (!allowed) throw new HarnessError('MODEL_LINE_BUSY', { operation_ids: active.map(value => value.operation_id),
        binding_ids: bindingClaims.map(value => value.binding.id) });
    }
    const existing = this.reservations.get(key);
    const timestamp = now();
    let destination: ResolvedExecutionDestination = input.destination.kind === 'main'
      ? { kind: 'main', conversation_id: ticket.main_conversation_id }
      : existing?.kind === 'child' ? existing : (() => {
        const legacy = this.dependencies.existingChild?.(input.ticket_id, input.destination.relation);
        return { kind: 'child' as const, conversation_id: legacy?.conversation_id ?? randomUUID(),
        parent_conversation_id: legacy?.parent_conversation_id ?? ticket.main_conversation_id,
        relation: input.destination.relation, created_at: legacy?.created_at ?? timestamp,
        isolation: { state: 'unknown', assessed_at: timestamp,
          reasons: [{ code: 'EXECUTION_RESERVED_NOT_STARTED', source: 'execution operation journal' }] } };
      })();
    const implementation = 'implementation' in input;
    const review = 'review' in input;
    const workflowAgent = 'workflow_agent' in input;
    const workItem = this.workItems.prepare(input, this.operations, this.reviewObservations(input.ticket_id));
    // Review rounds have distinct report identities but keep the same isolated
    // work-item conversation; they never move a session into another owner's child.
    if (workItem?.item.purpose === 'focused-review' && workItem.item.operation_id && destination.kind === 'child') {
      const previous = this.operations.get(workItem.item.operation_id);
      if (!previous || previous.destination.kind !== 'child') throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
      destination = { ...destination, conversation_id: previous.destination.conversation_id,
        parent_conversation_id: previous.destination.parent_conversation_id, created_at: previous.destination.created_at };
    }
    const operationId = randomUUID();
    if (workItem) workItem.item.operation_id = operationId;
    const operation = executionOperationSchema.parse({
      ...(workItem ? { work_item: workItem } : {}),
      schema_version: workflowAgent ? 4 : review ? 3 : implementation ? 2 : 1, operation_id: operationId, ticket_id: input.ticket_id, request_id: input.request_id,
      fingerprint_version: workflowAgent ? 'execution-protected-v4' : review ? 'execution-protected-v3' : implementation ? 'execution-protected-v2' : 'execution-protected-v1',
      protected_fingerprint: fingerprint, protected_intent: intent,
      destination, state: 'reserved', revision: 1,
      runtime: { request_id: runtimeRequestId('00000000-0000-4000-8000-000000000000'), fingerprint: null,
        session_id: null, run_id: null, status: null },
      binding_id: null, dispatch: null, failure: null, created_at: timestamp, updated_at: timestamp,
    });
    operation.runtime.request_id = runtimeRequestId(operation.operation_id);
    this.append({ kind: 'execution_operation_reserved', operation }, 'reserve');
    return this.receipt(operation, false);
  }

  query(operationId: string) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new HarnessError('EXECUTION_OPERATION_NOT_FOUND');
    return this.receipt(operation, false);
  }

  // Called only with a decision loaded from the trusted authority adapter.
  private reviewObservations(ticketId: string) {
    const records = this.journal.records.flatMap(record => record.data.kind === 'workflow_snapshot'
      && record.data.workflow.ticket_id === ticketId ? [record.data.workflow] : []);
    const current = this.dependencies.workflow(ticketId);
    return current ? [...records, current] : records;
  }

  transitionWorkItem(raw: unknown) {
    if (this.uncertainRecording || this.journal.failure) throw new HarnessError('RECORDING_OUTCOME_UNKNOWN');
    const decision = workItemDecisionSchema.parse(raw);
    const item = this.workItems.get(decision.work_item_id);
    const workflow = this.dependencies.workflow(item.delivery_item_id);
    if (this.dependencies.assessWorkflow?.(item.delivery_item_id).state !== 'verified')
      throw new HarnessError('WORK_ITEM_EVIDENCE_CONFLICT');
    const identity = this.dependencies.currentIdentity(this.dependencies.ticket(item.delivery_item_id)) as any;
    if (!workflow || workflow.workflow_revision !== decision.workflow_revision
      || workflow.snapshot.subject.subject_id !== item.subject_ref || item.subject_ref !== decision.subject_ref
      || identity?.completeness !== 'complete' || identity.digest !== decision.content_version)
      throw new HarnessError('WORK_ITEM_EVIDENCE_CONFLICT');
    const observations = this.reviewObservations(item.delivery_item_id);
    const next = this.workItems.transition(item, decision, workflow.snapshot, this.operations,
      (owner, review, snapshot) => verifyManagedReview(owner, review, snapshot, identity.digest, {
        items: this.workItems, operations: this.operations, bindings: this.dependencies.bindings,
        source: this.dependencies.source, assessChild: this.dependencies.assessChild, observations }), observations);
    this.append({ kind: 'work_item_transitioned', previous_revision: item.revision, item: next,
      decision_ref: decision.decision_ref }, 'work-item-transition');
    return this.workItems.get(item.work_item_id);
  }

  reconcileWorkItem(raw: unknown) {
    const reference = workItemReferenceSchema.parse(raw);
    const item = this.workItems.get(reference.work_item_id);
    if (item.revision !== reference.revision) throw new HarnessError('WORK_ITEM_REVISION_CONFLICT');
    if (!item.operation_id) throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
    const operation = this.operation(item.operation_id);
    if (operation.state === 'reserved') {
      if (!this.dependencies.source.lookupRequest || this.dependencies.source.lookupRequest(operation.runtime.request_id))
        throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
      return this.failReserved(operation.operation_id, 'RESERVATION_NOT_DISPATCHED', 'Recovered before runtime dispatch');
    }
    if (operation.state === 'failed' || operation.state === 'bound') return this.reconcile(operation.operation_id);
    const lookup = this.lookup(operation);
    if (lookup.state !== 'matched' || !lookup.observation
      || !['queued', 'running', 'stopping', 'completed', 'failed', 'stopped', 'timed_out', 'interrupted'].includes(lookup.observation.status))
      throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
    this.markStarted(operation.operation_id);
    this.replayedDispatching.delete(operation.operation_id);
    return this.bind(operation.operation_id);
  }

  private assertRawIdle(except?: string) {
    for (const record of this.rawExecutions.values()) {
      if (record.request_id === except || record.state === 'failed') continue;
      const observation = this.dependencies.source.lookupRequest?.(record.request_id);
      if (!observation || !['completed', 'failed', 'stopped', 'timed_out', 'interrupted'].includes(observation.status))
        throw new HarnessError('RAW_EXECUTION_RECONCILIATION_REQUIRED');
    }
  }
  reserveRaw(input: any, grant: any) {
    if (this.uncertainRecording || this.journal.failure) throw new HarnessError('RECORDING_OUTCOME_UNKNOWN');
    this.assertRawOwnership(input);
    const prior = this.rawExecutions.get(input.request_id);
    if (prior) {
      if (prior.payload_digest !== workDigest(input) || prior.authorization_ref !== grant.authorization_ref)
        throw new HarnessError('REQUEST_CONFLICT');
      if (prior.state === 'dispatching' && !this.dependencies.source.lookupRequest?.(input.request_id))
        throw new HarnessError('RAW_EXECUTION_RECONCILIATION_REQUIRED');
      return;
    }
    this.assertRawIdle();
    if ([...this.operations.values()].some(operation => this.runtimeClaim(operation) !== 'released')
      || !this.dependencies.source.activeRuns || this.dependencies.source.activeRuns().length)
      throw new HarnessError('MODEL_LINE_BUSY');
    this.append({ kind: 'raw_execution', request_id: input.request_id, payload_digest: workDigest(input),
      authority_digest: grant.authority_digest, authorization_ref: grant.authorization_ref,
      category: grant.category, action: grant.action, state: 'reserved', reason: grant.reason }, 'raw-reserve');
  }
  guardRaw(input: any, grant: any) {
    if (this.uncertainRecording || this.journal.failure || this.dependencies.health().state !== 'recording')
      throw new HarnessError('RECORDING_OUTCOME_UNKNOWN');
    this.assertRawOwnership(input);
    this.assertRawIdle(input.request_id);
    const prior = this.rawExecutions.get(input.request_id);
    if (!prior || !['reserved', 'failed'].includes(prior.state) || prior.payload_digest !== workDigest(input)
      || prior.authority_digest !== grant.authority_digest) throw new HarnessError('RAW_EXECUTION_NOT_AUTHORIZED');
    if ([...this.operations.values()].some(operation => this.runtimeClaim(operation) !== 'released')
      || !this.dependencies.source.activeRuns || this.dependencies.source.activeRuns().length)
      throw new HarnessError('MODEL_LINE_BUSY');
    this.append({ ...prior, state: 'dispatching' }, 'raw-dispatch');
  }
  rawFailure(requestId: string) {
    const prior = this.rawExecutions.get(requestId);
    if (prior?.state === 'reserved') this.append({ ...prior, state: 'failed' }, 'raw-rejected');
  }

  private assertRawOwnership(input: { session_id?: string }) {
    if (input.session_id && [...this.workItems.items.values()].some(item =>
      item.generations.some(binding => binding.session_id === input.session_id)))
      throw new HarnessError('MANAGED_SESSION_REQUIRES_WORK_ITEM_GATE');
  }

  byRequest(ticketId: string, requestId: string) {
    const operation = this.requests.get(`${ticketId}:${requestId}`);
    if (!operation) throw new HarnessError('EXECUTION_OPERATION_NOT_FOUND');
    return this.receipt(operation, false);
  }

  findByRequest(ticketId: string, requestId: string) {
    const operation = this.requests.get(`${ticketId}:${requestId}`);
    return operation ? this.receipt(operation, true) : null;
  }

  private receipt(operation: ExecutionOperation, deduplicated: boolean, reconciliation?: Record<string, unknown>) {
    const latest = this.latest.get(operation.operation_id);
    const effective = operation.state === 'dispatching' && this.replayedDispatching.has(operation.operation_id)
      ? 'reconciliation-required' : operation.state;
    const implementation = operation.schema_version === 2 ? operation.protected_intent.implementation : null;
    const review = operation.schema_version === 3 ? operation.protected_intent.review : null;
    const workflowAgent = operation.schema_version === 4 ? operation.protected_intent.workflow_agent : null;
    return { operation_id: operation.operation_id, ticket_id: operation.ticket_id, request_id: operation.request_id,
      work_item: 'work_item' in operation && operation.work_item ? structuredClone(operation.work_item.item) : null,
      execution_mode: 'work_item' in operation ? operation.work_item?.mode ?? 'fresh' : 'fresh',
      continuation_session_id: 'work_item' in operation ? operation.work_item?.session_id ?? null : null,
      protected_fingerprint: operation.protected_fingerprint, fingerprint_version: operation.fingerprint_version,
      state: operation.state, effective_state: effective, destination: structuredClone(operation.destination),
      runtime: structuredClone(operation.runtime), binding_id: operation.binding_id,
      ...(implementation ? { caller_fingerprint: implementation.caller_fingerprint,
        contract: structuredClone(implementation.contract), policy: structuredClone(implementation.policy),
        authorization: structuredClone(implementation.authorization),
        ...(implementation.authority_source ? { authority_source: structuredClone(implementation.authority_source) } : {}),
        ...(implementation.companion_dispatch ? { companion_dispatch: structuredClone(implementation.companion_dispatch) } : {}),
        preflight: structuredClone(implementation.preflight),
        prompt_cost: implementation.prompt_context.cost ? structuredClone(implementation.prompt_context.cost) : null,
        actual_permissions: operation.dispatch ? structuredClone(operation.dispatch.permissions) : null } : {}),
      ...(review ? { caller_fingerprint: review.caller_fingerprint,
        contract: structuredClone(review.contract), policy: structuredClone(review.policy),
        authorization: structuredClone(review.authorization), authority_source: structuredClone(review.authority_source),
        ...(review.companion_dispatch ? { companion_dispatch: structuredClone(review.companion_dispatch) } : {}),
        preflight: structuredClone(review.preflight),
        actual_permissions: operation.dispatch ? structuredClone(operation.dispatch.permissions) : null } : {}),
      ...(workflowAgent ? { caller_fingerprint: workflowAgent.caller_fingerprint,
        action: workflowAgent.action, contract: structuredClone(workflowAgent.contract),
        policy: structuredClone(workflowAgent.policy), authorization: structuredClone(workflowAgent.authorization),
        authority_source: structuredClone(workflowAgent.authority_source),
        ...(workflowAgent.companion_dispatch ? { companion_dispatch: structuredClone(workflowAgent.companion_dispatch) } : {}),
        preflight: structuredClone(workflowAgent.preflight),
        actual_permissions: operation.dispatch ? structuredClone(operation.dispatch.permissions) : null } : {}),
      latest_event_id: latest?.event_id ?? null, latest_cursor: latest?.cursor ?? null, deduplicated,
      recording: { state: this.journal.failure ? 'recording-failed' : 'recording', reason: this.journal.failure,
        source_id: this.journal.sourceId }, reconciliation: reconciliation ?? null };
  }

  observations(ticketId: string) {
    return [...this.operations.values()].filter(value => value.ticket_id === ticketId)
      .map(value => ({ ...this.receipt(value, false), source_refs: ['harness'], provenance: {
        operation: `harness:${this.journal.sourceId}:execution:${value.operation_id}`,
        runtime_request: value.runtime.request_id,
      } }));
  }

  assertLegacyBindingAllowed(ticketId: string, conversationId: string) {
    const owner = [...this.operations.values()].find(value => value.ticket_id === ticketId
      && value.destination.conversation_id === conversationId && value.state !== 'failed');
    if (owner) throw new HarnessError('ATTRIBUTION_CONFLICT', { operation_id: owner.operation_id,
      conversation_id: owner.destination.conversation_id });
  }

  private operation(operationId: string) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new HarnessError('EXECUTION_OPERATION_NOT_FOUND');
    return operation;
  }

  private transition(current: ExecutionOperation, next: Partial<ExecutionOperation> & Pick<ExecutionOperation, 'state'>, phase: string) {
    if (this.uncertainRecording || this.journal.failure) throw new HarnessError('RECORDING_OUTCOME_UNKNOWN', {
      phase, reason: this.journal.failure ?? 'prior append outcome unknown; checked restart required',
    });
    const operation = executionOperationSchema.parse({ ...current, ...next, revision: current.revision + 1, updated_at: now() });
    this.append({ kind: 'execution_operation_transitioned', previous_state: current.state, operation }, phase);
    return operation;
  }

  guardDispatch(operationId: string, dispatch: { request_id: string; fingerprint: string; cwd: string; session_id?: string;
    config: { model: string; reasoning: string }; permissions: unknown; launch: {
      prompt_sha256: string; prompt_utf8_bytes: number; sender: string | null; model: string | null;
      reasoning: string | null; timeout_ms: number | null; permission_selection: unknown;
    } }) {
    const current = this.operation(operationId);
    if (current.state !== 'reserved') throw new HarnessError('EXECUTION_STATE_CONFLICT', { state: current.state });
    this.assertRawIdle();
    if (dispatch.request_id !== current.runtime.request_id) throw new HarnessError('RUNTIME_REQUEST_CONFLICT');
    if ('work_item' in current && current.work_item)
      this.workItems.guard(current.work_item, dispatch.session_id, dispatch.permissions);
    const health = this.dependencies.health();
    if (health.state !== 'recording') throw new HarnessError(health.state === 'recording-failed' ? 'RECORDING_FAILED' : 'COLLECTION_FAILED', { recording: health });
    const workflow = this.dependencies.workflow(current.ticket_id);
    if (!workflow || workflow.workflow_revision !== current.protected_intent.expected_workflow_revision) {
      throw new HarnessError('WORKFLOW_REVISION_CONFLICT', { expected_revision: current.protected_intent.expected_workflow_revision,
        actual_revision: workflow?.workflow_revision ?? null });
    }
    if (workflow.snapshot.subject.subject_id !== current.protected_intent.subject_ref) {
      throw new HarnessError('SUBJECT_REF_CONFLICT');
    }
    const ticket = this.dependencies.ticket(current.ticket_id);
    const rawIdentity = this.dependencies.currentIdentity(ticket) as Record<string, unknown> | null;
    const currentIdentity = executionContentIdentitySchema.safeParse(rawIdentity && {
      scheme: rawIdentity.scheme, version: rawIdentity.version, scope: rawIdentity.scope,
      completeness: rawIdentity.completeness, digest: rawIdentity.digest,
    });
    const expectedComparison = current.protected_intent.comparison;
    if (!currentIdentity.success || currentIdentity.data.completeness !== 'complete'
      || (expectedComparison
        ? comparisonDigest('content_identity', currentIdentity.data) !== expectedComparison.content_identity_sha256
        : stable(currentIdentity.data) !== stable(current.protected_intent.content_identity))) {
      throw new HarnessError('SUBJECT_IDENTITY_CONFLICT');
    }
    const canonicalCwd = realpathSync(dispatch.cwd);
    if (expectedComparison
      ? comparisonDigest('canonical_cwd', canonicalCwd) !== expectedComparison.canonical_cwd_sha256
      : canonicalCwd !== current.protected_intent.launch.cwd) {
      throw new HarnessError('LAUNCH_IDENTITY_CONFLICT', { field: 'cwd' });
    }
    for (const field of ['prompt_sha256', 'prompt_utf8_bytes', 'sender', 'model', 'reasoning', 'timeout_ms', 'permission_selection'] as const) {
      if (stable(dispatch.launch[field]) !== stable(current.protected_intent.launch[field])) {
        throw new HarnessError('LAUNCH_IDENTITY_CONFLICT', { field });
      }
    }
    const others = [...this.operations.values()].filter(value => value.operation_id !== current.operation_id
      && this.runtimeClaim(value) !== 'released');
    const sameDestination = others.find(value => destinationKey(value.ticket_id, value.destination)
      === destinationKey(current.ticket_id, current.destination));
    if (sameDestination) throw new HarnessError('DESTINATION_BUSY', { operation_id: sameDestination.operation_id });
    if (!this.dependencies.source.activeRuns) throw new HarnessError('EXECUTION_COVERAGE_INCOMPLETE');
    let runtimeClaims;
    try { runtimeClaims = this.dependencies.source.activeRuns().map(run => ({
      session_id: run.session_id, run_id: run.id, status: run.status,
    })); } catch { throw new HarnessError('EXECUTION_COVERAGE_INCOMPLETE'); }
    const bindingClaims = this.bindingClaims();
    const sameBinding = bindingClaims.find(value => value.binding.conversation_id === current.destination.conversation_id);
    if (sameBinding) throw new HarnessError('DESTINATION_BUSY', { binding_id: sameBinding.binding.id });
    const claimedRunIds = new Set(bindingClaims.map(value => value.binding.run_id).filter(Boolean));
    const unboundRuntimeClaims = runtimeClaims.filter(value => !claimedRunIds.has(value.run_id));
    if (others.length || bindingClaims.length || unboundRuntimeClaims.length) {
      const input: AuthorizationInput = { ticket_id: current.ticket_id,
        destination: current.protected_intent.destination,
        authorization_boundary: current.protected_intent.authorization_boundary };
      const allowed = this.dependencies.authorizationValidator?.(others, input, runtimeClaims) ?? false;
      if (!allowed) throw new HarnessError('MODEL_LINE_BUSY', { operation_ids: others.map(value => value.operation_id),
        binding_ids: bindingClaims.map(value => value.binding.id), runtime_run_ids: unboundRuntimeClaims.map(value => value.run_id) });
    }
    const operation = this.transition(current, { state: 'dispatching',
      runtime: { ...current.runtime, fingerprint: dispatch.fingerprint },
      dispatch: { model: dispatch.config.model, reasoning: dispatch.config.reasoning,
        permissions: structuredClone(dispatch.permissions), observed_workflow_revision: workflow.workflow_revision,
        observed_subject_ref: workflow.snapshot.subject.subject_id, observed_content_identity: currentIdentity.data },
    }, 'dispatch');
    return this.receipt(operation, false);
  }

  private lookup(operation: ExecutionOperation, provided?: RuntimeRequestObservation | null) {
    let observation = provided;
    if (observation === undefined) {
      if (!this.dependencies.source.lookupRequest) return { state: 'unavailable' as const, observation: null };
      try { observation = this.dependencies.source.lookupRequest(operation.runtime.request_id); }
      catch (error) { return { state: 'unavailable' as const, observation: null,
        reason: error instanceof Error ? error.message : 'runtime lookup unavailable' }; }
    }
    if (!observation) return { state: 'not-found' as const, observation: null };
    const exact = observation.request_id === operation.runtime.request_id
      && observation.fingerprint === operation.runtime.fingerprint;
    return { state: exact ? 'matched' as const : 'contradiction' as const, observation };
  }

  markStarted(operationId: string, observation?: RuntimeRequestObservation | null) {
    const current = this.operation(operationId);
    if (current.state === 'started' || current.state === 'bound') return this.receipt(current, true);
    if (!['dispatching', 'reconciliation-required'].includes(current.state)) throw new HarnessError('EXECUTION_STATE_CONFLICT', { state: current.state });
    const lookup = this.lookup(current, observation);
    if (lookup.state !== 'matched' || !lookup.observation) throw new HarnessError('RUNTIME_ACCEPTANCE_UNCONFIRMED', { lookup: lookup.state });
    const operation = this.transition(current, { state: 'started', runtime: {
      request_id: lookup.observation.request_id, fingerprint: lookup.observation.fingerprint,
      session_id: lookup.observation.session_id, run_id: lookup.observation.run_id, status: lookup.observation.status,
    } }, 'started');
    return this.receipt(operation, false);
  }

  bind(operationId: string, observation?: RuntimeRequestObservation | null) {
    const current = this.operation(operationId);
    if (current.state === 'bound') return this.receipt(current, true);
    if (current.state !== 'started') throw new HarnessError('EXECUTION_STATE_CONFLICT', { state: current.state });
    if (this.uncertainRecording || this.journal.failure) throw new HarnessError('RECORDING_OUTCOME_UNKNOWN', {
      phase: 'bind', reason: this.journal.failure ?? 'prior append outcome unknown; checked restart required',
    });
    const lookup = this.lookup(current, observation);
    if (lookup.state !== 'matched' || !lookup.observation
      || lookup.observation.session_id !== current.runtime.session_id || lookup.observation.run_id !== current.runtime.run_id) {
      throw new HarnessError('RUNTIME_RECEIPT_CONFLICT', { lookup: lookup.state });
    }
    const conversationId = current.destination.conversation_id;
    const conflict = [...this.dependencies.bindings.values()].find(binding =>
      binding.session_id === lookup.observation!.session_id
      && (binding.ticket_id !== current.ticket_id || binding.conversation_id !== conversationId));
    if (conflict) throw new HarnessError('ATTRIBUTION_CONFLICT', { binding_id: conflict.id, conversation_id: conflict.conversation_id });
    const timestamp = now();
    const binding = { id: randomUUID(), ticket_id: current.ticket_id, conversation_id: conversationId,
      source_id: this.journal.sourceId, session_id: lookup.observation.session_id, scope: 'run',
      run_id: lookup.observation.run_id, attached_at: timestamp } as const;
    const isolation = current.destination.kind === 'child'
      ? this.dependencies.assessChild?.(binding.session_id, binding.run_id, conversationId) ?? null : null;
    if (isolation?.state === 'mismatch') throw new HarnessError('ATTRIBUTION_CONFLICT', { isolation });
    const operation = executionOperationSchema.parse({ ...current, state: 'bound', revision: current.revision + 1,
      ...('work_item' in current && current.work_item ? { work_item: this.workItems.bind(current.work_item,
        lookup.observation.session_id, current.dispatch?.permissions) } : {}),
      destination: current.destination.kind === 'child' && isolation
        ? { ...current.destination, isolation } : current.destination,
      binding_id: binding.id, runtime: { ...current.runtime, status: lookup.observation.status }, updated_at: timestamp });
    this.append({ kind: 'execution_operation_bound', previous_state: 'started', operation, binding }, 'bind');
    return this.receipt(operation, false);
  }

  failReserved(operationId: string, code: string, reason: string, reprepareRequired = true) {
    const current = this.operation(operationId);
    if (current.state === 'failed') return this.receipt(current, true);
    if (current.state !== 'reserved') throw new HarnessError('EXECUTION_STATE_CONFLICT', { state: current.state });
    const operation = this.transition(current, { state: 'failed', failure: {
      code, reason, reprepare_required: reprepareRequired,
    } }, 'failed');
    return this.receipt(operation, false);
  }

  requireReconciliation(operationId: string, code: string, reason: string) {
    const current = this.operation(operationId);
    if (current.state === 'reconciliation-required') return this.receipt(current, true);
    if (!['dispatching', 'started'].includes(current.state)) throw new HarnessError('EXECUTION_STATE_CONFLICT', { state: current.state });
    const operation = this.transition(current, { state: 'reconciliation-required', failure: {
      code, reason, reprepare_required: true,
    } }, 'reconciliation-required');
    return this.receipt(operation, false);
  }

  reconcile(operationId: string, observation?: RuntimeRequestObservation | null) {
    const operation = this.operation(operationId);
    const lookup = this.lookup(operation, observation);
    const contradictions: string[] = [];
    if (lookup.state === 'contradiction') contradictions.push('RUNTIME_REQUEST_CONTRADICTION');
    if ((operation.state === 'started' || operation.state === 'bound') && lookup.state !== 'matched') {
      contradictions.push('RUNTIME_RECEIPT_UNCONFIRMED');
    }
    if (lookup.observation && operation.runtime.session_id && (lookup.observation.session_id !== operation.runtime.session_id
      || lookup.observation.run_id !== operation.runtime.run_id)) contradictions.push('RUNTIME_RECEIPT_CONTRADICTION');
    if (operation.binding_id) {
      const binding = this.dependencies.bindings.get(operation.binding_id);
      if (!binding || binding.ticket_id !== operation.ticket_id || binding.conversation_id !== operation.destination.conversation_id
        || binding.session_id !== operation.runtime.session_id || binding.run_id !== operation.runtime.run_id) {
        contradictions.push('BINDING_CONTRADICTION');
      }
    }
    const unknownDispatch = operation.state === 'dispatching' || operation.state === 'reconciliation-required';
    const effective = contradictions.length || unknownDispatch ? 'reconciliation-required' : operation.state;
    return { ...this.receipt(operation, false, { source: 'runtime-request-lookup', lookup: lookup.state,
      observation: lookup.observation ? structuredClone(lookup.observation) : null, contradictions }), effective_state: effective };
  }
}
