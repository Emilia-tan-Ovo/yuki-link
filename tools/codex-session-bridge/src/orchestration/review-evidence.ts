import { HarnessError } from '../harness/model.ts';
import type { Binding, Source } from '../harness/model.ts';
import type { ExecutionOperation } from '../harness/execution-model.ts';
import type { WorkItem } from '../harness/work-item-model.ts';
import { subjectIdentity } from '../harness/workflow.ts';
import type { IsolationAssessment } from '../harness/conversation-model.ts';
import type { WorkItems, ReviewObservation } from './work-items.ts';
import { workDigest } from './work-items.ts';

// WorkflowSource proves current file/runtime facts. This gate additionally proves
// that the report belongs to the managed reviewer that was authorized to review them.
export function verifyManagedReview(item: WorkItem, review: any, snapshot: any, contentVersion: string,
  facts: { items: WorkItems; operations: Map<string, ExecutionOperation>; bindings: Map<string, Binding>;
    source: Source; observations: ReviewObservation[];
    assessChild?: (session: string, run: string, conversation: string) => IsolationAssessment }) {
  function reject(): never { throw new HarnessError('WORK_ITEM_VERIFICATION_REQUIRED'); }
  if (!review || review.subject_ref !== item.subject_ref || review.subject_identity !== subjectIdentity(snapshot.subject)
    || review.isolated !== true || review.applicability !== 'verified'
    || !['passed', 'findings'].includes(review.status)) reject();
  const refs: string[] = [...new Set<string>([...(review.execution_refs ?? []),
    ...(review.participant_execution_refs ?? []).map((value: any) => value.runtime_ref_id)])];
  const reports = (review.artifact_refs ?? []).map((id: string) => snapshot.artifacts?.find((value: any) => value.artifact_id === id));
  if (!refs.length || reports.some((value: any) => !value) || !reports.some((value: any) => value?.role === 'review-report' && value.kind === 'file'
    && /^[0-9a-f]{64}$/.test(value.revision ?? ''))) reject();
  let owner: WorkItem | undefined;
  const ownedOperations: ExecutionOperation[] = [];
  for (const ref of refs) {
    const runtime = snapshot.runtime_refs?.find((value: any) => value.runtime_ref_id === ref);
    if (runtime?.kind !== 'codex-run' || !runtime.session_id || !runtime.run_id) reject();
    const matches = [...facts.operations.values()].filter(operation => operation.state === 'bound'
      && operation.runtime.session_id === runtime.session_id && operation.runtime.run_id === runtime.run_id);
    if (matches.length !== 1) reject();
    const operation = matches[0];
    const execution = 'work_item' in operation ? operation.work_item : undefined;
    if (!execution) reject();
    const reviewer = facts.items.get(execution.item.work_item_id);
    const destination = operation.destination;
    const focused = review.mode === 'focused';
    if (operation.ticket_id !== item.delivery_item_id || execution.item.delivery_item_id !== item.delivery_item_id
      || execution.item.subject_ref !== item.subject_ref || execution.item.scope_digest !== item.scope_digest
      || reviewer.delivery_item_id !== item.delivery_item_id || reviewer.subject_ref !== item.subject_ref
      || reviewer.scope_digest !== item.scope_digest || reviewer.authority_digest !== execution.item.authority_digest
      || reviewer.purpose !== (focused ? 'focused-review' : 'primary-review')
      || reviewer.cycle_id !== (focused ? review.original_review_id : review.review_id)
      || reviewer.generation !== execution.item.generation
      || reviewer.generations.find(value => value.generation === execution.item.generation)?.session_id !== runtime.session_id
      || destination.kind !== 'child' || destination.relation.kind !== 'review'
      || destination.relation.review_id !== review.review_id
      || review.participant_execution_refs?.some((value: any) => value.runtime_ref_id === ref
        && value.participant !== (destination.kind === 'child' && destination.relation.kind === 'review'
          ? destination.relation.participant : null))
      || operation.protected_intent.subject_ref !== item.subject_ref
      || operation.protected_intent.content_identity.digest !== contentVersion
      || item.purpose === 'repair' && (!focused || reviewer.cycle_id !== item.cycle_id
        || !reviewer.parent_refs.includes(item.work_item_id))
      || item.purpose !== 'repair' && reviewer.work_item_id !== item.work_item_id
      || owner && (owner.work_item_id !== reviewer.work_item_id || owner.generation !== reviewer.generation)) reject();
    const binding = operation.binding_id ? facts.bindings.get(operation.binding_id) : undefined;
    if (!binding || binding.ticket_id !== item.delivery_item_id || binding.session_id !== runtime.session_id
      || binding.run_id !== runtime.run_id || binding.conversation_id !== destination.conversation_id) reject();
    try {
      const receipt = facts.source.lookupRequest?.(operation.runtime.request_id);
      const run = facts.source.runs(runtime.session_id).find(value => value.id === runtime.run_id);
      if (!receipt || receipt.fingerprint !== operation.runtime.fingerprint || receipt.session_id !== runtime.session_id
        || receipt.run_id !== runtime.run_id || receipt.status !== 'completed'
        || !run || run.session_id !== runtime.session_id || run.status !== 'completed'
        || facts.assessChild?.(runtime.session_id, runtime.run_id, destination.conversation_id).state !== 'verified') reject();
      facts.items.idle(reviewer, facts.operations);
    } catch { reject(); }
    owner = reviewer; ownedOperations.push(operation);
  }
  if (!owner) reject();
  const reviewerOwner = owner;
  const latest = [...facts.operations.values()].filter(operation => 'work_item' in operation
    && operation.work_item?.item.work_item_id === reviewerOwner.work_item_id
    && operation.destination.kind === 'child' && operation.destination.relation.kind === 'review'
    && operation.destination.relation.review_id === review.review_id).at(-1);
  if (!latest || !ownedOperations.some(operation => operation.operation_id === latest.operation_id)) reject();
  if (owner.purpose === 'focused-review') {
    const round = owner.review_history.find(value => value.review_id === review.review_id);
    if (!round || round.content_version !== contentVersion) reject();
    if (round.conclusion_digest && round.conclusion_digest !== workDigest(review)) reject();
  }
  // A terminal report identity is immutable. Keep independent reports for later
  // rounds so durable findings cannot accidentally borrow a rewritten conclusion.
  const first = facts.observations.find(value => value.snapshot.reviews?.some((report: any) =>
    report.review_id === review.review_id && ['passed', 'findings', 'incomplete'].includes(report.status)));
  const prior = first?.snapshot.reviews.find((value: any) => value.review_id === review.review_id);
  const artifactIdentity = (value: any) => value ? workDigest({ artifact_id: value.artifact_id,
    role: value.role, kind: value.kind, location: value.location, revision: value.revision }) : null;
  if (prior && (workDigest(prior) !== workDigest(review) || reports.some((report: any) =>
    artifactIdentity(first!.snapshot.artifacts?.find((value: any) => value.artifact_id === report?.artifact_id))
      !== artifactIdentity(report)))) reject();
}
