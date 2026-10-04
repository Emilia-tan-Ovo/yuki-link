import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HarnessError } from '../harness/model.ts';
import { executionContentIdentitySchema, executionProfileSchema, implementationAuthorizationSchema,
  reviewAuthorizationSchema, workflowAgentExecutionProtectionSchema } from '../harness/execution-model.ts';
import { startWorkflowAgentInputSchema, WorkflowAgentLauncher } from '../orchestration/workflow-agent-launcher.ts';
import { reviewContractDigest } from '../orchestration/review-launcher.ts';
import { workDigest } from '../orchestration/work-items.ts';
import { protectedCopy } from '../harness/content-policy.ts';

const text = z.string().min(1).max(512);
const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const workItem = z.object({ work_item_id: z.string().uuid(), revision: z.number().int().positive() }).strict();
const verification = z.object({ ticket_id: z.string().uuid(), request_id: requestId, work_item: workItem,
  content_identity: executionContentIdentitySchema, label: text, script: z.string().min(1).max(131072),
  timeout_ms: z.number().int().min(1000).max(1800000) }).strict();
export const engineeringPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow'), input: startWorkflowAgentInputSchema,
    agent_criterion: z.object({ criteria_ref: text, requirement: text, behavior: z.literal('agent-session') }).strict().optional() }).strict(),
  z.object({ kind: z.literal('verification'), input: verification }).strict(),
]);
export const adapterScopeSchema = z.object({ connection: text, profile: text, chat: text, project: text }).strict();
const same = (a, b) => workDigest(a) === workDigest(b);
const samePermissions = (a, b) => { const { resolved_at: _a, ...left } = a ?? {};
  const { resolved_at: _b, ...right } = b ?? {}; return same(left, right); };
const identity = value => executionContentIdentitySchema.parse({ scheme: value.scheme, version: value.version,
  scope: value.scope, completeness: value.completeness, digest: value.digest });
const authorityKey = action => action === 'implementation' ? 'implementationLaunchAuthority'
  : action === 'review' ? 'reviewLaunchAuthority' : 'workflowAgentAuthority';

export class EngineeringAuthority {
  constructor(manager, taskHost, { adapterId = 'hermes-yer', profile = null, now = Date.now, launcherOptions = {} } = {}) {
    this.manager = manager;
    this.harness = manager.harness;
    this.journal = this.harness.journal;
    this.taskHost = taskHost;
    this.adapterId = adapterId;
    this.profile = profile === null ? null : executionProfileSchema.parse(profile);
    this.now = now;
    this.launcherOptions = launcherOptions;
    this.sources = Object.fromEntries(['implementationLaunchAuthority', 'reviewLaunchAuthority', 'workflowAgentAuthority']
      .map(key => [key, manager[key]]));
    for (const key of Object.keys(this.sources)) manager[key] = { snapshot: (...args) => this.snapshotAuthority(key, args) };
    this.launcher = new WorkflowAgentLauncher({ ...launcherOptions, manager, harness: this.harness,
      implementationAuthority: manager.implementationLaunchAuthority, reviewAuthority: manager.reviewLaunchAuthority,
      workflowAuthority: manager.workflowAgentAuthority });
  }
  records(kind) { return this.journal.records.filter(record => record.data.kind === kind).map(record => record.data); }
  ticket(id) {
    const ticket = this.harness.tickets.get(id);
    if (!ticket) throw new HarnessError('TICKET_NOT_FOUND');
    return ticket;
  }
  append(data) {
    if (protectedCopy(data).redacted) throw new HarnessError('ENGINEERING_PLAN_REDACTED');
    return this.journal.append(data);
  }
  propose(raw) {
    const input = engineeringPlanSchema.parse(raw), ticketId = input.input.ticket_id;
    this.ticket(ticketId);
    this.harness.executionGate('record-only');
    const digest = workDigest(input);
    const old = this.records('engineering_plan').find(plan => plan.ticket_id === ticketId && plan.request_id === input.input.request_id);
    if (old) {
      if (old.digest !== digest) throw new HarnessError('REQUEST_CONFLICT');
      return old;
    }
    if (this.operation(ticketId, input.input.request_id)) throw new HarnessError('REQUEST_CONFLICT');
    return this.append({ kind: 'engineering_plan', ticket_id: ticketId, plan_id: randomUUID(),
      request_id: input.input.request_id, digest, input, created_at: new Date(this.now()).toISOString() }).data;
  }
  sourceSnapshot(input) {
    const key = authorityKey(input.action), source = this.sources[key];
    if (!source) throw new HarnessError('ENGINEERING_POLICY_UNAVAILABLE');
    const ticket = this.ticket(input.ticket_id);
    return source.snapshot(ticket.key, ...(input.action === 'review' ? [input.review_id] :
      input.action === 'implementation' ? [] : [input.action]), input.authorization_ref);
  }
  currentContent(ticket) {
    if (!ticket.comparison_baseline) throw new HarnessError('ENGINEERING_BASELINE_UNAVAILABLE');
    const content = identity(this.harness.changes.facts.currentIdentity(ticket.comparison_baseline));
    if (content.completeness !== 'complete') throw new HarnessError('SUBJECT_IDENTITY_CONFLICT');
    return content;
  }
  checkState(plan) {
    const input = plan.input, ticket = this.ticket(input.ticket_id);
    const content = this.currentContent(ticket);
    if (!same(content, plan.kind === 'workflow' ? input.expected.content_identity : input.content_identity))
      throw new HarnessError('SUBJECT_IDENTITY_CONFLICT');
    if (input.work_item) {
      const item = this.harness.executionOperations.workItems.get(input.work_item.work_item_id);
      if (item.delivery_item_id !== ticket.id || item.revision !== input.work_item.revision)
        throw new HarnessError('WORK_ITEM_REVISION_CONFLICT');
    }
    if (plan.kind === 'workflow') {
      const workflow = this.harness.workflowHistory.current.get(ticket.id);
      if (!workflow || workflow.workflow_revision !== input.expected.workflow_revision ||
          workflow.snapshot.subject.subject_id !== input.expected.subject_ref) throw new HarnessError('WORKFLOW_REVISION_CONFLICT');
      if (input.action === 'acceptance-agent' && (!plan.agent_criterion || plan.agent_criterion.criteria_ref !== input.criteria_ref
          || !workflow.snapshot.acceptance.criteria.some(value => value.criteria_ref === input.criteria_ref)))
        throw new HarnessError('ENGINEERING_AGENT_CRITERION_REQUIRED');
      const authority = this.sourceSnapshot(input);
      if (!same({ policy_id: authority.policy.policy_id, revision: authority.policy.revision, digest: authority.policy.digest }, input.expected.policy))
        throw new HarnessError('ENGINEERING_POLICY_CONFLICT');
      return { content, policy: authority.policy, source: authority.source };
    }
    return { content, policy: null, source: null };
  }
  async preview({ plan_id, scope }) {
    scope = adapterScopeSchema.parse(scope);
    const plan = this.records('engineering_plan').find(value => value.plan_id === plan_id);
    if (!plan) throw new HarnessError('ENGINEERING_PLAN_NOT_FOUND');
    this.harness.executionGate('new-side-effect');
    const state = this.checkState(plan.input);
    const ticket = this.ticket(plan.ticket_id), input = plan.input.input;
    const previewId = randomUUID();
    const permissions = plan.input.kind === 'workflow' ? await this.permissionsFor(plan.input.input) : null;
    const snapshot = { plan: plan.input, scope, adapter_id: this.adapterId, state, permissions,
      profile: this.profile, worktree: ticket.expected_worktree,
      authorization_ref: 'yer:' + previewId };
    const digest = workDigest(snapshot);
    this.append({ kind: 'engineering_preview', ticket_id: ticket.id, plan_id, preview_id: previewId,
      digest, snapshot, expires_at: new Date(this.now() + 5 * 60_000).toISOString() });
    return { schema_version: 1, source_id: this.journal.sourceId, preview_id: previewId, payload_digest: digest,
      request_id: input.request_id, expires_at: new Date(this.now() + 5 * 60_000).toISOString(), ...snapshot };
  }
  getPreview(id) {
    const record = this.records('engineering_preview').find(value => value.preview_id === id);
    if (!record || workDigest(record.snapshot) !== record.digest) throw new HarnessError('ENGINEERING_PREVIEW_NOT_FOUND');
    return record;
  }
  validatePreview(record) {
    if (this.now() >= Date.parse(record.expires_at)) throw new HarnessError('ENGINEERING_PREVIEW_EXPIRED');
    if (!same(this.checkState(record.snapshot.plan), record.snapshot.state)) throw new HarnessError('ENGINEERING_PREVIEW_STALE');
  }
  async confirm({ preview_id, payload_digest, scope }) {
    scope = adapterScopeSchema.parse(scope);
    const record = this.getPreview(preview_id), snapshot = record.snapshot;
    if (payload_digest !== record.digest || !same(scope, snapshot.scope) || snapshot.adapter_id !== this.adapterId)
      throw new HarnessError('ENGINEERING_CONFIRMATION_CONFLICT');
    const confirmed = this.records('engineering_confirmation').find(value => value.preview_id === preview_id);
    if (confirmed) {
      const receipt = this.operation(record.ticket_id, snapshot.plan.input.request_id);
      if (receipt) return snapshot.plan.kind === 'workflow'
        ? this.start({ ...snapshot.plan.input, authorization_ref: snapshot.authorization_ref }) : receipt;
    }
    this.harness.executionGate('new-side-effect');
    this.validatePreview(record);
    if (snapshot.plan.kind === 'workflow' &&
        !samePermissions(await this.permissionsFor(snapshot.plan.input), snapshot.permissions))
      throw new HarnessError('ENGINEERING_PERMISSION_CONFLICT');
    if (!confirmed) this.append({ kind: 'engineering_confirmation', ticket_id: record.ticket_id, preview_id,
      digest: record.digest, adapter_id: this.adapterId, confirmed_at: new Date(this.now()).toISOString() });
    if (snapshot.plan.kind === 'verification') return this.runVerification(record);
    return this.start({ ...snapshot.plan.input, authorization_ref: snapshot.authorization_ref });
  }
  snapshotAuthority(key, args, continuationInput = null) {
    const reference = args.at(-1);
    if (!reference?.startsWith('yer:')) {
      if (!this.sources[key]) throw new HarnessError('ENGINEERING_POLICY_UNAVAILABLE');
      return this.sources[key].snapshot(...args);
    }
    const record = this.getPreview(reference.slice(4));
    const confirmation = this.records('engineering_confirmation').find(value => value.preview_id === record.preview_id && value.digest === record.digest);
    if (!confirmation || record.snapshot.plan.kind !== 'workflow') throw new HarnessError('ENGINEERING_NOT_CONFIRMED');
    const input = continuationInput ?? record.snapshot.plan.input, ticket = this.ticket(input.ticket_id);
    if (key !== authorityKey(input.action) || args[0] !== ticket.key ||
        input.action !== 'implementation' && args[1] !== (input.action === 'review' ? input.review_id : input.action))
      throw new HarnessError('ENGINEERING_AUTHORITY_CONFLICT');
    const base = this.sourceSnapshot(record.snapshot.plan.input);
    if (!same({ policy: base.policy, source: base.source }, { policy: record.snapshot.state.policy, source: record.snapshot.state.source }))
      throw new HarnessError('ENGINEERING_POLICY_CONFLICT');
    const common = { schema_version: 1, authorization_id: record.preview_id, ticket_key: ticket.key,
      authorization_ref: reference, authority_refs: ['yer-confirmation:' + record.preview_id],
      ...(record.snapshot.profile ? { execution_profile: record.snapshot.profile } : {}) };
    let authorization;
    if (input.action === 'implementation') authorization = implementationAuthorizationSchema.parse({ ...common,
      action: 'ticket-implementation', endpoint: 'implementation', contract_version: 1, notes: input.expected.notes });
    else if (input.action === 'review') authorization = reviewAuthorizationSchema.parse({ ...common, review_id: input.review_id,
      action: 'ticket-review', endpoint: 'review', contract_version: 1, contract_digest: reviewContractDigest,
      subject_ref: input.expected.subject_ref, subject_identity: input.expected.subject_identity,
      content_identity: input.expected.content_identity });
    else {
      authorization = workflowAgentExecutionProtectionSchema.shape.authorization.parse({ ...common, action: input.action,
        subject_ref: input.expected.subject_ref, subject_identity: input.expected.subject_identity,
        ...(input.finding ? { finding: input.finding } : {}), ...(input.finding_batch ? { finding_batch: input.finding_batch } : {}),
        ...(input.review_id ? { review_id: input.review_id } : {}),
        ...(input.action === 'acceptance-agent' ? { acceptance_id: input.acceptance_id, agent_required: true,
          agent_criterion: record.snapshot.plan.agent_criterion } : {}) });
    }
    return { policy: base.policy, authorization, source: { schema_version: 1, kind: 'adapter',
      reference: 'yer-confirmation:' + record.preview_id, canonical_path: null, sha256: workDigest({ record, confirmation, input }) } };
  }
  async start(raw) {
    const input = startWorkflowAgentInputSchema.parse(raw);
    // Existing protected requests are reconciliation only, even after content or
    // policy changes. The launcher compares the original caller fingerprint.
    if (this.harness.executionOperations.findByRequest(input.ticket_id, input.request_id)) return this.launcher.start(input);
    let preview = null;
    if (input.authorization_ref.startsWith('yer:')) {
      const record = this.getPreview(input.authorization_ref.slice(4));
      preview = record.snapshot;
      const expected = { ...record.snapshot.plan.input, authorization_ref: record.snapshot.authorization_ref };
      if (record.snapshot.plan.kind !== 'workflow') throw new HarnessError('REQUEST_CONFLICT');
      if (!same(expected, input)) {
        const original = this.harness.executionOperations.findByRequest(expected.ticket_id, expected.request_id);
        if (!input.work_item || !original?.work_item || input.work_item.work_item_id !== original.work_item.work_item_id
            || input.ticket_id !== expected.ticket_id || input.action !== expected.action
            || input.expected.subject_ref !== expected.expected.subject_ref)
          throw new HarnessError('ENGINEERING_AUTHORITY_SCOPE_CONFLICT');
        this.checkState({ ...record.snapshot.plan, input });
      } else this.validatePreview(record);
      this.snapshotAuthority(authorityKey(input.action), [this.ticket(input.ticket_id).key,
        ...(input.action === 'implementation' ? [] : [input.action === 'review' ? input.review_id : input.action]), input.authorization_ref], input);
    }
    if (!preview) return this.launcher.start(input);
    // Compare the actual frozen dispatch permissions, including continuation,
    // at the existing guarded seam. Never replace Owner native defaults.
    const manager = new Proxy(this.manager, { get: (target, key) => {
      if (key === 'startGuarded' || key === 'sendGuarded') return (request, guard) => target[key](request, dispatch => {
        if (!samePermissions(dispatch.permissions, preview.permissions)) throw new HarnessError('ENGINEERING_PERMISSION_CONFLICT');
        return guard(dispatch);
      });
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const scoped = key => ({ snapshot: (...args) => this.snapshotAuthority(key, args, input) });
    return new WorkflowAgentLauncher({ ...this.launcherOptions, manager, harness: this.harness,
      implementationAuthority: scoped('implementationLaunchAuthority'), reviewAuthority: scoped('reviewLaunchAuthority'),
      workflowAuthority: scoped('workflowAgentAuthority') }).start(input);
  }
  async permissionsFor(input) {
    if (input.work_item) {
      const item = this.harness.executionOperations.workItems.get(input.work_item.work_item_id);
      const generation = item.generations.at(-1);
      if (generation?.session_id) return this.harness.source.session(generation.session_id).permissions;
    }
    return this.manager.permissionResolver.resolve(this.ticket(input.ticket_id).expected_worktree);
  }
  operation(ticketId, requestId) {
    this.ticket(ticketId);
    const execution = this.harness.executionOperations.findByRequest(ticketId, requestId);
    if (execution) return execution;
    const intent = this.records('engineering_task_intent').find(value => value.ticket_id === ticketId && value.request_id === requestId);
    if (!intent) return null;
    const receipt = this.records('engineering_task_receipt').find(value => value.ticket_id === ticketId && value.request_id === requestId);
    if (!receipt || receipt.service_epoch !== this.taskHost.tasks.epoch) return { ticket_id: ticketId, request_id: requestId,
      state: 'reconciliation-required', reconciliation_required: true, intent, receipt: receipt ?? null };
    try { return { ...receipt, state: 'observed', status: this.taskHost.tasks.status({ task_id: receipt.task_id }) }; }
    catch { return { ...receipt, state: 'unknown', reconciliation_required: true }; }
  }
  runVerification(record) {
    const input = record.snapshot.plan.input, old = this.operation(record.ticket_id, input.request_id);
    if (old) return old;
    this.checkState(record.snapshot.plan);
    this.harness.executionGate('new-side-effect');
    const service_epoch = this.taskHost.tasks.epoch;
    this.append({ kind: 'engineering_task_intent', ticket_id: input.ticket_id, request_id: input.request_id,
      preview_id: record.preview_id, work_item_id: input.work_item.work_item_id, revision: input.work_item.revision,
      content_identity: input.content_identity, service_epoch });
    const task = this.taskHost.tasks.start({ service_epoch, ticket_id: input.ticket_id, request_id: input.request_id,
      cwd: record.snapshot.worktree, script: input.script, timeout_ms: input.timeout_ms }, id => this.ticket(id));
    this.append({ kind: 'engineering_task_receipt', ticket_id: input.ticket_id, request_id: input.request_id,
      task_id: task.task_id, service_epoch });
    return this.operation(input.ticket_id, input.request_id);
  }
}
