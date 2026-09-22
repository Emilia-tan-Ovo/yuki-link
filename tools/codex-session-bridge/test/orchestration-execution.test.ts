import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness/harness.ts';
import { RuntimeStore } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { HarnessContextFactsSource } from '../src/orchestration/harness-context-source.ts';
import { ContextAssembler } from '../src/orchestration/context-assembler.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(t: test.TestContext, options: { authorizeParallel?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orchestration-execution-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, 'subject.txt'), 'base\n', 'utf8');
  git(repo, 'add', 'subject.txt'); git(repo, 'commit', '-m', 'base');
  const fixedPoint = git(repo, 'rev-parse', 'HEAD');
  const sessions = new Map<string, any>(), runs = new Map<string, any>(), requests = new Map<string, any>();
  const source = {
    session: (id: string) => { const value = sessions.get(id); if (!value) throw Error('missing'); return value; },
    runs: (sessionId: string) => [...runs.values()].filter(value => value.session_id === sessionId),
    events: () => [], attribution: () => ({ state: 'unknown' }),
    lookupRequest: (id: string) => requests.get(id) ?? null,
    activeRuns: () => [...runs.values()].filter(value => ['queued', 'starting', 'running', 'stopping'].includes(value.status)),
  };
  const runtime = path.join(root, 'runtime');
  const harness = new Harness(runtime, source, undefined, {}, {}, { authorizationValidator: (_current, input) =>
    Boolean(options.authorizeParallel && input.authorization_boundary.concurrency.mode === 'parallel'
      && input.authorization_boundary.concurrency.decision_ref) });
  const registration = harness.register({ project_key: 'YCA', project_name: 'Yuki Computer Agent', ticket_key: 'ORCH-002',
    title: 'Durable execution', reference: 'https://github.invalid/issues/91', expected_worktree: repo, fixed_point: fixedPoint });
  const identity = harness.changes.facts.currentIdentity(harness.tickets.get(registration.ticket_id)!.comparison_baseline!);
  const input = (overrides: Record<string, unknown> = {}) => ({
    ticket_id: registration.ticket_id,
    request_id: 'owner-request-1',
    destination: { kind: 'main' },
    expected_workflow_revision: 1,
    subject_ref: 'subject-1',
    content_identity: { scheme: identity.scheme, version: identity.version, scope: identity.scope,
      completeness: identity.completeness, digest: identity.digest },
    launch: { cwd: repo, prompt: 'secret prompt', sender: 'Emilia', model: 'gpt-5.6-sol', reasoning: 'high',
      timeout_ms: null, permissions: null },
    authorization_boundary: { schema_version: 1, policy_id: 'repo-single-line-v1', decision_ref: 'owner-confirmed',
      concurrency: { mode: 'single-line', decision_ref: null } },
    ...overrides,
  });
  const result = { root, repo, runtime, harness, registration, input, source, sessions, runs, requests };
  t.after(() => { result.harness.workflowHistory.current.clear(); result.harness.close(); rmSync(root, { recursive: true, force: true }); });
  return result;
}

function setWorkflow(f: ReturnType<typeof fixture>, revision = 1) {
  f.harness.workflowHistory.current.set(f.registration.ticket_id, { ticket_id: f.registration.ticket_id,
    conversation_id: f.registration.conversation_id, workflow_revision: revision, previous_revision: null,
    request_id: `workflow-${revision}`, fingerprint: 'a'.repeat(64),
    snapshot: { subject: { subject_id: 'subject-1' } }, assessment: {} } as any);
}

test('reserve is ticket-scoped, content-protected, typed, and restart-stable', t => {
  const f = fixture(t, { authorizeParallel: true });
  const main = f.harness.executionOperations.reserve(f.input());
  assert.equal(main.state, 'reserved');
  assert.equal(main.destination.kind, 'main');
  assert.equal(main.destination.conversation_id, f.registration.conversation_id);
  assert.equal(JSON.stringify(main).includes('secret prompt'), false);
  assert.equal(f.harness.executionOperations.reserve(f.input()).operation_id, main.operation_id);
  assert.throws(() => f.harness.executionOperations.reserve(f.input({ launch: {
    ...(f.input().launch as object), prompt: 'changed prompt',
  } })), (error: any) => error.code === 'REQUEST_CONFLICT');

  const child = f.harness.executionOperations.reserve(f.input({ request_id: 'owner-request-2', destination: {
    kind: 'child', relation: { kind: 'review', review_id: 'review-1', participant: 'standards' },
  }, authorization_boundary: { schema_version: 1, policy_id: 'parallel-fixture', decision_ref: 'owner-confirmed',
    concurrency: { mode: 'parallel', decision_ref: 'fixture-parallel' } } }));
  assert.equal(child.destination.kind, 'child');
  assert.equal(child.destination.isolation.state, 'unknown');
  assert.equal(child.runtime.session_id, null);
  const childConversationId = child.destination.conversation_id;

  f.harness.close();
  const restored = new Harness(f.runtime, f.source);
  f.harness = restored;
  const replayed = restored.executionOperations.reserve(f.input({ request_id: 'owner-request-2', destination: {
    kind: 'child', relation: { kind: 'review', review_id: 'review-1', participant: 'standards' },
  }, authorization_boundary: { schema_version: 1, policy_id: 'parallel-fixture', decision_ref: 'owner-confirmed',
    concurrency: { mode: 'parallel', decision_ref: 'fixture-parallel' } } }));
  assert.equal(replayed.destination.conversation_id, childConversationId);
  assert.equal(replayed.deduplicated, true);
});

test('explicit transitions and composite bind survive restart; reconcile stays read-only', t => {
  const f = fixture(t);
  setWorkflow(f);
  const reserved = f.harness.executionOperations.reserve(f.input());
  const runtimeFingerprint = 'b'.repeat(64);
  const dispatch = f.harness.executionOperations.guardDispatch(reserved.operation_id, {
    request_id: reserved.runtime.request_id, fingerprint: runtimeFingerprint, cwd: f.repo,
    config: { model: 'gpt-5.6-sol', reasoning: 'high' }, permissions: { sandbox_mode: 'danger-full-access' },
    launch: { prompt_sha256: (f.harness.executionOperations as any).operations.get(reserved.operation_id).protected_intent.launch.prompt_sha256,
      prompt_utf8_bytes: Buffer.byteLength('secret prompt'), sender: 'Emilia', model: 'gpt-5.6-sol', reasoning: 'high',
      timeout_ms: null, permission_selection: null },
  });
  assert.equal(dispatch.state, 'dispatching');
  const observation = { request_id: reserved.runtime.request_id, fingerprint: runtimeFingerprint,
    session_id: randomUUID(), run_id: randomUUID(), status: 'running' };
  f.sessions.set(observation.session_id, { id: observation.session_id, cwd: f.repo, codex_thread_id: null, permissions: {} });
  f.runs.set(observation.run_id, { id: observation.run_id, session_id: observation.session_id,
    created_at: new Date().toISOString(), model: 'gpt-5.6-sol', reasoning: 'high', status: 'running',
    config_source: 'fixture', timeout_ms: null, exit_code: null });
  f.requests.set(observation.request_id, observation);
  assert.equal(f.harness.executionOperations.markStarted(reserved.operation_id).state, 'started');
  const bound = f.harness.executionOperations.bind(reserved.operation_id);
  assert.equal(bound.state, 'bound'); assert.ok(bound.binding_id);
  const before = f.harness.journal.records.length;
  assert.equal(f.harness.executionOperations.reconcile(reserved.operation_id).effective_state, 'bound');
  assert.equal(f.harness.journal.records.length, before);

  f.harness.workflowHistory.current.clear(); f.harness.close();
  f.harness = new Harness(f.runtime, f.source);
  const restored = f.harness.executionOperations.query(reserved.operation_id);
  assert.equal(restored.state, 'bound'); assert.equal(restored.binding_id, bound.binding_id);
  assert.equal(f.harness.bindings.get(bound.binding_id)!.run_id, observation.run_id);
});

test('full append with lost reserve receipt recovers one operation without dispatch', t => {
  const f = fixture(t);
  const original = f.harness.journal.append.bind(f.harness.journal);
  f.harness.journal.append = ((data: any) => { const record = original(data); throw Object.assign(new Error('receipt lost'), { record }); }) as any;
  assert.throws(() => f.harness.executionOperations.reserve(f.input()), (error: any) => error.code === 'RECORDING_OUTCOME_UNKNOWN');
  assert.throws(() => f.harness.executionOperations.reserve(f.input()), (error: any) => error.code === 'RECORDING_OUTCOME_UNKNOWN');
  assert.equal(f.requests.size, 0);
  f.harness.close();
  f.harness = new Harness(f.runtime, f.source);
  const recovered = f.harness.executionOperations.reserve(f.input());
  assert.equal(recovered.deduplicated, true);
  assert.equal(recovered.state, 'reserved');
  assert.equal(f.requests.size, 0);
});

test('lost transition receipt and partial tail remain unknown until checked restart', t => {
  const f = fixture(t);
  setWorkflow(f);
  const reserved = f.harness.executionOperations.reserve(f.input());
  const operation = (f.harness.executionOperations as any).operations.get(reserved.operation_id);
  const original = f.harness.journal.append.bind(f.harness.journal);
  f.harness.journal.append = ((data: any) => { const record = original(data); throw Object.assign(new Error('transition receipt lost'), { record }); }) as any;
  const dispatch = () => f.harness.executionOperations.guardDispatch(reserved.operation_id, {
    request_id: reserved.runtime.request_id, fingerprint: 'd'.repeat(64), cwd: f.repo,
    config: { model: 'gpt-5.6-sol', reasoning: 'high' }, permissions: { sandbox_mode: 'danger-full-access' },
    launch: { prompt_sha256: operation.protected_intent.launch.prompt_sha256,
      prompt_utf8_bytes: Buffer.byteLength('secret prompt'), sender: 'Emilia', model: 'gpt-5.6-sol', reasoning: 'high',
      timeout_ms: null, permission_selection: null },
  });
  assert.throws(dispatch, (error: any) => error.code === 'RECORDING_OUTCOME_UNKNOWN');
  assert.throws(dispatch, (error: any) => error.code === 'RECORDING_OUTCOME_UNKNOWN');
  f.harness.workflowHistory.current.clear(); f.harness.close();
  f.harness = new Harness(f.runtime, f.source);
  const restored = f.harness.executionOperations.query(reserved.operation_id);
  assert.equal(restored.state, 'dispatching'); assert.equal(restored.effective_state, 'reconciliation-required');
  assert.equal(f.requests.size, 0);

  f.harness.close();
  appendFileSync(path.join(f.runtime, 'harness', 'history.jsonl'), '{"partial":', 'utf8');
  f.harness = new Harness(f.runtime, f.source);
  const frozen = f.harness.executionOperations.query(reserved.operation_id);
  assert.equal(frozen.recording.state, 'recording-failed');
  assert.equal(f.harness.executionOperations.reconcile(reserved.operation_id).effective_state, 'reconciliation-required');
  assert.equal(f.requests.size, 0);
});

test('guarded manager seam rechecks drift after awaits and launches immediately only after guard', async t => {
  const f = fixture(t);
  setWorkflow(f);
  const reserved = f.harness.executionOperations.reserve(f.input());
  let resolveCatalog!: (value: any) => void;
  const catalog = { validate: () => new Promise(resolve => { resolveCatalog = resolve; }) };
  const permissionResolver = { resolve: async () => ({ version: 1, kind: 'native', stored: true,
    sandbox_mode: 'danger-full-access', approval_policy: 'on-request', approvals_reviewer: 'user',
    workspace_write: null, source: 'fixture', resolved_at: new Date().toISOString() }) };
  const calls: any[] = [];
  const executor = { start: (...args: any[]) => { calls.push(args); return { stop: async () => {} }; } };
  const store = new RuntimeStore(path.join(f.root, 'manager-runtime'));
  const manager = new SessionManager({ store, catalog, executor, permissionResolver, allowedCwds: [f.repo] });
  t.after(() => store.close());
  const starting = manager.startGuarded({ request_id: reserved.runtime.request_id, cwd: f.repo,
    prompt: 'secret prompt', sender: 'Emilia', model: 'gpt-5.6-sol', reasoning: 'high' },
  (dispatch: any) => f.harness.executionOperations.guardDispatch(reserved.operation_id, dispatch));
  await new Promise(resolve => setImmediate(resolve));
  const current = f.harness.workflowHistory.current.get(f.registration.ticket_id)!;
  f.harness.workflowHistory.current.set(f.registration.ticket_id, { ...current, workflow_revision: 2 });
  resolveCatalog({ model: 'gpt-5.6-sol', reasoning: 'high' });
  await assert.rejects(starting, (error: any) => error.code === 'WORKFLOW_REVISION_CONFLICT');
  assert.equal(calls.length, 0); assert.equal(manager.lookupRequest(reserved.runtime.request_id), null);
  assert.equal(f.harness.executionOperations.query(reserved.operation_id).state, 'reserved');

  f.harness.workflowHistory.current.set(f.registration.ticket_id, current);
  const foreignRun = { id: randomUUID(), session_id: randomUUID(), created_at: new Date().toISOString(),
    model: 'gpt-5.6-sol', reasoning: 'medium', status: 'running', config_source: 'fixture', timeout_ms: null, exit_code: null };
  f.runs.set(foreignRun.id, foreignRun);
  const second = manager.startGuarded({ request_id: reserved.runtime.request_id, cwd: f.repo,
    prompt: 'secret prompt', sender: 'Emilia', model: 'gpt-5.6-sol', reasoning: 'high' },
  (dispatch: any) => f.harness.executionOperations.guardDispatch(reserved.operation_id, dispatch));
  await new Promise(resolve => setImmediate(resolve));
  resolveCatalog({ model: 'gpt-5.6-sol', reasoning: 'high' });
  await assert.rejects(second, (error: any) => error.code === 'MODEL_LINE_BUSY');
  assert.equal(calls.length, 0); f.runs.delete(foreignRun.id);

  const third = manager.startGuarded({ request_id: reserved.runtime.request_id, cwd: f.repo,
    prompt: 'secret prompt', sender: 'Emilia', model: 'gpt-5.6-sol', reasoning: 'high' },
  (dispatch: any) => f.harness.executionOperations.guardDispatch(reserved.operation_id, dispatch));
  await new Promise(resolve => setImmediate(resolve));
  resolveCatalog({ model: 'gpt-5.6-sol', reasoning: 'high' });
  const accepted = await third;
  assert.equal(calls.length, 1, 'guarded path calls executor in the acceptance turn');
  assert.equal(manager.lookupRequest(reserved.runtime.request_id)!.run_id, accepted.run_id);
});

test('same destination is exclusively reserved and different destinations default to single-line', t => {
  const f = fixture(t);
  const first = f.harness.executionOperations.reserve(f.input());
  assert.throws(() => f.harness.executionOperations.reserve(f.input({ request_id: 'another-main' })),
    (error: any) => error.code === 'DESTINATION_BUSY' && error.details.operation_id === first.operation_id);
  assert.throws(() => f.harness.executionOperations.reserve(f.input({ request_id: 'child-request', destination: {
    kind: 'child', relation: { kind: 'acceptance', acceptance_id: 'acceptance-1' },
  } })), (error: any) => error.code === 'MODEL_LINE_BUSY');
  assert.throws(() => f.harness.attach({ ticket_id: f.registration.ticket_id,
    session_id: randomUUID(), run_id: randomUUID() }), (error: any) => error.code === 'ATTRIBUTION_CONFLICT');
});

test('active operations on another ticket block reserve and the final dispatch gate by default', t => {
  const f = fixture(t, { authorizeParallel: true });
  const other = f.harness.register({ project_key: 'YCA', project_name: 'Yuki Computer Agent', ticket_key: 'ORCH-OTHER',
    title: 'Other ticket', reference: 'https://github.invalid/issues/other', expected_worktree: f.repo,
    fixed_point: git(f.repo, 'rev-parse', 'HEAD') });
  const current = f.harness.executionOperations.reserve(f.input());
  assert.throws(() => f.harness.executionOperations.reserve(f.input({
    ticket_id: other.ticket_id, request_id: 'other-ticket-request',
  })), (error: any) => error.code === 'MODEL_LINE_BUSY', 'another Ticket must not bypass the default single-line gate');

  f.harness.executionOperations.reserve(f.input({ ticket_id: other.ticket_id, request_id: 'parallel-ticket-request',
    authorization_boundary: { schema_version: 1, policy_id: 'parallel-fixture', decision_ref: 'owner-confirmed',
      concurrency: { mode: 'parallel', decision_ref: 'fixture-parallel' } } }));
  setWorkflow(f);
  const operation = (f.harness.executionOperations as any).operations.get(current.operation_id);
  assert.throws(() => f.harness.executionOperations.guardDispatch(current.operation_id, {
    request_id: current.runtime.request_id, fingerprint: 'e'.repeat(64), cwd: f.repo,
    config: { model: 'gpt-5.6-sol', reasoning: 'high' }, permissions: { sandbox_mode: 'danger-full-access' },
    launch: operation.protected_intent.launch,
  }), (error: any) => error.code === 'MODEL_LINE_BUSY', 'dispatch must recheck claims from every Ticket');
});

test('session ownership cannot move between Main and child by changing the run', t => {
  for (const scope of ['session', 'run'] as const) {
    const f = fixture(t);
    const sessionId = randomUUID(), oldRunId = randomUUID();
    f.sessions.set(sessionId, { id: sessionId, cwd: f.repo, codex_thread_id: null, permissions: {} });
    f.runs.set(oldRunId, { id: oldRunId, session_id: sessionId, created_at: new Date().toISOString(),
      model: 'gpt-5.6-sol', reasoning: 'high', status: 'completed', config_source: 'fixture', timeout_ms: null, exit_code: 0 });
    f.harness.attach({ ticket_id: f.registration.ticket_id, session_id: sessionId,
      ...(scope === 'run' ? { run_id: oldRunId } : {}) });
    setWorkflow(f);
    const reserved = f.harness.executionOperations.reserve(f.input({ request_id: `child-${scope}`, destination: {
      kind: 'child', relation: { kind: 'review', review_id: `review-${scope}`, participant: 'standards' },
    } }));
    const operation = (f.harness.executionOperations as any).operations.get(reserved.operation_id);
    const fingerprint = scope === 'session' ? 'f'.repeat(64) : '1'.repeat(64);
    f.harness.executionOperations.guardDispatch(reserved.operation_id, {
      request_id: reserved.runtime.request_id, fingerprint, cwd: f.repo,
      config: { model: 'gpt-5.6-sol', reasoning: 'high' }, permissions: { sandbox_mode: 'danger-full-access' },
      launch: operation.protected_intent.launch,
    });
    const newRunId = randomUUID();
    f.runs.set(newRunId, { id: newRunId, session_id: sessionId, created_at: new Date().toISOString(),
      model: 'gpt-5.6-sol', reasoning: 'high', status: 'running', config_source: 'fixture', timeout_ms: null, exit_code: null });
    f.requests.set(reserved.runtime.request_id, { request_id: reserved.runtime.request_id, fingerprint,
      session_id: sessionId, run_id: newRunId, status: 'running' });
    f.harness.executionOperations.markStarted(reserved.operation_id);
    const before = f.harness.journal.records.length;
    assert.throws(() => f.harness.executionOperations.bind(reserved.operation_id),
      (error: any) => error.code === 'ATTRIBUTION_CONFLICT', `${scope} ownership must cover every run in the session`);
    assert.equal(f.harness.journal.records.length, before, 'rejected binding must not append');
  }
});

test('Context projects unbound operations and recommends read-only reconcile without mutation', t => {
  const f = fixture(t);
  const reserved = f.harness.executionOperations.reserve(f.input());
  const beforeReserved = f.harness.journal.records.length;
  let packet = new ContextAssembler(new HarnessContextFactsSource(f.harness)).assemble({
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'service-restart',
  });
  const projected = packet.execution.operations.find((value: any) => value.operation_id === reserved.operation_id);
  assert.equal(projected.state, 'reserved');
  assert.equal(projected.runtime.session_id, null); assert.equal(projected.runtime.run_id, null);
  assert.equal(f.harness.journal.records.length, beforeReserved);

  setWorkflow(f);
  const operation = (f.harness.executionOperations as any).operations.get(reserved.operation_id);
  f.harness.executionOperations.guardDispatch(reserved.operation_id, {
    request_id: reserved.runtime.request_id, fingerprint: 'c'.repeat(64), cwd: f.repo,
    config: { model: 'gpt-5.6-sol', reasoning: 'high' }, permissions: { sandbox_mode: 'danger-full-access' },
    launch: { prompt_sha256: operation.protected_intent.launch.prompt_sha256,
      prompt_utf8_bytes: Buffer.byteLength('secret prompt'), sender: 'Emilia', model: 'gpt-5.6-sol', reasoning: 'high',
      timeout_ms: null, permission_selection: null },
  });
  f.harness.workflowHistory.current.clear(); f.harness.close();
  f.harness = new Harness(f.runtime, f.source);
  const beforeReconcile = f.harness.journal.records.length;
  packet = new ContextAssembler(new HarnessContextFactsSource(f.harness)).assemble({
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'service-restart',
  });
  assert.equal(packet.execution.operations[0].effective_state, 'reconciliation-required');
  assert.equal(packet.recommendation.kind, 'reconcile-durable-operation');
  assert.ok(packet.attention.unknown_side_effects.some((value: any) => value.operation_id === reserved.operation_id));
  assert.equal(f.harness.journal.records.length, beforeReconcile);
});
