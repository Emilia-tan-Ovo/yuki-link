import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Harness } from '../src/harness/harness.ts';
import { createHttpServer } from '../src/http.js';
import { FileImplementationLaunchAuthoritySource, ImplementationLauncher,
  digestImplementationPolicy } from '../src/orchestration/implementation-launcher.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'implementation-launcher-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture');
  mkdirSync(path.join(repo, 'docs')); writeFileSync(path.join(repo, 'subject.txt'), 'base\n', 'utf8');
  const notes = 'confirmed implementation notes\n'; writeFileSync(path.join(repo, 'docs', 'notes.md'), notes, 'utf8');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const fixedPoint = git(repo, 'rev-parse', 'HEAD');
  const sessions = new Map<string, any>(), runs = new Map<string, any>(), requests = new Map<string, any>();
  const source = {
    session: (id: string) => sessions.get(id),
    runs: (sessionId: string) => [...runs.values()].filter(value => value.session_id === sessionId),
    events: () => [], attribution: () => ({ state: 'unknown' }),
    lookupRequest: (id: string) => requests.get(id) ?? null,
    activeRuns: () => [...runs.values()].filter(value => ['queued', 'starting', 'running', 'stopping'].includes(value.status)),
  };
  const runtime = path.join(root, 'runtime');
  const harness = new Harness(runtime, source);
  const registration = harness.register({ project_key: 'YCA', project_name: 'Yuki Computer Agent', ticket_key: 'ORCH-004',
    title: 'Delegated implementation launcher', reference: 'https://github.invalid/issues/94', expected_worktree: repo, fixed_point: fixedPoint });
  const identity = harness.changes.facts.currentIdentity(harness.tickets.get(registration.ticket_id)!.comparison_baseline!);
  harness.workflowHistory.current.set(registration.ticket_id, { ticket_id: registration.ticket_id,
    conversation_id: registration.conversation_id, workflow_revision: 2, previous_revision: 1,
    request_id: 'workflow-2', fingerprint: 'a'.repeat(64), snapshot: {
      phase: 'implementation', subject: { subject_id: 'subject-implementation', fixed_point: fixedPoint, head: fixedPoint },
      checkpoint: { worktree: repo }, artifacts: [
        { role: 'ticket', location: 'https://github.invalid/issues/94', revision: null },
        { role: 'implementation-notes', location: 'docs/notes.md', revision: null },
        { role: 'checkpoint', location: '.local/workflow-state/ORCH-004.md', revision: null },
      ],
    }, assessment: {} } as any);

  let policyBody: any = {
    schema_version: 1, policy_id: 'implementation-policy', revision: 7, project_key: 'YCA',
    action: 'ticket-implementation', workflow_phase: 'implementation', supported_contract_versions: [1],
    model: 'gpt-5.6-sol', reasoning: 'medium', permission_selection: 'owner-native-default',
    preflight: { required_paths: [], required_executables: [], require_recording: true, model_line: 'single' },
    authority_refs: ['service-config:test'],
  };
  // Launcher identities use SHA-256 bytes, not Git object IDs.
  const notesSha256 = createHash('sha256').update(notes).digest('hex');
  let available = true;
  const authority = {
    policy() {
      if (!available) throw Object.assign(new Error('authority unavailable'), { code: 'IMPLEMENTATION_AUTHORITY_UNAVAILABLE' });
      return { ...structuredClone(policyBody), digest: digestImplementationPolicy(policyBody) };
    },
    authorization(ticketKey: string, ref: string) {
      if (!available) throw Object.assign(new Error('authority unavailable'), { code: 'IMPLEMENTATION_AUTHORITY_UNAVAILABLE' });
      if (ticketKey !== 'ORCH-004' || ref !== 'owner:#94') return null;
      return { schema_version: 1, authorization_id: 'authorization-94', ticket_key: 'ORCH-004',
        action: 'ticket-implementation', endpoint: 'implementation', contract_version: 1,
        authorization_ref: ref, notes: { path: 'docs/notes.md', sha256: notesSha256 },
        authority_refs: ['github:#94'] };
    },
  };
  let starts = 0;
  let beforeGuard: (() => void) | null = null;
  const manager = {
    harness,
    async startGuarded(input: any, guard: (dispatch: any) => unknown) {
      starts++;
      assert.equal(input.permissions, undefined, 'native Owner permissions must be inherited');
      beforeGuard?.(); beforeGuard = null;
      const fingerprint = 'b'.repeat(64);
      guard({ request_id: input.request_id, fingerprint, cwd: input.cwd,
        config: { model: input.model, reasoning: input.reasoning },
        permissions: { version: 1, kind: 'native', stored: true, sandbox_mode: 'danger-full-access',
          approval_policy: 'on-request', approvals_reviewer: 'user', workspace_write: null,
          source: 'fixture', resolved_at: new Date().toISOString() },
        launch: { prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
          prompt_utf8_bytes: Buffer.byteLength(input.prompt), sender: input.sender ?? null,
          model: input.model ?? null, reasoning: input.reasoning ?? null, timeout_ms: input.timeout_ms ?? null,
          permission_selection: null } });
      const sessionId = randomUUID(), runId = randomUUID();
      sessions.set(sessionId, { id: sessionId, cwd: input.cwd, codex_thread_id: null,
        permissions: { sandbox_mode: 'danger-full-access' } });
      runs.set(runId, { id: runId, session_id: sessionId, created_at: new Date().toISOString(),
        model: input.model, reasoning: input.reasoning, status: 'running', config_source: 'fixture', timeout_ms: null, exit_code: null });
      requests.set(input.request_id, { request_id: input.request_id, fingerprint, session_id: sessionId, run_id: runId, status: 'running' });
      return { session_id: sessionId, run_id: runId };
    },
  };
  const launcher = new ImplementationLauncher({ manager, harness, authority });
  (manager as any).implementationLaunchAuthority = authority;
  const input = (overrides: Record<string, unknown> = {}) => ({ schema_version: 1,
    ticket_id: registration.ticket_id, request_id: 'implementation-request-1', authorization_ref: 'owner:#94',
    expected: { workflow_revision: 2, subject_ref: 'subject-implementation',
      content_identity: { scheme: identity.scheme, version: identity.version, scope: identity.scope,
        completeness: identity.completeness, digest: identity.digest },
      policy: { policy_id: policyBody.policy_id, revision: policyBody.revision, digest: digestImplementationPolicy(policyBody) },
      notes: { path: 'docs/notes.md', sha256: notesSha256 } },
    current_delta: [{ ref: 'fixed_point', value: fixedPoint }], ...overrides,
  });
  t.after(() => { harness.workflowHistory.current.clear(); harness.close(); rmSync(root, { recursive: true, force: true }); });
  return { launcher, harness, authority, input, registration, manager, runtime, source, get starts() { return starts; },
    setAvailable(value: boolean) { available = value; }, changePolicy() { policyBody = { ...policyBody, revision: policyBody.revision + 1 }; },
    setBeforeGuard(value: () => void) { beforeGuard = value; } };
}

test('launches one fresh delegated implementation into Ticket Main and freezes actual permissions', async t => {
  const f = fixture(t);
  const result = await f.launcher.start(f.input());
  assert.equal(result.state, 'bound');
  assert.equal(result.contract.kind, 'ticket-implementation');
  assert.equal(result.contract.review_policy, 'delegated');
  assert.equal(result.contract.session, 'fresh');
  assert.equal(result.destination.kind, 'main');
  assert.equal(result.destination.conversation_id, f.registration.conversation_id);
  assert.equal(result.policy.revision, 7);
  assert.equal(result.actual_permissions.sandbox_mode, 'danger-full-access');
  assert.equal(f.starts, 1);
});

test('file authority source refreshes versioned policy and Ticket authorization from trusted config', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'implementation-authority-'));
  const file = path.join(root, 'authority.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = { schema_version: 1, policy_id: 'implementation-policy', revision: 1, project_key: 'YCA',
    action: 'ticket-implementation', workflow_phase: 'implementation', supported_contract_versions: [1],
    model: 'gpt-5.6-sol', reasoning: 'medium', permission_selection: 'owner-native-default',
    preflight: { required_paths: [], required_executables: [], require_recording: true, model_line: 'single' },
    authority_refs: ['service-config:test'] };
  const authorization = { schema_version: 1, authorization_id: 'authorization-94', ticket_key: 'ORCH-004',
    action: 'ticket-implementation', endpoint: 'implementation', contract_version: 1,
    authorization_ref: 'owner:#94', notes: { path: 'docs/notes.md', sha256: 'c'.repeat(64) },
    authority_refs: ['github:#94'] };
  writeFileSync(file, JSON.stringify({ schema_version: 1, active_policy: policy, authorizations: [authorization] }), 'utf8');
  const source = new FileImplementationLaunchAuthoritySource(file);
  assert.equal(source.policy().digest, digestImplementationPolicy(policy));
  assert.equal(source.authorization('ORCH-004', 'owner:#94')?.authorization_id, 'authorization-94');
  writeFileSync(file, JSON.stringify({ schema_version: 1, active_policy: { ...policy, revision: 2 },
    authorizations: [authorization] }), 'utf8');
  assert.equal(source.policy().revision, 2, 'new requests observe the currently activated immutable snapshot');
});

test('same request retries read-only before authority and recording preflight; changed payload conflicts', async t => {
  const f = fixture(t);
  const first = await f.launcher.start(f.input());
  f.setAvailable(false);
  (f.harness.journal as any).failure = 'fixture recording failure';
  const retry = await f.launcher.start(f.input());
  assert.equal(retry.operation_id, first.operation_id);
  assert.equal(retry.deduplicated, true);
  assert.equal(f.starts, 1);
  await assert.rejects(f.launcher.start(f.input({ current_delta: [{ ref: 'changed', value: 'different' }] })),
    (error: any) => error.code === 'REQUEST_CONFLICT');
});

test('caller expected policy is compare-only and stale expectations fail before reserve', async t => {
  const f = fixture(t);
  const stale = f.input();
  (stale as any).expected.policy.revision = 6;
  await assert.rejects(f.launcher.start(stale), (error: any) => error.code === 'IMPLEMENTATION_POLICY_CONFLICT');
  assert.equal(f.harness.executionOperations.observations(f.registration.ticket_id).length, 0);
  assert.equal(f.starts, 0);
});

test('post-await policy drift rejects dispatch without creating a runtime session', async t => {
  const f = fixture(t);
  f.setBeforeGuard(() => f.changePolicy());
  await assert.rejects(f.launcher.start(f.input()), (error: any) => error.code === 'IMPLEMENTATION_POLICY_CONFLICT');
  assert.equal(f.starts, 1);
  const operation = f.harness.executionOperations.observations(f.registration.ticket_id)[0];
  assert.equal(operation.state, 'failed');
  assert.equal(operation.runtime.session_id, null);
});

test('unknown Main binding receipt requires reconciliation and the v2 journal recovers after restart', async t => {
  const f = fixture(t);
  const append = f.harness.journal.append.bind(f.harness.journal);
  f.harness.journal.append = ((data: any) => {
    const record = append(data);
    if (data.kind === 'execution_operation_bound') throw new Error('binding receipt lost');
    return record;
  }) as any;
  const result = await f.launcher.start(f.input());
  assert.equal(result.state, 'started');
  assert.equal(result.effective_state, 'reconciliation-required');
  assert.equal(result.reconciliation.checked_restart_required, true);
  f.harness.workflowHistory.current.clear();
  f.harness.close();
  const restored = new Harness(f.runtime, f.source);
  const recovered = restored.executionOperations.findByRequest(f.registration.ticket_id, 'implementation-request-1')!;
  assert.equal(recovered.state, 'bound');
  assert.equal(recovered.fingerprint_version, 'execution-protected-v2');
  assert.equal(recovered.contract.review_policy, 'delegated');
  restored.close();
});

test('public MCP start_ticket_implementation exposes the protected high-level seam', async t => {
  const f = fixture(t);
  const server = createHttpServer(f.manager, undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'implementation-launcher-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  t.after(async () => {
    await client.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  const result = await client.callTool({ name: 'start_ticket_implementation', arguments: f.input({
    request_id: 'public-implementation-request',
  }) });
  assert.equal(result.isError, undefined);
  const receipt = result.structuredContent as any;
  assert.equal(receipt.state, 'bound');
  assert.equal(receipt.contract.review_policy, 'delegated');
  assert.equal(receipt.destination.conversation_id, f.registration.conversation_id);
  assert.equal(f.starts, 1);
  (f.harness.journal as any).failure = 'fixture recording failure';
  const retry = await client.callTool({ name: 'start_ticket_implementation', arguments: f.input({
    request_id: 'public-implementation-request',
  }) });
  assert.equal(retry.isError, undefined, 'outer MCP gate must allow accepted-request reconciliation');
  assert.equal((retry.structuredContent as any).operation_id, receipt.operation_id);
  assert.equal((retry.structuredContent as any).evidence_gap.state, 'recording-failed');
  assert.equal(f.starts, 1);
  const rejected = await client.callTool({ name: 'start_ticket_implementation', arguments: f.input({
    request_id: 'new-request-during-recording-failure',
  }) });
  assert.equal(rejected.isError, true);
  assert.equal((rejected.structuredContent as any).error.code, 'RECORDING_FAILED');
  assert.equal(f.starts, 1);
});
