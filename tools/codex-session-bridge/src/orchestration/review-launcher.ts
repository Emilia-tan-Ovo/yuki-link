import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../harness/model.ts';
import { executionContentIdentitySchema, implementationAuthoritySourceIdentitySchema,
  reviewAuthorizationSchema, reviewLaunchContractSchema, reviewPolicySnapshotSchema } from '../harness/execution-model.ts';

const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const policyBodySchema = reviewPolicySnapshotSchema.omit({ digest: true });
const authorityFileSchema = z.object({ schema_version: z.literal(1), active_policy: policyBodySchema,
  authorizations: z.array(reviewAuthorizationSchema).max(1024) }).strict();
export const startTicketReviewInputSchema = z.object({
  schema_version: z.literal(1), ticket_id: z.string().uuid(),
  request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  review_id: text, authorization_ref: text,
  expected: z.object({ workflow_revision: z.number().int().positive(),
    subject_ref: text, subject_identity: hash, content_identity: executionContentIdentitySchema,
    policy: z.object({ policy_id: text, revision: z.number().int().positive(), digest: hash }).strict(),
  }).strict(),
  references: z.array(text).max(32),
  current_delta: z.array(z.object({ ref: text, value: z.string().max(2048).nullable() }).strict()).max(32),
}).strict();

const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value as object).sort()
    .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}'
    : JSON.stringify(value);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const contract = reviewLaunchContractSchema.parse({ schema_version: 1, kind: 'ticket-review',
  destination: 'review-child', participant: 'coordinator', session: 'fresh' });
export const reviewContractDigest = sha256(stable(contract));
export function digestReviewPolicy(value: unknown) { return sha256(stable(policyBodySchema.parse(value))); }

export interface ReviewLaunchAuthoritySource {
  snapshot(ticketKey: string, reviewId: string, authorizationRef: string): {
    policy: z.infer<typeof reviewPolicySnapshotSchema>;
    authorization: z.infer<typeof reviewAuthorizationSchema> | null;
    source: z.infer<typeof implementationAuthoritySourceIdentitySchema>;
  };
}

export class FileReviewLaunchAuthoritySource implements ReviewLaunchAuthoritySource {
  private readonly requestedFilename: string;
  private readonly filename: string;
  private readonly forbiddenRoots: Array<{ lexical: string; canonical: string }>;
  constructor(filename: string, { forbiddenRoots = [] }: { forbiddenRoots?: string[] } = {}) {
    if (!path.isAbsolute(filename)) throw new HarnessError('REVIEW_AUTHORITY_UNTRUSTED');
    try {
      this.requestedFilename = filename;
      this.filename = realpathSync(filename);
      this.forbiddenRoots = forbiddenRoots.map(value => ({ lexical: path.resolve(value), canonical: realpathSync(value) }));
      this.assertTrusted(this.filename);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('REVIEW_AUTHORITY_UNAVAILABLE', {
        reason: error instanceof Error ? error.message : 'authority source unavailable' });
    }
  }
  private assertTrusted(canonical: string) {
    if (this.forbiddenRoots.some(root => inside(root.lexical, path.resolve(this.requestedFilename))
      || inside(root.canonical, canonical))) throw new HarnessError('REVIEW_AUTHORITY_UNTRUSTED');
  }
  snapshot(ticketKey: string, reviewId: string, authorizationRef: string) {
    let bytes: Buffer;
    let document: z.infer<typeof authorityFileSchema>;
    try {
      const canonical = realpathSync(this.requestedFilename);
      if (canonical !== this.filename) throw new HarnessError('REVIEW_AUTHORITY_UNTRUSTED');
      this.assertTrusted(canonical);
      bytes = readFileSync(canonical);
      document = authorityFileSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('REVIEW_AUTHORITY_UNAVAILABLE', {
        reason: error instanceof Error ? error.message : 'authority source unavailable' });
    }
    const policy = reviewPolicySnapshotSchema.parse({ ...document.active_policy,
      digest: digestReviewPolicy(document.active_policy) });
    const authorization = document.authorizations.find(value => value.ticket_key === ticketKey
      && value.review_id === reviewId && value.authorization_ref === authorizationRef
      && value.action === 'ticket-review' && value.endpoint === 'review' && value.contract_version === 1) ?? null;
    const source = implementationAuthoritySourceIdentitySchema.parse({ schema_version: 1, kind: 'file',
      reference: this.requestedFilename, canonical_path: this.filename, sha256: sha256(bytes) });
    return { policy, authorization, source };
  }
}

type Input = z.infer<typeof startTicketReviewInputSchema>;
export class ReviewLauncher {
  private readonly manager: any;
  private readonly harness: any;
  private readonly authority: ReviewLaunchAuthoritySource | null;
  constructor({ manager, harness, authority }: { manager: any; harness: any; authority: ReviewLaunchAuthoritySource | null }) {
    this.manager = manager; this.harness = harness; this.authority = authority;
  }
  private callerFingerprint(input: Input) {
    return sha256(stable(input));
  }
  private current(input: Input, frozen?: any) {
    const ticket = this.harness.tickets.get(input.ticket_id);
    if (!ticket) throw new HarnessError('TICKET_NOT_FOUND');
    const project = this.harness.projects.get(ticket.project_id);
    if (!this.authority) throw new HarnessError('REVIEW_AUTHORITY_UNAVAILABLE', { reprepare_required: true });
    const authority = this.authority.snapshot(ticket.key, input.review_id, input.authorization_ref);
    const policy = reviewPolicySnapshotSchema.parse(authority.policy);
    implementationAuthoritySourceIdentitySchema.parse(authority.source);
    const expectedPolicy = frozen ? { policy_id: frozen.policy.policy_id, revision: frozen.policy.revision,
      digest: frozen.policy.digest } : input.expected.policy;
    if (!same({ policy_id: policy.policy_id, revision: policy.revision, digest: policy.digest }, expectedPolicy)) {
      throw new HarnessError('REVIEW_POLICY_CONFLICT', { reprepare_required: true });
    }
    if (!project || policy.project_key !== project.key || policy.action !== 'ticket-review'
      || policy.workflow_phase !== 'review' || !policy.supported_contract_versions.includes(contract.schema_version)
      || policy.permission_selection !== 'owner-native-default') {
      throw new HarnessError('REVIEW_POLICY_NOT_APPLICABLE', { reprepare_required: true });
    }
    const authorization = authority.authorization;
    if (!authorization || !reviewAuthorizationSchema.safeParse(authorization).success
      || authorization.ticket_key !== ticket.key || authorization.review_id !== input.review_id
      || authorization.action !== 'ticket-review' || authorization.endpoint !== 'review'
      || authorization.authorization_ref !== input.authorization_ref || authorization.contract_version !== 1
      || authorization.contract_digest !== reviewContractDigest
      || authorization.subject_ref !== input.expected.subject_ref
      || authorization.subject_identity !== input.expected.subject_identity
      || !same(authorization.content_identity, input.expected.content_identity)) {
      throw new HarnessError('REVIEW_NOT_AUTHORIZED', { reprepare_required: true });
    }
    if (frozen && !same(authority, frozen)) throw new HarnessError('REVIEW_AUTHORITY_CONFLICT', {
      reprepare_required: true });
    const workflow = this.harness.workflowHistory.current.get(input.ticket_id);
    const review = workflow?.snapshot?.reviews?.find((value: any) => value.review_id === input.review_id);
    if (!workflow || workflow.workflow_revision !== input.expected.workflow_revision
      || workflow.snapshot?.phase !== 'review' || workflow.snapshot?.subject?.subject_id !== input.expected.subject_ref
      || !review || review.mode !== 'full' || review.status !== 'pending'
      || review.subject_ref !== input.expected.subject_ref
      || review.subject_identity !== input.expected.subject_identity) {
      throw new HarnessError('REVIEW_WORKFLOW_CONFLICT', { reprepare_required: true });
    }
    if (!ticket.comparison_baseline || !ticket.expected_worktree) {
      throw new HarnessError('REVIEW_GIT_IDENTITY_INCOMPLETE', { reprepare_required: true });
    }
    let cwd: string;
    try { cwd = realpathSync(ticket.expected_worktree); }
    catch { throw new HarnessError('REVIEW_ENVIRONMENT_CONFLICT', { reprepare_required: true }); }
    if (authority.source.canonical_path && inside(cwd, authority.source.canonical_path)) {
      throw new HarnessError('REVIEW_AUTHORITY_UNTRUSTED', { reprepare_required: true });
    }
    const raw = this.harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    const contentIdentity = executionContentIdentitySchema.safeParse(raw && { scheme: raw.scheme,
      version: raw.version, scope: raw.scope, completeness: raw.completeness, digest: raw.digest });
    if (!contentIdentity.success || contentIdentity.data.completeness !== 'complete'
      || !same(contentIdentity.data, input.expected.content_identity)) {
      throw new HarnessError('SUBJECT_IDENTITY_CONFLICT', { reprepare_required: true });
    }
    return { ticket, policy, authorization, authority, workflow, cwd };
  }
  private prompt(snapshot: ReturnType<ReviewLauncher['current']>, input: Input) {
    const references = [...new Set([snapshot.ticket.reference, ...input.references])];
    return { references, text: [
      '执行 Ticket fresh Review，顺序检查 Standards 与 Spec 两轴。仅从以下持久化引用恢复上下文：',
      ...references.map(value => `- ${value}`),
      '当前 delta：', ...input.current_delta.map(value => `- ${value.ref}: ${value.value ?? 'null'}`),
      `Review ID：${input.review_id}；subject：${input.expected.subject_ref}；session=fresh；destination=Review child。`,
      '报告 findings 与证据后停止；不要实现、验收或执行外部写入。',
    ].join('\n') };
  }
  async start(raw: unknown) {
    const parsed = startTicketReviewInputSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessError('INVALID_REVIEW_LAUNCH_REQUEST', { issues: parsed.error.issues });
    const input = parsed.data;
    const callerFingerprint = this.callerFingerprint(input);
    const existing = this.harness.executionOperations.findByRequest(input.ticket_id, input.request_id);
    if (existing) {
      if (existing.fingerprint_version !== 'execution-protected-v3'
        || existing.caller_fingerprint !== callerFingerprint) {
        throw new HarnessError('REQUEST_CONFLICT', { operation_id: existing.operation_id });
      }
      return { ...this.harness.executionOperations.reconcile(existing.operation_id), deduplicated: true };
    }
    this.harness.executionGate('new-side-effect');
    const snapshot = this.current(input);
    const prompt = this.prompt(snapshot, input);
    const reserved = this.harness.executionOperations.reserve({
      ticket_id: input.ticket_id, request_id: input.request_id,
      destination: { kind: 'child', relation: { kind: 'review', review_id: input.review_id, participant: 'coordinator' } },
      expected_workflow_revision: input.expected.workflow_revision, subject_ref: input.expected.subject_ref,
      content_identity: input.expected.content_identity,
      launch: { cwd: snapshot.cwd, prompt: prompt.text, sender: 'Emilia', model: snapshot.policy.model,
        reasoning: snapshot.policy.reasoning, timeout_ms: null, permissions: null },
      authorization_boundary: { schema_version: 1, policy_id: snapshot.policy.policy_id,
        decision_ref: snapshot.authorization.authorization_ref,
        concurrency: { mode: 'single-line', decision_ref: null } },
      review: { caller_fingerprint: callerFingerprint, contract, policy: snapshot.policy,
        authorization: snapshot.authorization, authority_source: snapshot.authority.source,
        prompt_context: { references: prompt.references, current_delta: input.current_delta },
        preflight: { workflow_revision: input.expected.workflow_revision,
          subject_ref: input.expected.subject_ref, subject_identity: input.expected.subject_identity } },
    });
    if (reserved.deduplicated) return { ...this.harness.executionOperations.reconcile(reserved.operation_id),
      deduplicated: true };
    try {
      await this.manager.startGuarded({ request_id: reserved.runtime.request_id, cwd: snapshot.cwd,
        prompt: prompt.text, sender: 'Emilia', model: snapshot.policy.model, reasoning: snapshot.policy.reasoning },
      (dispatch: any) => {
        this.current(input, snapshot.authority);
        if (dispatch?.config?.model !== snapshot.policy.model
          || dispatch?.config?.reasoning !== snapshot.policy.reasoning) {
          throw new HarnessError('REVIEW_MODEL_POLICY_CONFLICT', { reprepare_required: true });
        }
        this.harness.executionOperations.guardDispatch(reserved.operation_id, dispatch);
      });
    } catch (error) {
      const current = this.harness.executionOperations.query(reserved.operation_id);
      if (current.state === 'reserved') this.harness.executionOperations.failReserved(reserved.operation_id,
        (error as any)?.code ?? 'REVIEW_LAUNCH_REJECTED', error instanceof Error ? error.message : 'launch rejected');
      else if (current.state === 'dispatching' || current.state === 'started') {
        this.harness.executionOperations.requireReconciliation(reserved.operation_id,
          (error as any)?.code ?? 'REVIEW_LAUNCH_OUTCOME_UNKNOWN', error instanceof Error ? error.message : 'launch outcome unknown');
      }
      throw error;
    }
    try {
      this.harness.executionOperations.markStarted(reserved.operation_id);
      return this.harness.executionOperations.bind(reserved.operation_id);
    } catch (error) {
      if ((error as any)?.code === 'RECORDING_OUTCOME_UNKNOWN') {
        const receipt = this.harness.executionOperations.reconcile(reserved.operation_id);
        return { ...receipt, effective_state: 'reconciliation-required', reconciliation: {
          ...(receipt.reconciliation ?? {}), recording_outcome: 'unknown', checked_restart_required: true } };
      }
      throw error;
    }
  }
}
