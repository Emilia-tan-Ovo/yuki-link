import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { HarnessError } from '../harness/model.ts';
import type { Source } from '../harness/model.ts';
import type { ExecutionReserveInput, ExecutionOperation } from '../harness/execution-model.ts';
import type { WorkItem, WorkItemExecution } from '../harness/work-item-model.ts';
import type { WorkItemDecision } from '../harness/work-item-model.ts';
import { subjectIdentity } from '../harness/workflow.ts';

export const stableValue = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stableValue).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':'
    + stableValue((value as Record<string, unknown>)[key])).join(',') + '}' : JSON.stringify(value);
export const workDigest = (value: unknown) => createHash('sha256').update(stableValue(value)).digest('hex');
const terminal = new Set(['completed', 'failed', 'stopped', 'timed_out', 'interrupted']);
const active = new Set(['queued', 'starting', 'running', 'stopping']);

// A projection of ExecutionOperations' journal, never an independent state store.
export class WorkItems {
  readonly items = new Map<string, WorkItem>();
  readonly source: Source;
  constructor(source: Source) { this.source = source; }
  get(id: string) {
    const item = this.items.get(id);
    if (!item) throw new HarnessError('WORK_ITEM_NOT_FOUND');
    return structuredClone(item);
  }
  apply(item: WorkItem) {
    const prior = this.items.get(item.work_item_id);
    if (prior && item.revision < prior.revision) throw new HarnessError('WORK_ITEM_JOURNAL_INVALID');
    this.items.set(item.work_item_id, structuredClone(item));
  }
  idle(item: WorkItem, operations: Map<string, ExecutionOperation>) {
    const operation = item.operation_id ? operations.get(item.operation_id) : null;
    if (operation && !['bound', 'failed'].includes(operation.state))
      throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
    if (operation?.state === 'bound') {
      const receipt = this.source.lookupRequest?.(operation.runtime.request_id);
      if (!receipt || receipt.fingerprint !== operation.runtime.fingerprint || receipt.session_id !== operation.runtime.session_id
        || receipt.run_id !== operation.runtime.run_id) throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
    }
    const binding = item.generations.at(-1);
    if (!binding?.session_id) return;
    let runs;
    try { runs = this.source.runs(binding.session_id); } catch { throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED'); }
    if (!runs.length || runs.some(run => !terminal.has(run.status) && !active.has(run.status)))
      throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
    if (runs.some(run => active.has(run.status))) throw new HarnessError('WORK_ITEM_BUSY');
  }
  prepare(input: ExecutionReserveInput, operations: Map<string, ExecutionOperation>): WorkItemExecution | undefined {
    const protection = 'implementation' in input ? input.implementation : 'review' in input ? input.review
      : 'workflow_agent' in input ? input.workflow_agent : null;
    if (!protection) return undefined; // Legacy internal reservations are not a public launch path.
    const action = 'workflow_agent' in input ? input.workflow_agent.action : 'implementation' in input ? 'implementation' : 'review';
    const purpose = ({ 'ticket-design': 'design', implementation: 'implementation', 'finding-fix': 'repair',
      review: 'primary-review', 'focused-review': 'focused-review', 'acceptance-agent': 'acceptance' } as const)[action];
    const authorization = protection.authorization;
    const findings = 'finding_batch' in authorization && authorization.finding_batch
      ? authorization.finding_batch : 'finding' in authorization && authorization.finding ? [authorization.finding] : [];
    const cycle = findings[0]?.origin_review_id ?? ('review_id' in authorization ? authorization.review_id ?? null : null);
    const scopeRef = authorization.work_item_scope?.scope_ref ?? 'delivery';
    const scope = workDigest({ delivery: input.ticket_id, subject: input.subject_ref, cwd: realpathSync(input.launch.cwd), scopeRef });
    // Content versions and the issue set evolve; neither is session authority.
    const authority = workDigest({ ref: authorization.authorization_ref, id: authorization.authorization_id, refs: authorization.authority_refs,
      policy: protection.policy.policy_id, policy_revision: protection.policy.revision, policy_digest: protection.policy.digest,
      model: protection.policy.model, reasoning: protection.policy.reasoning,
      permissions: protection.policy.permission_selection, scope: authorization.work_item_scope ?? null });
    const existing = [...this.items.values()].filter(item => item.delivery_item_id === input.ticket_id
      && item.purpose === purpose && item.scope_ref === scopeRef);
    if (existing.some(item => item.subject_ref !== input.subject_ref || item.scope_digest !== scope))
      throw new HarnessError('WORK_ITEM_SCOPE_CONFLICT');
    let item = existing.find(value => value.cycle_id === cycle);
    const repair = purpose === 'focused-review' ? [...this.items.values()].find(value =>
      value.delivery_item_id === input.ticket_id && value.scope_ref === scopeRef
      && value.purpose === 'repair' && value.cycle_id === cycle) : null;
    if (repair && repair.state !== 'awaiting_verification')
      throw new HarnessError('WORK_ITEM_PREDECESSOR_INCOMPLETE');
    if (existing.some(value => value.cycle_id !== cycle && !['completed', 'cancelled'].includes(value.state)))
      throw new HarnessError('WORK_ITEM_SCOPE_CONFLICT');
    if (input.work_item && (!item || input.work_item.work_item_id !== item.work_item_id))
      throw new HarnessError('WORK_ITEM_IDENTITY_CONFLICT');
    let mode: WorkItemExecution['mode'] = 'fresh';
    if (item) {
      if (!input.work_item || input.work_item.revision !== item.revision)
        throw new HarnessError('WORK_ITEM_REVISION_CONFLICT', { work_item_id: item.work_item_id, revision: item.revision });
      this.idle(item, operations);
      if (!['ready', 'active'].includes(item.state)) throw new HarnessError('WORK_ITEM_STATE_CONFLICT', { state: item.state });
      if (item.authority_digest !== authority) throw new HarnessError('WORK_ITEM_AUTHORITY_CONFLICT');
      if (item.destination_digest !== workDigest(input.destination)) throw new HarnessError('WORK_ITEM_DESTINATION_CONFLICT');
      item = structuredClone(item);
      item.revision++;
      const binding = item.generations.at(-1);
      if (binding?.session_id && binding.state !== 'retired') {
        let session;
        try { session = this.source.session(binding.session_id); } catch { throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED'); }
        if (!session) throw new HarnessError('WORK_ITEM_RECONCILIATION_REQUIRED');
        if (session.codex_thread_id) mode = 'continue';
        else { binding.state = 'retired'; binding.reason = 'runtime-thread-unavailable'; mode = 'replace'; }
      } else if (binding?.state === 'retired') mode = 'replace';
    } else {
      const parent = authorization.work_item_scope ? this.get(authorization.work_item_scope.parent_work_item_id) : null;
      if (parent && parent.delivery_item_id !== input.ticket_id) throw new HarnessError('WORK_ITEM_SCOPE_CONFLICT');
      const unfinished = [...this.items.values()].filter(value => value.delivery_item_id === input.ticket_id
        && value.scope_ref === scopeRef && !['completed', 'cancelled'].includes(value.state));
      if (unfinished.some(value => value.work_item_id !== repair?.work_item_id))
        throw new HarnessError('WORK_ITEM_PREDECESSOR_INCOMPLETE');
      const predecessorPurpose = ({ implementation: 'design', 'primary-review': 'implementation', repair: 'primary-review',
        'focused-review': 'repair', acceptance: 'primary-review' } as Record<string, string>)[purpose];
      const predecessor = [...this.items.values()].filter(value => value.delivery_item_id === input.ticket_id
        && value.scope_ref === scopeRef && value.purpose === predecessorPurpose
        && (!['repair', 'focused-review'].includes(purpose) || value.cycle_id === cycle)).at(-1);
      if (predecessor && !(purpose === 'focused-review' ? predecessor.state === 'awaiting_verification'
        : predecessor.state === 'completed')) throw new HarnessError('WORK_ITEM_PREDECESSOR_INCOMPLETE');
      item = { schema_version: 1, work_item_id: randomUUID(), delivery_item_id: input.ticket_id, purpose,
        subject_ref: input.subject_ref, scope_ref: scopeRef, scope_digest: scope, authority_digest: authority, cycle_id: cycle,
        destination_digest: workDigest(input.destination),
        parent_refs: [...new Set([parent?.work_item_id, predecessor?.work_item_id].filter((id): id is string => Boolean(id)))],
        issue_set: [], revision: 1, state: 'ready', generation: 0, generations: [],
        operation_id: null, content_version: null, review_content_version: null,
        review_budget: 1, review_rounds: 0, evidence_refs: [] };
    }
    const issues = findings.map(value => `${value.origin_review_id}:${value.finding_id}`);
    // Launchers validate every outstanding issue. Already verified members remain
    // in the durable set even when they no longer need to be sent for repair.
    item.issue_set = [...new Set([...item.issue_set, ...issues])].sort();
    if (mode !== 'continue' && (!item.generations.length || item.generations.at(-1)?.state === 'retired')) {
      item.generation++;
      item.generations.push({ generation: item.generation, session_id: null, state: 'usable', permissions_digest: null,
        reason: mode === 'replace' ? 'generation-replacement' : 'initial-assignment' });
    }
    if (purpose === 'focused-review' && item.review_content_version !== input.content_identity.digest) {
      if (item.review_rounds >= item.review_budget) throw new HarnessError('WORK_ITEM_REVIEW_BUDGET_EXHAUSTED');
    }
    item.state = 'active'; item.content_version = input.content_identity.digest;
    return { item, mode, session_id: mode === 'continue' ? item.generations.at(-1)!.session_id : null };
  }
  guard(execution: WorkItemExecution, sessionId: string | undefined, permissions: unknown) {
    const current = this.get(execution.item.work_item_id);
    if (current.revision !== execution.item.revision || current.generation !== execution.item.generation
      || current.state !== 'active' || current.generations.at(-1)?.state !== 'usable')
      throw new HarnessError('WORK_ITEM_REVISION_CONFLICT');
    if ((sessionId ?? null) !== execution.session_id) throw new HarnessError('WORK_ITEM_SESSION_CONFLICT');
    const saved = current.generations.at(-1)?.permissions_digest;
    if (execution.mode === 'continue' && saved !== workDigest(permissions)) throw new HarnessError('WORK_ITEM_PERMISSION_CONFLICT');
  }
  bind(execution: WorkItemExecution, sessionId: string, permissions: unknown): WorkItemExecution {
    if (execution.mode === 'continue' && execution.session_id !== sessionId) throw new HarnessError('WORK_ITEM_SESSION_CONFLICT');
    if (execution.mode !== 'continue' && execution.item.generations.some(binding => binding.session_id === sessionId))
      throw new HarnessError('WORK_ITEM_SESSION_CONFLICT');
    if ([...this.items.values()].some(item => item.work_item_id !== execution.item.work_item_id
      && item.generations.some(value => value.session_id === sessionId))) throw new HarnessError('WORK_ITEM_SESSION_CONFLICT');
    const next = structuredClone(execution);
    next.item.revision++;
    const binding = next.item.generations.at(-1)!;
    binding.session_id = sessionId; binding.permissions_digest = workDigest(permissions); binding.state = 'usable';
    if (next.item.purpose === 'focused-review' && next.item.review_content_version !== next.item.content_version) {
      next.item.review_rounds++; next.item.review_content_version = next.item.content_version;
    }
    return next;
  }
  transition(item: WorkItem, decision: WorkItemDecision, snapshot: any, operations: Map<string, ExecutionOperation>) {
    this.idle(item, operations);
    if (item.revision !== decision.expected_revision) throw new HarnessError('WORK_ITEM_REVISION_CONFLICT');
    if (['completed', 'cancelled'].includes(item.state)) throw new HarnessError('WORK_ITEM_STATE_CONFLICT');
    const next = structuredClone(item);
    const binding = next.generations.at(-1);
    if (decision.action === 'await-verification') {
      if (item.state !== 'active' || item.purpose !== 'repair') throw new HarnessError('WORK_ITEM_STATE_CONFLICT');
      if (item.issue_set.some(id => !snapshot.findings?.some((finding: any) =>
        `${finding.origin_review_id}:${finding.finding_id}` === id && ['fixed', 'fixed-unverified'].includes(finding.status))))
        throw new HarnessError('WORK_ITEM_VERIFICATION_REQUIRED');
      next.state = 'awaiting_verification';
      if (binding) binding.state = 'suspended';
    } else if (decision.action === 'reopen' || (decision.action === 'complete' && item.purpose === 'repair')) {
      const review = snapshot.reviews?.find((value: any) => value.review_id === decision.review_id);
      if (item.state !== 'awaiting_verification' || !review || review.mode !== 'focused'
        || review.original_review_id !== item.cycle_id || review.subject_ref !== item.subject_ref
        || review.isolated !== true || review.applicability !== 'verified'
        || review.subject_identity !== subjectIdentity(snapshot.subject)
        || !['findings', 'passed'].includes(review.status)
        || decision.action === 'reopen' && review.status !== 'findings'
        || decision.action === 'complete' && (review.status !== 'passed' || item.issue_set.some(id =>
          !snapshot.findings?.some((value: any) => `${value.origin_review_id}:${value.finding_id}` === id
            && value.status === 'verified' && value.verification_review_id === review.review_id))))
        throw new HarnessError('WORK_ITEM_VERIFICATION_REQUIRED');
      next.state = decision.action === 'reopen' ? 'active' : 'completed';
      if (binding) binding.state = decision.action === 'reopen' ? 'usable' : 'retired';
    } else if (decision.action === 'complete' || decision.action === 'cancel') {
      if (decision.action === 'complete' && ['primary-review', 'focused-review'].includes(item.purpose)) {
        const review = snapshot.reviews?.find((value: any) => value.review_id === decision.review_id);
        const reviewId = item.purpose === 'primary-review' ? item.cycle_id
          : [...operations.values()].find(value => value.operation_id === item.operation_id)?.protected_intent.destination;
        const expectedReviewId = typeof reviewId === 'string' ? reviewId
          : reviewId?.kind === 'child' && reviewId.relation.kind === 'review' ? reviewId.relation.review_id : null;
        if (!review || review.review_id !== expectedReviewId || review.subject_ref !== item.subject_ref
          || !['passed', 'findings'].includes(review.status) || review.isolated !== true
          || item.purpose === 'focused-review' && review.status !== 'passed'
          || review.applicability !== 'verified' || review.subject_identity !== subjectIdentity(snapshot.subject))
          throw new HarnessError('WORK_ITEM_VERIFICATION_REQUIRED');
      }
      if (decision.action === 'complete' && item.purpose === 'acceptance'
        && (snapshot.acceptance?.status !== 'passed' || snapshot.acceptance?.applicability !== 'verified'))
        throw new HarnessError('WORK_ITEM_VERIFICATION_REQUIRED');
      next.state = decision.action === 'complete' ? 'completed' : 'cancelled';
      if (binding) binding.state = 'retired';
    } else if (decision.action === 'retire-generation') {
      if (!binding) throw new HarnessError('WORK_ITEM_SESSION_CONFLICT');
      binding.state = 'retired'; binding.reason = decision.decision_ref;
      if (decision.next_authority_digest) next.authority_digest = decision.next_authority_digest;
    } else if (decision.action === 'review-budget') {
      if (item.purpose !== 'focused-review' || !decision.review_budget || decision.review_budget <= item.review_budget)
        throw new HarnessError('WORK_ITEM_REVIEW_BUDGET_CONFLICT');
      next.review_budget = decision.review_budget;
    }
    next.revision++; next.evidence_refs = [...new Set([...next.evidence_refs, ...decision.evidence_refs])];
    return next;
  }
}
