import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { inspectDependency, inspectHostCapabilities } from './preflight.ts';
import { z } from 'zod';
import { HarnessError } from '../harness/model.ts';
import { executionContentIdentitySchema, implementationAuthorizationSchema, implementationAuthoritySourceIdentitySchema,
  implementationExecutableIdentitySchema, implementationLaunchContractSchema,
  implementationPolicySnapshotSchema } from '../harness/execution-model.ts';

const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const policyBodySchema = implementationPolicySnapshotSchema.omit({ digest: true });
const authorizationFileSchema = z.object({
  schema_version: z.literal(1), active_policy: policyBodySchema,
  authorizations: z.array(implementationAuthorizationSchema).max(1024),
}).strict();

export const startTicketImplementationInputSchema = z.object({
  schema_version: z.literal(1), ticket_id: z.string().uuid(),
  request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  authorization_ref: text,
  expected: z.object({
    workflow_revision: z.number().int().positive(), subject_ref: text,
    content_identity: executionContentIdentitySchema,
    policy: z.object({ policy_id: text, revision: z.number().int().positive(), digest: hash }).strict(),
    notes: z.object({ path: text, sha256: hash }).strict(),
  }).strict(),
  current_delta: z.array(z.object({ ref: text, value: z.string().max(2048).nullable() }).strict()).max(32),
}).strict();

const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value as object).sort()
    .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}'
    : JSON.stringify(value);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const isInside = (root: string, candidate: string) => {
  const relation = path.relative(root, candidate);
  return relation === '' || relation !== '..' && !relation.startsWith('..' + path.sep) && !path.isAbsolute(relation);
};

export function digestImplementationPolicy(value: unknown) {
  return sha256(stable(policyBodySchema.parse(value)));
}

export interface ImplementationLaunchAuthoritySource {
  snapshot(ticketKey: string, authorizationRef: string): {
    policy: z.infer<typeof implementationPolicySnapshotSchema>;
    authorization: z.infer<typeof implementationAuthorizationSchema> | null;
    source: z.infer<typeof implementationAuthoritySourceIdentitySchema>;
  };
}

export function targetDependencyPackages(policy: z.infer<typeof implementationPolicySnapshotSchema>): string[] {
  const packages = policy.preflight.dependency_packages;
  if (!packages || new Set(packages).size !== packages.length || packages.some(value =>
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value))) {
    throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', {
      observed: 'target-packages-unknown', reprepare_required: true,
    });
  }
  return packages;
}

export class FileImplementationLaunchAuthoritySource implements ImplementationLaunchAuthoritySource {
  private readonly requestedFilename: string;
  private readonly filename: string;
  constructor(filename: string, { forbiddenRoots = [] }: { forbiddenRoots?: string[] } = {}) {
    if (!path.isAbsolute(filename)) throw new HarnessError('IMPLEMENTATION_AUTHORITY_UNTRUSTED', {
      source: filename, reason: 'authority source path must be absolute',
    });
    this.requestedFilename = filename;
    try {
      this.filename = realpathSync(filename);
      for (const root of forbiddenRoots.map(value => ({ lexical: path.resolve(value), canonical: realpathSync(value) }))) {
        if (isInside(root.lexical, path.resolve(filename)) || isInside(root.canonical, this.filename)) {
          throw new HarnessError('IMPLEMENTATION_AUTHORITY_UNTRUSTED', {
            source: filename, canonical_source: this.filename, forbidden_root: root.canonical,
          });
        }
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('IMPLEMENTATION_AUTHORITY_UNAVAILABLE', {
        source: filename, reason: error instanceof Error ? error.message : 'authority source unavailable',
      });
    }
  }
  private read() {
    try {
      const observed = realpathSync(this.requestedFilename);
      if (path.relative(this.filename, observed) !== '') throw new HarnessError('IMPLEMENTATION_AUTHORITY_UNTRUSTED', {
        source: this.requestedFilename, expected: this.filename, observed,
      });
      const bytes = readFileSync(this.filename);
      return { document: authorizationFileSchema.parse(JSON.parse(bytes.toString('utf8'))), bytes };
    }
    catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('IMPLEMENTATION_AUTHORITY_UNAVAILABLE', {
        source: this.filename, reason: error instanceof Error ? error.message : 'authority source unavailable',
      });
    }
  }
  snapshot(ticketKey: string, authorizationRef: string) {
    const { document, bytes } = this.read();
    const body = document.active_policy;
    const policy = implementationPolicySnapshotSchema.parse({ ...body, digest: digestImplementationPolicy(body) });
    const authorization = document.authorizations.find(value => value.ticket_key === ticketKey
      && value.authorization_ref === authorizationRef && value.action === 'ticket-implementation'
      && value.endpoint === 'implementation' && value.contract_version === 1) ?? null;
    const source = implementationAuthoritySourceIdentitySchema.parse({
      schema_version: 1, kind: 'file', reference: this.requestedFilename,
      canonical_path: this.filename, sha256: sha256(bytes),
    });
    return { policy, authorization, source };
  }
}

interface EnvironmentSource {
  observe(cwd: string, policy: z.infer<typeof implementationPolicySnapshotSchema>, notes: { path: string; sha256: string }): {
    required_paths: string[]; required_executables: Array<z.infer<typeof implementationExecutableIdentitySchema>>;
    dependencies?: Array<{ package_directory: string; manifest_sha256: string; lock_sha256: string | null;
      modules_mtime_ms: number | null; node_path: string; node_version: string }>;
    capabilities?: { path_digest: string; rg_state: 'available' | 'unavailable'; rg_path: string | null;
      rg_version: string | null; fallbacks: string[] };
  };
}

export class HostImplementationEnvironmentSource implements EnvironmentSource {
  observe(cwd: string, policy: z.infer<typeof implementationPolicySnapshotSchema>, notes: { path: string; sha256: string }) {
    const lexicalRoot = path.resolve(cwd);
    let root: string;
    try { root = realpathSync(cwd); }
    catch { throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', { source: cwd,
      observed: 'worktree-unavailable', reprepare_required: true }); }
    const resolveInside = (relative: string) => {
      if (path.isAbsolute(relative)) throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', { field: relative, reason: 'absolute path' });
      const lexical = path.resolve(root, relative);
      let candidate: string;
      try { candidate = realpathSync(lexical); }
      catch { throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', { source: relative,
        observed: 'missing', reprepare_required: true }); }
      const relation = path.relative(root, candidate);
      if (relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) {
        throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', { field: relative, reason: 'outside worktree' });
      }
      return candidate;
    };
    const noteFile = resolveInside(notes.path);
    if (sha256(readFileSync(noteFile)) !== notes.sha256) {
      throw new HarnessError('IMPLEMENTATION_NOTES_CONFLICT', { source: notes.path, expected: notes.sha256,
        observed: sha256(readFileSync(noteFile)), reprepare_required: true });
    }
    for (const required of policy.preflight.required_paths) {
      resolveInside(required);
    }
    const requiredExecutables = policy.preflight.required_executables.map(executable => {
      if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
        throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', {
          source: executable, observed: 'invalid-host-executable-name', reprepare_required: true,
        });
      }
      const extensions = process.platform === 'win32' && path.extname(executable) === ''
        ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
      let resolved: string | null = null;
      for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!entry || !path.isAbsolute(entry)) continue;
        for (const extension of extensions) {
          const candidate = path.join(entry, executable + extension.toLowerCase());
          try {
            if (!statSync(candidate).isFile()) continue;
            if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
            const canonical = realpathSync(candidate);
            if (isInside(lexicalRoot, path.resolve(candidate)) || isInside(root, canonical)) continue;
            resolved = canonical;
            break;
          } catch { /* Continue to the next trusted host PATH candidate. */ }
        }
        if (resolved) break;
      }
      if (!resolved) throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', {
        source: executable, observed: 'trusted-host-executable-not-found', reprepare_required: true,
      });
      return implementationExecutableIdentitySchema.parse({
        schema_version: 1, name: executable, canonical_path: resolved, sha256: sha256(readFileSync(resolved)),
        source: 'host-path', refresh: 'preflight-and-dispatch-guard',
      });
    });
    const dependencies = targetDependencyPackages(policy).map(directory => {
      const fact = inspectDependency(root, directory);
      if (fact.state !== 'ready') throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', {
        source: directory, observed: fact.reason, reprepare_required: true });
      return { package_directory: directory, manifest_sha256: fact.manifest_sha256,
        lock_sha256: fact.lock_sha256, modules_mtime_ms: fact.modules_mtime_ms,
        node_path: fact.node.path, node_version: fact.node.version };
    });
    const host = inspectHostCapabilities(root);
    const capabilities = { path_digest: host.path_digest, rg_state: host.rg.state,
      rg_path: host.rg.state === 'available' ? host.rg.canonical_path : null,
      rg_version: host.rg.state === 'available' ? host.rg.version : null, fallbacks: host.fallbacks };
    return { required_paths: [...policy.preflight.required_paths], required_executables: requiredExecutables,
      ...(dependencies.length ? { dependencies } : {}), capabilities };
  }
}

const contract = implementationLaunchContractSchema.parse({ schema_version: 1, kind: 'ticket-implementation',
  review_policy: 'delegated', destination: 'main', session: 'fresh' });

function same(left: unknown, right: unknown) { return stable(left) === stable(right); }

export class ImplementationLauncher {
  private readonly manager: any;
  private readonly harness: any;
  private readonly authority: ImplementationLaunchAuthoritySource | null;
  private readonly environment: EnvironmentSource;
  constructor({ manager, harness, authority, environment = new HostImplementationEnvironmentSource() }:
    { manager: any; harness: any; authority: ImplementationLaunchAuthoritySource | null; environment?: EnvironmentSource }) {
    this.manager = manager; this.harness = harness; this.authority = authority; this.environment = environment;
  }

  private callerFingerprint(input: z.infer<typeof startTicketImplementationInputSchema>) {
    return sha256(stable({ schema_version: input.schema_version, ticket_id: input.ticket_id,
      authorization_ref: input.authorization_ref, expected: input.expected, current_delta: input.current_delta }));
  }

  private current(input: z.infer<typeof startTicketImplementationInputSchema>, frozen?: any) {
    const ticket = this.harness.tickets.get(input.ticket_id);
    if (!ticket) throw new HarnessError('TICKET_NOT_FOUND');
    const project = this.harness.projects.get(ticket.project_id);
    if (!this.authority) throw new HarnessError('IMPLEMENTATION_AUTHORITY_UNAVAILABLE', {
      source: 'service configuration', reprepare_required: true,
    });
    const authority = this.authority.snapshot(ticket.key, input.authorization_ref);
    const policy = authority.policy;
    const expectedPolicy = frozen?.authority
      ? { policy_id: frozen.authority.policy.policy_id, revision: frozen.authority.policy.revision,
        digest: frozen.authority.policy.digest } : input.expected.policy;
    if (!same({ policy_id: policy.policy_id, revision: policy.revision, digest: policy.digest }, expectedPolicy)) {
      throw new HarnessError('IMPLEMENTATION_POLICY_CONFLICT', { expected: expectedPolicy,
        observed: { policy_id: policy.policy_id, revision: policy.revision, digest: policy.digest }, reprepare_required: true });
    }
    if (!project || policy.project_key !== project.key || policy.action !== 'ticket-implementation'
      || policy.workflow_phase !== 'implementation' || !policy.supported_contract_versions.includes(contract.schema_version)
      || policy.permission_selection !== 'owner-native-default') {
      throw new HarnessError('IMPLEMENTATION_POLICY_NOT_APPLICABLE', { policy_id: policy.policy_id, ticket_id: input.ticket_id });
    }
    const authorization = authority.authorization;
    if (!authorization || frozen?.authority?.authorization && !same(authorization, frozen.authority.authorization)) {
      throw new HarnessError('IMPLEMENTATION_NOT_AUTHORIZED', { ticket_id: input.ticket_id,
        authorization_ref: input.authorization_ref, reprepare_required: true });
    }
    if (frozen?.authority && !same(authority, frozen.authority)) {
      throw new HarnessError('IMPLEMENTATION_AUTHORITY_CONFLICT', {
        expected: frozen.authority.source, observed: authority.source, reprepare_required: true,
      });
    }
    if (!same(input.expected.notes, authorization.notes)) throw new HarnessError('IMPLEMENTATION_NOTES_CONFLICT', {
      expected: input.expected.notes, observed: authorization.notes, reprepare_required: true,
    });
    const workflow = this.harness.workflowHistory.current.get(input.ticket_id);
    if (!workflow || workflow.workflow_revision !== input.expected.workflow_revision
      || workflow.snapshot?.phase !== 'implementation'
      || workflow.snapshot?.subject?.subject_id !== input.expected.subject_ref) {
      throw new HarnessError('IMPLEMENTATION_WORKFLOW_CONFLICT', { expected: {
        revision: input.expected.workflow_revision, phase: 'implementation', subject_ref: input.expected.subject_ref,
      }, observed: workflow ? { revision: workflow.workflow_revision, phase: workflow.snapshot?.phase,
        subject_ref: workflow.snapshot?.subject?.subject_id } : null, reprepare_required: true });
    }
    if (!ticket.comparison_baseline || !ticket.expected_worktree) {
      throw new HarnessError('IMPLEMENTATION_GIT_IDENTITY_INCOMPLETE', { ticket_id: input.ticket_id, reprepare_required: true });
    }
    if (authority.source.canonical_path) {
      let targetRoot: string;
      try { targetRoot = realpathSync(ticket.expected_worktree); }
      catch { throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', {
        source: ticket.expected_worktree, observed: 'worktree-unavailable', reprepare_required: true,
      }); }
      if (isInside(targetRoot, authority.source.canonical_path)) {
        throw new HarnessError('IMPLEMENTATION_AUTHORITY_UNTRUSTED', {
          source: authority.source.reference, canonical_source: authority.source.canonical_path,
          forbidden_root: targetRoot, reprepare_required: true,
        });
      }
    }
    const currentIdentity = this.harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    const observedIdentity = executionContentIdentitySchema.parse({ scheme: currentIdentity.scheme,
      version: currentIdentity.version, scope: currentIdentity.scope, completeness: currentIdentity.completeness,
      digest: currentIdentity.digest });
    if (!same(observedIdentity, input.expected.content_identity) || observedIdentity.completeness !== 'complete') {
      throw new HarnessError('SUBJECT_IDENTITY_CONFLICT', { expected: input.expected.content_identity,
        observed: observedIdentity, reprepare_required: true });
    }
    const environment = this.environment.observe(ticket.expected_worktree, policy, authorization.notes);
    if (frozen?.environment && !same(environment, frozen.environment)) {
      throw new HarnessError('IMPLEMENTATION_ENVIRONMENT_CONFLICT', {
        expected: frozen.environment, observed: environment, reprepare_required: true,
      });
    }
    const rawReferences = [ticket.reference, authorization.notes.path,
      ...(workflow.snapshot?.artifacts ?? []).map((value: any) => value.location)]
      .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0);
    return { ticket, policy, authorization, authority, workflow, observedIdentity, environment,
      references: [...new Set(rawReferences)], duplicateReferences: rawReferences.length - new Set(rawReferences).size };
  }

  private prompt(snapshot: ReturnType<ImplementationLauncher['current']>, input: z.infer<typeof startTicketImplementationInputSchema>) {
    return [
      '执行 Ticket implementation。仅从以下持久化引用恢复上下文：',
      ...snapshot.references.map(value => `- ${value}`),
      `- fixed_point: ${snapshot.ticket.comparison_baseline.commit_oid}`,
      `环境事实：${JSON.stringify(snapshot.environment.capabilities ?? null)}`,
      `依赖事实：${JSON.stringify(snapshot.environment.dependencies ?? [])}`,
      '当前 delta：', ...input.current_delta.map(value => `- ${value.ref}: ${value.value ?? 'null'}`),
      '结构化 workflow contract：review_policy=delegated；destination=Ticket Main；session=fresh。',
      '完成实现、最小定向测试、commit 与 Implementation Handoff 后停止；不要执行 Review。',
    ].join('\n');
  }

  async start(raw: unknown) {
    const parsed = startTicketImplementationInputSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessError('INVALID_IMPLEMENTATION_LAUNCH_REQUEST', { issues: parsed.error.issues });
    const input = parsed.data;
    const callerFingerprint = this.callerFingerprint(input);
    const existing = this.harness.executionOperations.findByRequest(input.ticket_id, input.request_id);
    if (existing) {
      if (existing.fingerprint_version !== 'execution-protected-v2'
        || existing.caller_fingerprint !== callerFingerprint) {
        throw new HarnessError('REQUEST_CONFLICT', { operation_id: existing.operation_id });
      }
      return { ...this.harness.executionOperations.reconcile(existing.operation_id), deduplicated: true };
    }

    this.harness.executionGate('new-side-effect');
    const snapshot = this.current(input);
    const prompt = this.prompt(snapshot, input);
    const protection = {
      caller_fingerprint: callerFingerprint, contract, policy: snapshot.policy, authorization: snapshot.authorization,
      authority_source: snapshot.authority.source,
      prompt_context: { references: snapshot.references, current_delta: input.current_delta,
        cost: { prompt_utf8_bytes: Buffer.byteLength(prompt, 'utf8'), reference_count: snapshot.references.length,
          duplicate_reference_count: snapshot.duplicateReferences } },
      preflight: { workflow_revision: snapshot.workflow.workflow_revision, subject_ref: input.expected.subject_ref,
        notes: snapshot.authorization.notes, environment: snapshot.environment },
    };
    const reserved = this.harness.executionOperations.reserve({
      ticket_id: input.ticket_id, request_id: input.request_id, destination: { kind: 'main' },
      expected_workflow_revision: input.expected.workflow_revision, subject_ref: input.expected.subject_ref,
      content_identity: input.expected.content_identity,
      launch: { cwd: snapshot.ticket.expected_worktree, prompt, sender: 'Emilia', model: snapshot.policy.model,
        reasoning: snapshot.policy.reasoning, timeout_ms: null, permissions: null },
      authorization_boundary: { schema_version: 1, policy_id: snapshot.policy.policy_id,
        decision_ref: snapshot.authorization.authorization_ref, concurrency: { mode: 'single-line', decision_ref: null } },
      implementation: protection,
    });
    try {
      await this.manager.startGuarded({ request_id: reserved.runtime.request_id, cwd: snapshot.ticket.expected_worktree,
        prompt, sender: 'Emilia', model: snapshot.policy.model, reasoning: snapshot.policy.reasoning, timeout_ms: undefined },
      (dispatch: any) => {
        this.current(input, { authority: snapshot.authority, environment: snapshot.environment });
        if (dispatch?.config?.model !== snapshot.policy.model || dispatch?.config?.reasoning !== snapshot.policy.reasoning) {
          throw new HarnessError('IMPLEMENTATION_MODEL_POLICY_CONFLICT', { expected: {
            model: snapshot.policy.model, reasoning: snapshot.policy.reasoning,
          }, observed: dispatch?.config ?? null, reprepare_required: true });
        }
        this.harness.executionOperations.guardDispatch(reserved.operation_id, dispatch);
      });
    } catch (error) {
      const current = this.harness.executionOperations.query(reserved.operation_id);
      if (current.state === 'reserved') this.harness.executionOperations.failReserved(reserved.operation_id,
        (error as any)?.code ?? 'IMPLEMENTATION_LAUNCH_REJECTED', error instanceof Error ? error.message : 'launch rejected');
      else if (current.state === 'dispatching' || current.state === 'started') {
        this.harness.executionOperations.requireReconciliation(reserved.operation_id,
          (error as any)?.code ?? 'IMPLEMENTATION_LAUNCH_OUTCOME_UNKNOWN', error instanceof Error ? error.message : 'launch outcome unknown');
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
          ...(receipt.reconciliation ?? {}), recording_outcome: 'unknown', checked_restart_required: true,
        } };
      }
      throw error;
    }
  }
}
