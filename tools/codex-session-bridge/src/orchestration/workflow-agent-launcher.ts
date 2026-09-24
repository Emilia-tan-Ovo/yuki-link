import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../harness/model.ts';
import { executionContentIdentitySchema, workflowAgentActionSchema,
  workflowAgentExecutionProtectionSchema } from '../harness/execution-model.ts';
import { ImplementationLauncher, HostImplementationEnvironmentSource,
  startTicketImplementationInputSchema } from './implementation-launcher.ts';
import { ReviewLauncher, startTicketReviewInputSchema } from './review-launcher.ts';
import { ContextAssembler } from './context-assembler.ts';
import { HarnessContextFactsSource } from './harness-context-source.ts';

const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const policySchema = workflowAgentExecutionProtectionSchema.shape.policy;
const authorizationSchema = workflowAgentExecutionProtectionSchema.shape.authorization;
const authorityFileSchema = z.object({ schema_version: z.literal(1),
  policies: z.array(policySchema.omit({ digest: true })).max(32),
  authorizations: z.array(authorizationSchema).max(1024) }).strict();
const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value as object).sort()
    .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}'
    : JSON.stringify(value);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const digestWorkflowAgentPolicy = (value: unknown) => sha256(stable(policySchema.omit({ digest: true }).parse(value)));
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

const genericInput = z.object({ schema_version: z.literal(1), action: workflowAgentActionSchema,
  ticket_id: z.string().uuid(), request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  authorization_ref: text,
  expected: z.object({ workflow_revision: z.number().int().positive(), subject_ref: text,
    subject_identity: hash.nullable(), content_identity: executionContentIdentitySchema,
    policy: z.object({ policy_id: text, revision: z.number().int().positive(), digest: hash }).strict() }).strict(),
  references: z.array(text).max(32),
  current_delta: z.array(z.object({ ref: text, value: z.string().max(2048).nullable() }).strict()).max(32),
}).strict();
const findingInput = genericInput.omit({ references: true, current_delta: true }).extend({
  finding: z.object({ origin_review_id: text, finding_id: text, report_ref: text,
    fix_baseline: text }).strict(),
}).strict();
export const startWorkflowAgentInputSchema = z.discriminatedUnion('action', [
  startTicketImplementationInputSchema.extend({ action: z.literal('implementation') }).strict(),
  startTicketReviewInputSchema.extend({ action: z.literal('review') }).strict(),
  genericInput.extend({ action: z.literal('ticket-design') }).strict(),
  findingInput.extend({ action: z.literal('finding-fix') }).strict(),
  findingInput.extend({ action: z.literal('focused-review'), review_id: text }).strict(),
  genericInput.extend({ action: z.literal('acceptance-agent'), acceptance_id: text,
    criteria_ref: text }).strict(),
]);
type GenericInput = Extract<z.infer<typeof startWorkflowAgentInputSchema>,
  { action: 'ticket-design' | 'finding-fix' | 'focused-review' | 'acceptance-agent' }>;

const phases = {
  'ticket-design': { phase: 'ticket-design', destination: 'main', requestedAction: 'ticket-design' },
  'finding-fix': { phase: 'implementation', destination: 'main', requestedAction: 'implementation' },
  'focused-review': { phase: 'review', destination: 'review-child', requestedAction: 'review' },
  'acceptance-agent': { phase: 'acceptance', destination: 'acceptance-child', requestedAction: 'acceptance' },
} as const;

export class FileWorkflowAgentAuthoritySource {
  private readonly filename: string;
  private readonly canonical: string;
  private readonly forbiddenRoots: Array<{ lexical: string; canonical: string }>;
  constructor(filename: string, { forbiddenRoots = [] }: { forbiddenRoots?: string[] } = {}) {
    if (!path.isAbsolute(filename)) throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_UNTRUSTED');
    this.filename = filename;
    try {
      this.canonical = realpathSync(filename);
      this.forbiddenRoots = forbiddenRoots.map(value => ({ lexical: path.resolve(value), canonical: realpathSync(value) }));
      this.assertTrusted();
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_UNAVAILABLE');
    }
  }
  private assertTrusted() {
    if (realpathSync(this.filename) !== this.canonical || this.forbiddenRoots.some(root =>
      inside(root.lexical, path.resolve(this.filename)) || inside(root.canonical, this.canonical))) {
      throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_UNTRUSTED');
    }
  }
  snapshot(ticketKey: string, action: GenericInput['action'], authorizationRef: string) {
    let bytes: Buffer;
    let document: z.infer<typeof authorityFileSchema>;
    try {
      this.assertTrusted();
      bytes = readFileSync(this.canonical);
      document = authorityFileSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_UNAVAILABLE');
    }
    const matches = document.policies.filter(value => value.action === action);
    if (matches.length !== 1) throw new HarnessError('WORKFLOW_AGENT_POLICY_CONFLICT');
    const policy = policySchema.parse({ ...matches[0], digest: digestWorkflowAgentPolicy(matches[0]) });
    const authorizations = document.authorizations.filter(value => value.ticket_key === ticketKey
      && value.action === action && value.authorization_ref === authorizationRef);
    if (authorizations.length > 1) throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_CONFLICT');
    return { policy, authorization: authorizations[0] ?? null,
      source: { schema_version: 1 as const, kind: 'file' as const, reference: this.filename,
        canonical_path: this.canonical, sha256: sha256(bytes) } };
  }
}

export class WorkflowAgentLauncher {
  private readonly dependencies: { manager: any; harness: any;
    implementationAuthority?: any; reviewAuthority?: any; workflowAuthority?: FileWorkflowAgentAuthoritySource | null;
    environment?: HostImplementationEnvironmentSource; context?: (ticketId: string, action: string) => any };
  constructor(dependencies: WorkflowAgentLauncher['dependencies']) { this.dependencies = dependencies; }

  async start(raw: unknown) {
    const parsed = startWorkflowAgentInputSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessError('INVALID_WORKFLOW_AGENT_REQUEST', { issues: parsed.error.issues });
    const input = parsed.data;
    const { manager, harness } = this.dependencies;
    if (input.action === 'implementation') {
      const { action, ...legacy } = input;
      return new ImplementationLauncher({ manager, harness,
        authority: this.dependencies.implementationAuthority ?? null }).start(legacy);
    }
    if (input.action === 'review') {
      const { action, ...legacy } = input;
      return new ReviewLauncher({ manager, harness,
        authority: this.dependencies.reviewAuthority ?? null }).start(legacy);
    }
    return this.startGeneric(input);
  }

  private current(input: GenericInput, frozen?: any) {
    const { harness } = this.dependencies;
    const phase = phases[input.action as keyof typeof phases];
    if (!phase) throw new HarnessError('INVALID_WORKFLOW_AGENT_REQUEST');
    const ticket = harness.tickets.get(input.ticket_id);
    if (!ticket) throw new HarnessError('TICKET_NOT_FOUND');
    const project = harness.projects.get(ticket.project_id);
    const source = this.dependencies.workflowAuthority;
    if (!source) throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_UNAVAILABLE');
    const authority = source.snapshot(ticket.key, input.action, input.authorization_ref);
    const { policy, authorization } = authority;
    const expectedPolicy = frozen ? frozen.authority.policy : input.expected.policy;
    if (!same({ policy_id: policy.policy_id, revision: policy.revision, digest: policy.digest },
      { policy_id: expectedPolicy.policy_id, revision: expectedPolicy.revision, digest: expectedPolicy.digest })) {
      throw new HarnessError('WORKFLOW_AGENT_POLICY_CONFLICT');
    }
    if (!project || policy.project_key !== project.key || policy.workflow_phase !== phase.phase
      || policy.permission_selection !== 'owner-native-default') throw new HarnessError('WORKFLOW_AGENT_POLICY_NOT_APPLICABLE');
    if (!authorization || authorization.subject_ref !== input.expected.subject_ref
      || authorization.subject_identity !== input.expected.subject_identity
      || !authorization.authority_refs.length) throw new HarnessError('WORKFLOW_AGENT_NOT_AUTHORIZED');
    if ((input.action === 'finding-fix' || input.action === 'focused-review')
      && !same(authorization.finding, input.finding)) throw new HarnessError('WORKFLOW_AGENT_NOT_AUTHORIZED');
    if (input.action === 'focused-review' && authorization.review_id !== input.review_id) {
      throw new HarnessError('WORKFLOW_AGENT_NOT_AUTHORIZED');
    }
    if (input.action === 'acceptance-agent' && authorization.acceptance_id !== input.acceptance_id) {
      throw new HarnessError('WORKFLOW_AGENT_NOT_AUTHORIZED');
    }
    if (input.action === 'acceptance-agent'
      && (authorization.agent_criterion?.criteria_ref !== input.criteria_ref
        || authorization.agent_criterion?.behavior !== 'agent-session')) {
      throw new HarnessError('WORKFLOW_AGENT_NOT_AUTHORIZED');
    }
    if (frozen && !same(authority, frozen.authority)) throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_CONFLICT');
    const workflow = harness.workflowHistory.current.get(input.ticket_id);
    if (!workflow || workflow.workflow_revision !== input.expected.workflow_revision
      || workflow.snapshot?.phase !== phase.phase
      || workflow.snapshot?.subject?.subject_id !== input.expected.subject_ref) {
      throw new HarnessError('WORKFLOW_AGENT_WORKFLOW_CONFLICT');
    }
    if (!ticket.comparison_baseline || !ticket.expected_worktree) throw new HarnessError('WORKFLOW_AGENT_GIT_IDENTITY_INCOMPLETE');
    const rawIdentity = harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    const identity = executionContentIdentitySchema.safeParse(rawIdentity && {
      scheme: rawIdentity.scheme, version: rawIdentity.version, scope: rawIdentity.scope,
      completeness: rawIdentity.completeness, digest: rawIdentity.digest });
    if (!identity.success || identity.data.completeness !== 'complete'
      || !same(identity.data, input.expected.content_identity)) throw new HarnessError('SUBJECT_IDENTITY_CONFLICT');
    let cwd: string;
    try { cwd = realpathSync(ticket.expected_worktree); } catch { throw new HarnessError('WORKFLOW_AGENT_ENVIRONMENT_CONFLICT'); }
    if (authority.source.canonical_path && inside(cwd, authority.source.canonical_path)) {
      throw new HarnessError('WORKFLOW_AGENT_AUTHORITY_UNTRUSTED');
    }
    const environment = (this.dependencies.environment ?? new HostImplementationEnvironmentSource()).observe(cwd,
      policy as any, null);
    if (frozen && !same(environment, frozen.environment)) throw new HarnessError('WORKFLOW_AGENT_ENVIRONMENT_CONFLICT');
    const snapshot = workflow.snapshot;
    if (input.action === 'ticket-design' && snapshot.findings?.length) throw new HarnessError('WORKFLOW_AGENT_PHASE_CONFLICT');
    if (input.action === 'finding-fix') {
      const finding = input.finding;
      const observed = snapshot.findings?.find((value: any) => value.origin_review_id === finding?.origin_review_id
        && value.finding_id === finding?.finding_id);
      if (!finding || !observed || !['open', 'fixed-unverified'].includes(observed.status)
        || !finding.fix_baseline || !finding.report_ref) throw new HarnessError('WORKFLOW_AGENT_FINDING_CONFLICT');
    }
    if (input.action === 'focused-review') {
      const review = snapshot.reviews?.find((value: any) => value.review_id === input.review_id);
      const finding = snapshot.findings?.find((value: any) => value.origin_review_id === input.finding?.origin_review_id
        && value.finding_id === input.finding?.finding_id);
      if (!review || review.mode !== 'focused' || review.status !== 'pending'
        || review.subject_ref !== input.expected.subject_ref
        || review.subject_identity !== input.expected.subject_identity
        || !finding || !['fixed', 'fixed-unverified'].includes(finding.status)
        || !input.finding || !review.finding_refs?.some((value: any) =>
          value.origin_review_id === input.finding?.origin_review_id && value.finding_id === input.finding?.finding_id)) {
        throw new HarnessError('WORKFLOW_AGENT_REVIEW_CONFLICT');
      }
    }
    if (input.action === 'acceptance-agent') {
      if (!authorization.agent_required || !input.acceptance_id
        || snapshot.acceptance?.acceptance_id !== input.acceptance_id
        || snapshot.acceptance?.status !== 'pending'
        || !snapshot.acceptance.criteria?.some((value: any) => value.criteria_ref === input.criteria_ref)
        || !authorization.agent_criterion?.requirement) {
        throw new HarnessError('WORKFLOW_AGENT_ACCEPTANCE_NOT_REQUIRED');
      }
    }
    const packet = this.dependencies.context?.(input.ticket_id, phase.requestedAction)
      ?? new ContextAssembler(new HarnessContextFactsSource(harness)).assemble({ ticket_id: input.ticket_id,
        requested_action: phase.requestedAction, trigger: 'handoff' });
    if (packet.integrity?.state === 'conflicted' || packet.integrity?.state === 'stale'
      || packet.attention?.unknown_side_effects?.length) throw new HarnessError('WORKFLOW_AGENT_CONTEXT_CONFLICT');
    return { ticket, policy, authorization, authority, workflow, environment, cwd, packet, phase };
  }

  private async startGeneric(input: GenericInput) {
    const { harness, manager } = this.dependencies;
    const callerFingerprint = sha256(stable(input));
    const existing = harness.executionOperations.findByRequest(input.ticket_id, input.request_id);
    if (existing) {
      if (existing.fingerprint_version !== 'execution-protected-v4'
        || existing.caller_fingerprint !== callerFingerprint) throw new HarnessError('REQUEST_CONFLICT');
      return { ...harness.executionOperations.reconcile(existing.operation_id), deduplicated: true };
    }
    harness.executionGate('new-side-effect');
    const snapshot = this.current(input);
    const { phase } = snapshot;
    const narrow = input.action === 'finding-fix' || input.action === 'focused-review';
    const references = [...new Set([snapshot.ticket.reference,
      ...(narrow ? [input.finding.report_ref, ...(snapshot.authorization.finding_context_refs ?? [])]
        : [...input.references, ...snapshot.packet.retrieval.references.map((value: any) => value.location)])]
      .filter(Boolean))].slice(0, 64);
    const finding = input.action === 'finding-fix' || input.action === 'focused-review'
      ? [`原 finding：${input.finding.origin_review_id}/${input.finding.finding_id}`,
        `报告：${input.finding.report_ref}`, `修复基线：${input.finding.fix_baseline}`] : [];
    const instruction = input.action === 'ticket-design' ? '只完成 Ticket implementation design、Implementation Notes 与 Context Plan；不要修改实现代码。'
      : input.action === 'finding-fix' ? '只修复原 finding，做最小定向测试、commit 与 handoff 后停止。'
      : input.action === 'focused-review' ? '只复核原 finding 与 fix delta，报告证据后停止；不要实现。'
      : '只核验明确要求 Agent/session 行为的验收项；不要执行 deterministic Acceptance 的其他工作。';
    const currentDelta = input.action === 'finding-fix' || input.action === 'focused-review'
      ? [{ ref: 'fix_baseline', value: input.finding.fix_baseline },
        { ref: 'subject_head', value: snapshot.workflow.snapshot.subject.head }]
      : input.current_delta;
    const criterion = input.action === 'acceptance-agent'
      ? [`验收项 ${input.criteria_ref}：${snapshot.authorization.agent_criterion!.requirement}`] : [];
    const prompt = [`执行 ${input.action}。仅从持久化引用恢复上下文：`,
      ...references.map(value => `- ${value}`), ...finding,
      ...criterion, '当前 delta：', ...currentDelta.map(value => `- ${value.ref}: ${value.value ?? 'null'}`),
      `结构化 contract：session=fresh；destination=${phase.destination}；Owner native permissions。`, instruction].join('\n');
    const destination = phase.destination === 'main' ? { kind: 'main' }
      : input.action === 'focused-review' ? { kind: 'child', relation: { kind: 'review',
        review_id: input.review_id, participant: 'coordinator' } }
        : { kind: 'child', relation: { kind: 'acceptance',
          acceptance_id: input.action === 'acceptance-agent' ? input.acceptance_id : undefined } };
    const contract = { schema_version: 1, session: 'fresh', destination: phase.destination,
      review_policy: input.action === 'finding-fix' ? 'delegated' : null };
    const protection = { caller_fingerprint: callerFingerprint, action: input.action, contract,
      policy: snapshot.policy, authorization: snapshot.authorization, authority_source: snapshot.authority.source,
      prompt_context: { references, current_delta: currentDelta },
      preflight: { workflow_revision: input.expected.workflow_revision, subject_ref: input.expected.subject_ref,
        subject_identity: input.expected.subject_identity, environment: snapshot.environment } };
    const reserved = harness.executionOperations.reserve({ ticket_id: input.ticket_id, request_id: input.request_id,
      destination, expected_workflow_revision: input.expected.workflow_revision,
      subject_ref: input.expected.subject_ref, content_identity: input.expected.content_identity,
      launch: { cwd: snapshot.cwd, prompt, sender: 'Emilia', model: snapshot.policy.model,
        reasoning: snapshot.policy.reasoning, timeout_ms: null, permissions: null },
      authorization_boundary: { schema_version: 1, policy_id: snapshot.policy.policy_id,
        decision_ref: snapshot.authorization.authorization_ref,
        concurrency: { mode: 'single-line', decision_ref: null } }, workflow_agent: protection });
    if (reserved.deduplicated) return { ...harness.executionOperations.reconcile(reserved.operation_id), deduplicated: true };
    try {
      await manager.startGuarded({ request_id: reserved.runtime.request_id, cwd: snapshot.cwd,
        prompt, sender: 'Emilia', model: snapshot.policy.model, reasoning: snapshot.policy.reasoning },
      (dispatch: any) => {
        this.current(input, snapshot);
        if (dispatch?.config?.model !== snapshot.policy.model || dispatch?.config?.reasoning !== snapshot.policy.reasoning) {
          throw new HarnessError('WORKFLOW_AGENT_MODEL_POLICY_CONFLICT');
        }
        harness.executionOperations.guardDispatch(reserved.operation_id, dispatch);
      });
    } catch (error) {
      const current = harness.executionOperations.query(reserved.operation_id);
      if (current.state === 'reserved') harness.executionOperations.failReserved(reserved.operation_id,
        (error as any)?.code ?? 'WORKFLOW_AGENT_LAUNCH_REJECTED', error instanceof Error ? error.message : 'launch rejected');
      else if (current.state === 'dispatching' || current.state === 'started') harness.executionOperations.requireReconciliation(
        reserved.operation_id, (error as any)?.code ?? 'WORKFLOW_AGENT_LAUNCH_OUTCOME_UNKNOWN',
        error instanceof Error ? error.message : 'launch outcome unknown');
      throw error;
    }
    try {
      harness.executionOperations.markStarted(reserved.operation_id);
      return harness.executionOperations.bind(reserved.operation_id);
    } catch (error) {
      if ((error as any)?.code === 'RECORDING_OUTCOME_UNKNOWN') {
        const receipt = harness.executionOperations.reconcile(reserved.operation_id);
        return { ...receipt, effective_state: 'reconciliation-required', reconciliation: {
          ...(receipt.reconciliation ?? {}), recording_outcome: 'unknown', checked_restart_required: true } };
      }
      throw error;
    }
  }
}
