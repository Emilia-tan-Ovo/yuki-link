import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { EngineeringCardStore } from '../../../companion-desktop/backend/engineering-card-store.mjs';
import { githubIssueSource } from '../../../companion-desktop/backend/github-issue-source.mjs';
import { HarnessError } from '../harness/model.ts';
import { ContextAssembler } from './context-assembler.ts';
import { HarnessContextFactsSource } from './harness-context-source.ts';
import { WorkflowAgentLauncher } from './workflow-agent-launcher.ts';
import { reviewContractDigest } from './review-launcher.ts';
import { companionResultIdentity } from './companion-evidence.mjs';

import { companionDispatchInputSchema } from './companion-contract.mjs';
export { companionDispatchInputSchema };

const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
    : JSON.stringify(value);
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const fail = (code, details) => { throw new HarnessError(code, details); };
const policyId = policy => ({ policy_id: policy.policy_id, revision: policy.revision, digest: policy.digest });
const actionFor = (content, phase) => {
  if (content.endpoint === 'design-only') return phase === 'ticket-design' && content.desiredPhase === 'ticket-design' ? 'ticket-design' : null;
  if (content.endpoint !== 'to-pr') return null;
  if (phase === 'ticket-design' && content.desiredPhase === 'ticket-design') return 'ticket-design';
  if (phase === 'implementation' && content.desiredPhase === 'implementation') return 'implementation';
  if (phase === 'review' && content.desiredPhase === 'review') return 'review';
  return null;
};

// This adapter owns no execution state. The card SQLite claim is the handoff fact;
// ExecutionOperations remains the only reservation and run owner.
export class CompanionDispatchService {
  constructor({ manager, directory, forbiddenRoots = [], issueSource = githubIssueSource(), policyMaxAgeMs = 30_000, launch = null,
    contextFactory = harness => new ContextAssembler(new HarnessContextFactsSource(harness,undefined,undefined,
      manager.implementationLaunchAuthority ?? null)) }) {
    if (!path.isAbsolute(directory) || !existsSync(path.join(directory,'engineering-cards.sqlite')))
      fail('COMPANION_CARD_STORE_UNAVAILABLE');
    this.requestedDirectory = path.resolve(directory);
    this.directory = realpathSync(directory);
    if (forbiddenRoots.some(root => {
      const relative = path.relative(realpathSync(root),this.directory);
      return relative === '' || relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
    })) fail('COMPANION_CARD_STORE_UNTRUSTED');
    this.database = realpathSync(path.join(this.directory,'engineering-cards.sqlite'));
    this.store = new EngineeringCardStore(this.directory);
    this.manager = manager;
    this.issueSource = issueSource;
    this.policyMaxAgeMs = policyMaxAgeMs;
    this.contextFactory = contextFactory;
    this.launch = launch ?? (claim => {
      const authority = this.authority(claim);
      const launcher = new WorkflowAgentLauncher({ manager: this.manager, harness: this.manager.harness,
        implementationAuthority: authority, reviewAuthority: authority, workflowAuthority: authority });
      return launcher.start(claim.launcher_input);
    });
  }
  assertStore() {
    if (realpathSync(this.requestedDirectory) !== this.directory
      || realpathSync(path.join(this.directory,'engineering-cards.sqlite')) !== this.database)
      fail('COMPANION_CARD_STORE_CHANGED');
  }
  close() { this.store.close(); }
  requestId(input) { return `companion:${sha(`${input.card_store_id}:${input.card_id}:${input.revision}:initial-dispatch`).slice(0,64)}`; }
  known(input) {
    this.assertStore();
    if (input.card_store_id !== this.store.storeId) fail('COMPANION_CARD_STORE_CONFLICT');
    const envelope = this.store.envelope(input.card_id,input.revision);
    if (!envelope || envelope.dispatch_id !== input.dispatch_id || envelope.card_store_id !== input.card_store_id)
      fail('COMPANION_DISPATCH_CONFLICT');
    return envelope;
  }
  claim(input) { return this.store.received(input.card_id,input.revision,input.dispatch_id); }
  operation(claim) {
    const operations = this.manager.harness.executionOperations;
    const existing = operations.findByRequest(claim.ticket_id,claim.request_id);
    if (existing && (!existing.companion_dispatch || sha(existing.companion_dispatch) !== sha(claim.provenance)))
      fail('COMPANION_OPERATION_PROVENANCE_CONFLICT');
    return existing ? operations.reconcile(existing.operation_id) : null;
  }
  receipt(input, claim, deduplicated = false) {
    const operation = claim ? this.operation(claim) : null;
    let detail = null;
    try { if (claim) detail = this.manager.harness.detail(claim.ticket_id); } catch { /* Keep the durable operation visible. */ }
    const card = this.store.get(input.card_id);
    const runtime = operation?.runtime ?? null;
    const runId = runtime?.run_id ?? null;
    const sessionId = runtime?.session_id ?? null;
    let run = null;
    try { if (runId) run = this.manager.status({ run_id: runId })?.run ?? null; } catch { /* Observation remains unknown. */ }
    return { schema_version: 1, card_store_id: input.card_store_id, card_id: input.card_id,
      revision: input.revision, dispatch_id: input.dispatch_id,
      card_state: card?.state ?? 'unknown', dispatch_state: claim ? 'engineering-received'
        : card?.state === 'revoked' ? 'revoked' : 'not-dispatched',
      ticket_ref: claim?.ticket_ref ?? null, ticket_id: claim?.ticket_id ?? null,
      main_conversation_id: claim?.main_conversation_id ?? null,
      review_id: claim?.review_id ?? null, child_conversation_id: operation?.destination?.kind === 'child' ? operation.destination.conversation_id : null,
      operation_id: operation?.operation_id ?? null, operation_state: operation?.effective_state ?? (claim ? 'reconciliation-required' : 'not-dispatched'),
      session_id: sessionId, run_id: runId, run: run ?? null, deduplicated,
      reconciliation: Boolean(claim && (!operation || operation.effective_state === 'reconciliation-required')),
      workflow: detail?.workflow ?? null, acceptance: detail?.workflow?.current?.acceptance ?? null,
      pr_delivery: { state: 'unknown', reference: null },
      source_refs: ['card-sqlite','harness-execution-operations','harness-detail'], observed_at: new Date().toISOString() };
  }
  get(raw) {
    const input = companionDispatchInputSchema.parse(raw);
    this.known(input);
    return this.receipt(input,this.claim(input),true);
  }
  // A source bound to one immutable claim. Every launcher guard reads the card again
  // and re-observes the activated policy, so a post-await drift rejects before spawn.
  authority(claim) {
    const service = this;
    return { snapshot(ticketKey, actionOrRef, maybeRef) {
      service.assertStore();
      const received = service.store.received(claim.card_id,claim.revision,claim.dispatch_id);
      if (!received || sha(received) !== sha(claim) || service.store.get(claim.card_id)?.state !== 'confirmed')
        fail('COMPANION_CLAIM_CONFLICT');
      const card = service.store.get(claim.card_id);
      if (card.revision !== claim.revision || card.confirmation?.revision !== claim.revision
        || card.confirmation?.actionSource !== 'desktop-user-action'
        || sha(card.content) !== claim.provenance.content_digest
        || card.content.original !== claim.confirmed_request)
        fail('COMPANION_CLAIM_CONFLICT');
      if (ticketKey !== claim.ticket_key || (maybeRef ?? actionOrRef) !== claim.authorization_ref)
        fail('COMPANION_AUTHORITY_CONFLICT');
      if (claim.action === 'ticket-design' && actionOrRef !== 'ticket-design') fail('COMPANION_AUTHORITY_CONFLICT');
      if (Date.now() - Date.parse(claim.github_observed_at) > service.policyMaxAgeMs)
        fail('COMPANION_GITHUB_OBSERVATION_EXPIRED');
      const currentWorkflow = service.manager.harness.workflowHistory.current.get(claim.ticket_id);
      const assessment = service.manager.harness.workflowHistory.assessments?.get(claim.ticket_id)
        ?? currentWorkflow?.assessment;
      if (!currentWorkflow || currentWorkflow.workflow_revision !== claim.launcher_input.expected.workflow_revision
        || assessment?.state !== 'verified') fail('COMPANION_WORKFLOW_CONFLICT');
      if (claim.action === 'implementation') {
        const ticket = service.manager.harness.tickets.get(claim.ticket_id);
        const notes = claim.launcher_input.expected.notes;
        const file = ticket?.expected_worktree && path.join(ticket.expected_worktree,notes.path);
        if (!file || !existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== notes.sha256)
          fail('COMPANION_NOTES_CONFLICT');
      }
      const current = service.policy(claim.action,claim.ticket_key,claim.review_id);
      if (sha(current.policy) !== sha(claim.policy)) fail('COMPANION_POLICY_CONFLICT');
      return { policy: claim.policy, authorization: claim.authorization,
        source: { schema_version: 1, kind: 'adapter', reference: claim.authorization_ref,
          canonical_path: null, sha256: sha({ claim: claim.claim_digest, policy: claim.policy, authorization: claim.authorization }) },
        companion: claim.provenance, confirmed_request: card.content.original,
        ...(['ticket-design','implementation','review'].includes(claim.action)
          && service.manager.harness.tickets?.get?.(claim.ticket_id)?.expected_worktree
          ? (()=>{ const result=companionResultIdentity(
            service.manager.harness.tickets.get(claim.ticket_id).expected_worktree,
            claim.card_id,claim.revision,claim.action==='review' ? 'primary-review':claim.action,
            claim.request_id,claim.launcher_input.expected.workflow_revision,
            claim.launcher_input.expected.subject_ref,
            claim.launcher_input.expected.subject_identity ?? null);
            return {companion_result_path:result.result_path,companion_result_identity:result}; })() : {}) };
    } };
  }
  policy(action,ticketKey,reviewId) {
    const manager = this.manager;
    if (action === 'implementation') {
      if (!manager.implementationLaunchAuthority) fail('COMPANION_POLICY_UNAVAILABLE');
      return manager.implementationLaunchAuthority.snapshot(ticketKey,'');
    }
    if (action === 'review') {
      if (!manager.reviewLaunchAuthority) fail('COMPANION_POLICY_UNAVAILABLE');
      return manager.reviewLaunchAuthority.snapshot(ticketKey,reviewId,'');
    }
    if (!manager.workflowAgentAuthority) fail('COMPANION_POLICY_UNAVAILABLE');
    return manager.workflowAgentAuthority.snapshot(ticketKey,'ticket-design','');
  }
  async preflight(input,envelope) {
    const harness = this.manager.harness;
    const card = this.store.get(input.card_id);
    if (!card || card.state !== 'confirmed' || card.revision !== input.revision
      || card.confirmation?.revision !== input.revision || card.confirmation?.actionSource !== 'desktop-user-action'
      || sha(card.content) !== envelope.content_digest) fail('COMPANION_CARD_STALE');
    const content = card.content, ticketRef = content.ticket;
    if (content.resolution?.status !== 'verified_existing' || !ticketRef?.id || !ticketRef?.scope?.digest || !ticketRef.marker)
      fail('COMPANION_RECONFIRM_REQUIRED');
    const issue = await (this.issueSource.details ?? this.issueSource.lookup)(content.repository,ticketRef.number);
    if (!issue || issue.id !== ticketRef.id || issue.url !== ticketRef.url || issue.marker !== ticketRef.marker
      || issue.scope?.digest !== ticketRef.scope.digest) fail('COMPANION_TICKET_SCOPE_CHANGED');
    const githubObservedAt = new Date().toISOString();
    const matches = [...harness.tickets.values()].filter(ticket => ticket.reference === issue.url && ticket.key === issue.marker);
    if (matches.length !== 1) fail('COMPANION_TICKET_NOT_PREPARED');
    const ticket = matches[0], project = harness.projects.get(ticket.project_id);
    if (!project || project.key !== content.projectKey || !ticket.expected_worktree || !ticket.comparison_baseline
      || realpathSync(ticket.expected_worktree) !== realpathSync(ticket.comparison_baseline.worktree_root))
      fail('COMPANION_TARGET_CONFLICT');
    const workflow = harness.workflowHistory.current.get(ticket.id);
    const assessment = harness.workflowHistory.assessments?.get(ticket.id) ?? workflow?.assessment;
    if (!workflow || assessment?.state !== 'verified') fail('COMPANION_WORKFLOW_UNVERIFIED');
    const action = actionFor(content,workflow.snapshot.phase);
    if (!action) fail('COMPANION_PHASE_UNSUPPORTED');
    const context = this.contextFactory(harness);
    const packet = context.assemble({ ticket_id: ticket.id, requested_action: action === 'review' ? 'review' : action, trigger: 'handoff' });
    const designWithoutNotes = action === 'ticket-design' && packet.retrieval?.context_plan?.status !== 'observed'
      && packet.integrity?.state === 'partial'
      && packet.integrity.unknowns?.every(value => value.code?.startsWith('IMPLEMENTATION_NOTES_'))
      && packet.action_readiness?.reasons?.every(value => value.code === 'PARTIAL_EVIDENCE');
    if (packet.action_readiness?.state !== 'ready' && !designWithoutNotes
      || packet.attention?.unknown_side_effects?.length)
      fail('COMPANION_PREPARATION_CONFLICT',{ reasons: packet.action_readiness?.reasons });
    const subject = workflow.snapshot.subject;
    const raw = harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    if (raw.completeness !== 'complete' || !raw.digest) fail('COMPANION_SUBJECT_UNVERIFIED');
    const contentIdentity = { scheme: raw.scheme, version: raw.version, scope: raw.scope, completeness: raw.completeness, digest: raw.digest };
    const review = action === 'review' ? workflow.snapshot.reviews?.find(value => value.mode === 'full' && value.status === 'pending'
      && value.subject_ref === subject.subject_id && value.subject_identity)?.review_id : null;
    const reviewId = review ?? null;
    if (action === 'review' && !reviewId) fail('COMPANION_REVIEW_NOT_PREPARED');
    const policy = this.policy(action,ticket.key,reviewId).policy;
    if (policy.project_key !== project.key || policy.workflow_phase !== workflow.snapshot.phase
      || policy.permission_selection !== 'owner-native-default') fail('COMPANION_POLICY_NOT_APPLICABLE');
    const notes = packet.retrieval.context_plan;
    if (action === 'implementation' && (notes.status !== 'observed' || !notes.digest || !notes.core?.length
      || !notes.location?.startsWith('docs/implementation-notes/'))) fail('COMPANION_NOTES_UNVERIFIED');
    if (action === 'implementation') {
      const file = path.join(ticket.expected_worktree,notes.location);
      if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== notes.digest.replace(/^sha256:/,''))
        fail('COMPANION_NOTES_CONFLICT');
      if (!issue.body?.includes(readFileSync(file,'utf8'))) fail('COMPANION_NOTES_SOURCE_CONFLICT');
    }
    const requestId = this.requestId(input), authorizationRef = `companion:${input.card_id}:${input.revision}`;
    const provenance = { schema_version: 1, card_store_id: input.card_store_id, card_id: input.card_id,
      revision: input.revision, dispatch_id: input.dispatch_id, content_digest: envelope.content_digest,
      confirmation_at: envelope.confirmation.confirmed_at, ticket_scope_digest: ticketRef.scope.digest,
      product_endpoint: content.endpoint, action, policy_digest: policy.digest };
    const authorityRefs = [issue.url,authorizationRef];
    let authorization;
    if (action === 'implementation') authorization = { schema_version: 1, authorization_id: authorizationRef,
      ticket_key: ticket.key, action: 'ticket-implementation', endpoint: 'implementation', contract_version: 1,
      authorization_ref: authorizationRef, notes: { path: notes.location, sha256: notes.digest.replace(/^sha256:/,'') }, authority_refs: authorityRefs };
    else if (action === 'review') authorization = { schema_version: 1, authorization_id: authorizationRef,
      ticket_key: ticket.key, review_id: reviewId, action: 'ticket-review', endpoint: 'review', contract_version: 1,
      contract_digest: reviewContractDigest, authorization_ref: authorizationRef,
      subject_ref: subject.subject_id, subject_identity: workflow.snapshot.reviews.find(value => value.review_id === reviewId).subject_identity, content_identity: contentIdentity,
      authority_refs: authorityRefs };
    else authorization = { schema_version: 1, authorization_id: authorizationRef,
      ticket_key: ticket.key, action: 'ticket-design', authorization_ref: authorizationRef,
      subject_ref: subject.subject_id, subject_identity: null, authority_refs: authorityRefs };
    const expected = { workflow_revision: workflow.workflow_revision, subject_ref: subject.subject_id,
      ...(action !== 'implementation' ? { subject_identity: action === 'review' ? authorization.subject_identity : null } : {}), content_identity: contentIdentity,
      policy: policyId(policy), ...(action === 'implementation' ? { notes: authorization.notes } : {}) };
    const launcherInput = { schema_version: 1, action, ticket_id: ticket.id, request_id: requestId,
      authorization_ref: authorizationRef, expected,
      ...(action === 'review' ? { review_id: reviewId, references: [ticket.reference], current_delta: [] }
        : action === 'ticket-design' ? { references: [ticket.reference], current_delta: [] } : { current_delta: [] }) };
    return { card_id: input.card_id, revision: input.revision, dispatch_id: input.dispatch_id,
      request_id: requestId, ticket_id: ticket.id, ticket_key: ticket.key, ticket_ref: ticket.reference,
      main_conversation_id: ticket.main_conversation_id, review_id: reviewId,
      action, authorization_ref: authorizationRef, authorization, policy, provenance,
      confirmed_request: content.original,
      github_observed_at: githubObservedAt, launcher_input: launcherInput,
      claim_digest: sha({ launcherInput, authorization, policy, provenance, confirmed_request: content.original }) };
  }
  async dispatch(raw) {
    const input = companionDispatchInputSchema.parse(raw), envelope = this.known(input);
    const previous = this.claim(input);
    if (previous) return this.receipt(input,previous,true);
    const proposed = await this.preflight(input,envelope);
    // The short transaction rechecks revision, confirmation and immutable envelope after every await.
    const claimed = this.store.claim(input.card_id,input.revision,input.dispatch_id,proposed);
    if (claimed.conflict) fail('COMPANION_DISPATCH_CONFLICT');
    const continuation = this.store.registerContinuation(input.card_id,input.revision,'dispatch',
      input.dispatch_id,claimed.claim.ticket_id);
    if (continuation.conflict) fail('COMPANION_CONTINUATION_CONFLICT');
    if (proposed.action === 'implementation' || proposed.action === 'review') {
      const slot=proposed.action === 'review' ? 'primary-review':'implementation';
      const worktree=this.manager.harness.tickets?.get?.(proposed.ticket_id)?.expected_worktree;
      const resultIdentity=worktree && companionResultIdentity(worktree,input.card_id,input.revision,
        slot,proposed.request_id,proposed.launcher_input.expected.workflow_revision,
        proposed.launcher_input.expected.subject_ref,
        proposed.launcher_input.expected.subject_identity ?? null);
      const accepted=this.store.claimContinuationAction(input.card_id,input.revision,slot,
        {schema_version:1,action:proposed.action,request_id:proposed.request_id,
          initial_dispatch_id:input.dispatch_id,workflow_revision:proposed.launcher_input.expected.workflow_revision,
          result_identity:resultIdentity ?? null});
      if (accepted.conflict) fail('COMPANION_CONTINUATION_CONFLICT');
    }
    this.manager.companionContinuation?.wake({schema_version:1,card_store_id:input.card_store_id,
      card_id:input.card_id,revision:input.revision});
    if (claimed.deduplicated) return this.receipt(input,claimed.claim,true);
    const expectedWorktree=this.manager.harness.tickets?.get?.(proposed.ticket_id)?.expected_worktree;
    if (expectedWorktree) {
      const result=companionResultIdentity(expectedWorktree,input.card_id,input.revision,
        proposed.action === 'review' ? 'primary-review':proposed.action,proposed.request_id,
        proposed.launcher_input.expected.workflow_revision,
        proposed.launcher_input.expected.subject_ref,
        proposed.launcher_input.expected.subject_identity ?? null);
      if (existsSync(path.dirname(result.result_path))) fail('COMPANION_RESULT_PATH_OCCUPIED');
      mkdirSync(path.dirname(result.result_path),{recursive:true});
    }
    try { await this.launch(proposed); }
    catch { return this.receipt(input,proposed,false); }
    return this.receipt(input,proposed,false);
  }
}
