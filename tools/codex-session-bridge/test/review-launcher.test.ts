import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Harness } from '../src/harness/harness.ts';
import { createHttpServer } from '../src/http.js';
import { FileReviewLaunchAuthoritySource, ReviewLauncher, digestReviewPolicy, reviewContractDigest
} from '../src/orchestration/review-launcher.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-launcher-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, 'subject.txt'), 'base\n', 'utf8');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  const sessions = new Map<string, any>(), runs = new Map<string, any>(), requests = new Map<string, any>();
  const source = {
    session: (id: string) => sessions.get(id),
    runs: (sessionId: string) => [...runs.values()].filter(value => value.session_id === sessionId),
    events: (run: any) => [{ seq: 1, at: run.created_at, session_id: run.session_id, run_id: run.id,
      type: 'codex', data: { type: 'thread.started', thread_id: sessions.get(run.session_id)?.codex_thread_id } }],
    attribution: () => ({ state: 'unknown' }), lookupRequest: (id: string) => requests.get(id) ?? null,
    activeRuns: () => [...runs.values()].filter(value => ['queued', 'starting', 'running'].includes(value.status)),
  };
  const runtime = path.join(root, 'runtime');
  let harness = new Harness(runtime, source);
  const registration = harness.register({ project_key: 'YCA', project_name: 'Yuki Computer Agent',
    ticket_key: 'ORCH-003', title: 'Fresh Review', reference: 'https://github.invalid/issues/93',
    expected_worktree: repo, fixed_point: head });
  const ticketId = registration.ticket_id;
  const reviewId = 'review-93';
  const subjectRef = 'subject-review';
  const subjectIdentity = 'c'.repeat(64);
  const identity = () => {
    const value = harness.changes.facts.currentIdentity(harness.tickets.get(ticketId)!.comparison_baseline!);
    return { scheme: value.scheme, version: value.version, scope: value.scope,
      completeness: value.completeness, digest: value.digest };
  };
  const authorizedIdentity = identity();
  const setWorkflow = () => harness.workflowHistory.current.set(ticketId, {
    ticket_id: ticketId, conversation_id: registration.conversation_id, workflow_revision: 2,
    snapshot: { phase: 'review', checkpoint: { worktree: repo, ticket_key: 'ORCH-003', head,
      branch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') },
      subject: { subject_id: subjectRef, head, ticket_ref: 'https://github.invalid/issues/93',
        staged: [], unstaged: [], untracked: [] }, artifacts: [], runtime_refs: [],
      reviews: [{ review_id: reviewId, mode: 'full', status: 'pending', subject_ref: subjectRef,
        subject_identity: subjectIdentity }] },
    assessment: { state: 'unknown', checked_at: new Date().toISOString(), reasons: [], artifacts: [], runtime: [] },
  } as any);
  setWorkflow();
  let policyBody: any = { schema_version: 1, policy_id: 'review-policy', revision: 4,
    project_key: 'YCA', action: 'ticket-review', workflow_phase: 'review', supported_contract_versions: [1],
    model: 'gpt-5.6-sol', reasoning: 'medium', permission_selection: 'owner-native-default',
    preflight: { require_recording: true, model_line: 'single' }, authority_refs: ['service-config:test'] };
  let available = true;
  const authority = { snapshot(ticketKey: string, id: string, ref: string) {
    if (!available) throw Object.assign(new Error('authority unavailable'), { code: 'REVIEW_AUTHORITY_UNAVAILABLE' });
    const policy = { ...policyBody, digest: digestReviewPolicy(policyBody) };
    const authorization = ticketKey === 'ORCH-003' && id === reviewId && ref === 'owner:#93' ? {
      schema_version: 1 as const, authorization_id: 'authorization-93', ticket_key: ticketKey, review_id: id,
      action: 'ticket-review' as const, endpoint: 'review' as const, contract_version: 1 as const,
      contract_digest: reviewContractDigest, authorization_ref: ref, subject_ref: subjectRef,
      subject_identity: subjectIdentity, content_identity: authorizedIdentity, authority_refs: ['github:#93'],
    } : null;
    return { policy, authorization, source: { schema_version: 1 as const, kind: 'adapter' as const,
      reference: 'fixture-authority', canonical_path: null,
      sha256: createHash('sha256').update(JSON.stringify({ policy, authorization })).digest('hex') } };
  } };
  let starts = 0;
  let beforeGuard: (() => void) | null = null;
  let afterDispatch: (() => void) | null = null;
  const manager: any = { get harness() { return harness; }, reviewLaunchAuthority: authority,
    async startGuarded(input: any, guard: (dispatch: any) => unknown) {
      starts++;
      assert.equal(input.permissions, undefined);
      assert.equal(harness.executionOperations.findByRequest(ticketId, 'request-1')?.state, 'reserved',
        'Review child must be durable before manager start');
      beforeGuard?.(); beforeGuard = null;
      const fingerprint = 'b'.repeat(64);
      guard({ request_id: input.request_id, fingerprint, cwd: input.cwd,
        config: { model: input.model, reasoning: input.reasoning },
        permissions: { sandbox_mode: 'danger-full-access', approval_policy: 'on-request' },
        launch: { prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
          prompt_utf8_bytes: Buffer.byteLength(input.prompt), sender: input.sender ?? null,
          model: input.model ?? null, reasoning: input.reasoning ?? null, timeout_ms: null,
          permission_selection: null } });
      const sessionId = randomUUID(), runId = randomUUID(), threadId = randomUUID();
      sessions.set(sessionId, { id: sessionId, cwd: input.cwd, codex_thread_id: threadId, permissions: {} });
      runs.set(runId, { id: runId, session_id: sessionId, created_at: new Date().toISOString(),
        model: input.model, reasoning: input.reasoning, status: 'running', config_source: 'fixture',
        timeout_ms: null, exit_code: null });
      requests.set(input.request_id, { request_id: input.request_id, fingerprint,
        session_id: sessionId, run_id: runId, status: 'running' });
      afterDispatch?.(); afterDispatch = null;
      return { session_id: sessionId, run_id: runId };
    } };
  const launcher = () => new ReviewLauncher({ manager, harness, authority });
  const input = (overrides: Record<string, unknown> = {}) => ({ schema_version: 1, ticket_id: ticketId,
    request_id: 'request-1', review_id: reviewId, authorization_ref: 'owner:#93',
    expected: { workflow_revision: 2, subject_ref: subjectRef, subject_identity: subjectIdentity,
      content_identity: authorizedIdentity, policy: { policy_id: policyBody.policy_id,
        revision: policyBody.revision, digest: digestReviewPolicy(policyBody) } },
    references: ['docs/implementation-notes/ORCH-003.md'], current_delta: [{ ref: 'head', value: head }],
    ...overrides });
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  return { launcher, input, manager, registration, source, sessions, runs, requests, root, repo, runtime,
    get harness() { return harness; }, get starts() { return starts; },
    setAvailable(value: boolean) { available = value; },
    beforeGuard(value: () => void) { beforeGuard = value; },
    afterDispatch(value: () => void) { afterDispatch = value; },
    changePolicy() { policyBody = { ...policyBody, revision: policyBody.revision + 1 }; },
    setWorkflow,
    restart() { harness.close(); harness = new Harness(runtime, source); setWorkflow(); } };
}

test('public Review launch reserves child first, creates fresh session, binds child and exposes isolation', async t => {
  const f = fixture(t);
  const server = createHttpServer(f.manager, undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'review-launcher-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  t.after(async () => { await client.close(); await new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  }); });
  const first = await client.callTool({ name: 'start_ticket_review', arguments: f.input() });
  assert.equal(first.isError, undefined);
  const receipt = first.structuredContent as any;
  assert.equal(receipt.state, 'bound');
  assert.equal(receipt.destination.kind, 'child');
  assert.deepEqual(receipt.destination.relation, { kind: 'review', review_id: 'review-93', participant: 'coordinator' });
  assert.notEqual(receipt.destination.conversation_id, f.registration.conversation_id);
  assert.equal(receipt.destination.parent_conversation_id, f.registration.conversation_id);
  assert.equal(receipt.destination.isolation.state, 'verified');
  assert.equal(receipt.actual_permissions.sandbox_mode, 'danger-full-access');
  const children = f.harness.conversations.summary(f.registration.ticket_id);
  assert.equal(children.length, 1);
  assert.equal(children[0].bindings.length, 1);
  assert.equal(children[0].isolation.state, 'verified');
  assert.equal(f.harness.bindings.get(receipt.binding_id)?.conversation_id, receipt.destination.conversation_id);
  assert.equal([...f.harness.bindings.values()].filter(value => value.conversation_id === f.registration.conversation_id).length, 0);
  f.setAvailable(false);
  (f.harness.journal as any).failure = 'fixture recording failure';
  const retry = await client.callTool({ name: 'start_ticket_review', arguments: f.input() });
  assert.equal(retry.isError, undefined);
  assert.equal((retry.structuredContent as any).operation_id, receipt.operation_id);
  assert.equal(f.starts, 1);
  const conflict = await client.callTool({ name: 'start_ticket_review', arguments: f.input({ references: ['changed'] }) });
  assert.equal((conflict.structuredContent as any).error.code, 'REQUEST_CONFLICT');
});

test('Review isolation refreshes after a late thread and remains queryable after restart', async t => {
  const f = fixture(t);
  const events = f.source.events;
  f.source.events = (run: any) => f.sessions.get(run.session_id)?.codex_thread_id ? events(run) : [];
  f.afterDispatch(() => {
    const session = [...f.sessions.values()][0];
    session.codex_thread_id = null;
  });
  const receipt = await f.launcher().start(f.input());
  assert.equal(receipt.destination.isolation.state, 'unknown');
  const childId = receipt.destination.conversation_id;
  const initial = f.harness.conversationDetail(childId);
  assert.equal(initial.isolation.state, 'unknown');
  assert.equal(initial.bindings[0].isolation.state, 'unknown');
  const session = [...f.sessions.values()][0];
  session.codex_thread_id = randomUUID();
  f.restart();
  const refreshed = f.harness.conversationDetail(childId);
  assert.equal(refreshed.isolation.state, 'verified');
  assert.equal(refreshed.bindings[0].isolation.state, 'verified');
  assert.equal(refreshed.bindings[0].isolation_provenance.kind, 'child_isolation_assessed');
  assert.notEqual(refreshed.bindings[0].isolation_provenance.event_id, null);
  assert.equal(f.harness.executionOperations.findByRequest(f.registration.ticket_id, 'request-1')
    ?.destination.isolation.state, 'unknown', 'the bind-time receipt remains durable history');
  const assessmentCount = f.harness.journal.records.filter(record => record.data.kind === 'child_isolation_assessed').length;
  f.restart();
  assert.equal(f.harness.conversationDetail(childId).isolation.state, 'verified');
  assert.equal(f.harness.journal.records.filter(record => record.data.kind === 'child_isolation_assessed').length,
    assessmentCount);
});

test('new Review rejects recording, Workflow, Git and authority drift before model side effects', async t => {
  const f = fixture(t);
  const reject = async (input: any, code: string) => assert.rejects(f.launcher().start(input),
    (error: any) => error.code === code);
  (f.harness.journal as any).failure = 'recording failed';
  await reject(f.input(), 'RECORDING_FAILED');
  (f.harness.journal as any).failure = null;
  await reject(f.input({ expected: { ...f.input().expected as object, workflow_revision: 3 } }), 'REVIEW_WORKFLOW_CONFLICT');
  await reject(f.input({ authorization_ref: 'unapproved' }), 'REVIEW_NOT_AUTHORIZED');
  writeFileSync(path.join(f.repo, 'subject.txt'), 'changed\n', 'utf8');
  await reject(f.input(), 'SUBJECT_IDENTITY_CONFLICT');
  assert.equal(f.starts, 0);
});

test('post-await policy drift fails before runtime creation and preserves the reserved operation', async t => {
  const f = fixture(t);
  f.beforeGuard(() => f.changePolicy());
  await assert.rejects(f.launcher().start(f.input()), (error: any) => error.code === 'REVIEW_POLICY_CONFLICT');
  assert.equal(f.requests.size, 0);
  assert.equal(f.harness.executionOperations.findByRequest(f.registration.ticket_id, 'request-1')?.state, 'failed');
});

test('unknown start and lost bind receipt reconcile the same operation after restart without another reviewer', async t => {
  const f = fixture(t);
  f.afterDispatch(() => { throw new Error('manager reply lost'); });
  await assert.rejects(f.launcher().start(f.input()), /manager reply lost/);
  assert.equal(f.requests.size, 1);
  f.restart();
  const reconciled = await f.launcher().start(f.input());
  assert.equal(reconciled.effective_state, 'reconciliation-required');
  assert.equal(reconciled.reconciliation.lookup, 'matched');
  assert.equal(f.starts, 1);
  assert.equal(f.harness.conversations.summary(f.registration.ticket_id).length, 1);

  // A second fixture covers complete Journal append followed by a lost bind receipt.
  const b = fixture(t);
  const original = b.harness.journal.append.bind(b.harness.journal);
  b.harness.journal.append = ((data: any) => {
    const record = original(data);
    if (data.kind === 'execution_operation_bound') throw new Error('bind receipt lost');
    return record;
  }) as any;
  const unknown = await b.launcher().start(b.input());
  assert.equal(unknown.effective_state, 'reconciliation-required');
  b.restart();
  const recovered = await b.launcher().start(b.input());
  assert.equal(recovered.state, 'bound');
  assert.equal(recovered.destination.kind, 'child');
  assert.equal(b.starts, 1);
  assert.equal(b.harness.conversations.summary(b.registration.ticket_id).length, 1);
});

test('lost reserve and started Journal receipts recover read-only through the public Review API', async t => {
  const reserve = fixture(t);
  const originalReserveAppend = reserve.harness.journal.append.bind(reserve.harness.journal);
  reserve.harness.journal.append = ((data: any) => {
    const record = originalReserveAppend(data);
    if (data.kind === 'execution_operation_reserved') throw new Error('reserve receipt lost');
    return record;
  }) as any;
  await assert.rejects(reserve.launcher().start(reserve.input()),
    (error: any) => error.code === 'RECORDING_OUTCOME_UNKNOWN');
  assert.equal(reserve.starts, 0);
  reserve.restart();
  const reserved = await reserve.launcher().start(reserve.input());
  assert.equal(reserved.state, 'reserved');
  assert.equal(reserve.starts, 0);
  assert.equal(reserve.harness.conversations.summary(reserve.registration.ticket_id).length, 1);

  const started = fixture(t);
  const originalStartedAppend = started.harness.journal.append.bind(started.harness.journal);
  started.harness.journal.append = ((data: any) => {
    const record = originalStartedAppend(data);
    if (data.kind === 'execution_operation_transitioned' && data.operation.state === 'started') {
      throw new Error('started receipt lost');
    }
    return record;
  }) as any;
  const unknown = await started.launcher().start(started.input());
  assert.equal(unknown.effective_state, 'reconciliation-required');
  started.restart();
  const recovered = await started.launcher().start(started.input());
  assert.equal(recovered.state, 'started');
  assert.equal(recovered.runtime.session_id !== null, true);
  assert.equal(started.starts, 1);
  assert.equal(started.harness.conversations.summary(started.registration.ticket_id).length, 1);
});

test('Review authority file is versioned and cannot be activated from a worktree', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-authority-'));
  const trusted = path.join(root, 'trusted'), worktree = path.join(root, 'worktree');
  mkdirSync(trusted); mkdirSync(worktree);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = { schema_version: 1, policy_id: 'review-policy', revision: 1, project_key: 'YCA',
    action: 'ticket-review', workflow_phase: 'review', supported_contract_versions: [1],
    model: 'gpt-5.6-sol', reasoning: 'medium', permission_selection: 'owner-native-default',
    preflight: { require_recording: true, model_line: 'single' }, authority_refs: ['service-config:test'] };
  const authorization = { schema_version: 1, authorization_id: 'authorization-93', ticket_key: 'ORCH-003',
    review_id: 'review-93', action: 'ticket-review', endpoint: 'review', contract_version: 1,
    contract_digest: reviewContractDigest, authorization_ref: 'owner:#93', subject_ref: 'subject-review',
    subject_identity: 'c'.repeat(64), content_identity: { scheme: 'yuki-git-subject', version: 1,
      scope: {}, completeness: 'complete', digest: 'sha256:' + 'd'.repeat(64) }, authority_refs: ['github:#93'] };
  const document = { schema_version: 1, active_policy: policy, authorizations: [authorization] };
  const file = path.join(trusted, 'authority.json');
  writeFileSync(file, JSON.stringify(document), 'utf8');
  const source = new FileReviewLaunchAuthoritySource(file, { forbiddenRoots: [worktree] });
  const first = source.snapshot('ORCH-003', 'review-93', 'owner:#93');
  assert.equal(first.policy.digest, digestReviewPolicy(policy));
  assert.equal(first.authorization?.contract_digest, reviewContractDigest);
  assert.equal(source.snapshot('ORCH-003', 'different-review', 'owner:#93').authorization, null);
  writeFileSync(file, JSON.stringify({ ...document, active_policy: { ...policy, revision: 2 } }), 'utf8');
  assert.equal(source.snapshot('ORCH-003', 'review-93', 'owner:#93').policy.revision, 2);
  const controlled = path.join(worktree, 'authority.json');
  writeFileSync(controlled, JSON.stringify(document), 'utf8');
  assert.throws(() => new FileReviewLaunchAuthoritySource(controlled, { forbiddenRoots: [worktree] }),
    (error: any) => error.code === 'REVIEW_AUTHORITY_UNTRUSTED');
});
