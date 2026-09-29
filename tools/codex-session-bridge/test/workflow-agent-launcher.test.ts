import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Harness } from '../src/harness/harness.ts';
import { subjectIdentity } from '../src/harness/workflow.ts';
import { createHttpServer } from '../src/http.js';
import { FileWorkflowAgentAuthoritySource, WorkflowAgentLauncher, digestWorkflowAgentPolicy,
  startWorkflowAgentInputSchema } from '../src/orchestration/workflow-agent-launcher.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(t: test.TestContext, action: 'ticket-design' | 'finding-fix' | 'focused-review' | 'acceptance-agent',
  companionText?: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-'));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', repo]);
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repo, 'subject.txt'), 'base\n', 'utf8');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  const sessions = new Map<string, any>(), runs = new Map<string, any>(), requests = new Map<string, any>();
  const source = { session: (id: string) => sessions.get(id),
    runs: (id: string) => [...runs.values()].filter(value => value.session_id === id),
    events: () => [], attribution: () => ({ state: 'unknown' }),
    lookupRequest: (id: string) => requests.get(id) ?? null,
    activeRuns: () => [...runs.values()].filter(value => value.status === 'running') };
  let harness = new Harness(path.join(root, 'runtime'), source);
  const registration = harness.register({ project_key: 'YCA', project_name: 'Yuki Computer Agent',
    ticket_key: 'ORCH-007', title: 'Workflow Agent', reference: 'https://github.invalid/issues/114',
    expected_worktree: repo, fixed_point: head });
  const identity = harness.changes.facts.currentIdentity(harness.tickets.get(registration.ticket_id)!.comparison_baseline!);
  const content_identity = { scheme: identity.scheme, version: identity.version, scope: identity.scope,
    completeness: identity.completeness, digest: identity.digest };
  const phase = action === 'ticket-design' ? 'ticket-design' : action === 'finding-fix' ? 'implementation'
    : action === 'focused-review' ? 'review' : 'acceptance';
  const finding = { origin_review_id: 'review-1', finding_id: 'finding-1', report_ref: 'review/report.md',
    fix_baseline: head };
  const workflow = { ticket_id: registration.ticket_id, conversation_id: registration.conversation_id,
    workflow_revision: 2, assessment: { state: 'unknown', checked_at: new Date().toISOString(),
      reasons: [], artifacts: [], runtime: [] }, snapshot: { phase, checkpoint: { worktree: repo, head },
      subject: { subject_id: 'subject-007', head, staged: [], unstaged: [], untracked: [] },
      artifacts: [], runtime_refs: [],
      findings: action === 'finding-fix' ? [{ ...finding, status: 'open' }]
        : action === 'focused-review' ? [{ ...finding, status: 'fixed-unverified' }] : [],
      reviews: action === 'focused-review' ? [{ review_id: 'focused-1', mode: 'focused', status: 'pending',
        subject_ref: 'subject-007', subject_identity: null,
        finding_refs: [{ origin_review_id: finding.origin_review_id, finding_id: finding.finding_id }] }] : [],
      acceptance: { acceptance_id: 'acceptance-1', status: 'pending',
        criteria: [{ criteria_ref: '#114-AC-smoke', status: 'not-verified', evidence: [], notes: null }] } } };
  harness.workflowHistory.current.set(registration.ticket_id, workflow as any);
  const policy = { schema_version: 1, policy_id: 'workflow-agent-policy', revision: 1,
    project_key: 'YCA', action, workflow_phase: phase, model: 'gpt-6-sol', reasoning: 'medium',
    permission_selection: 'owner-native-default', preflight: { require_recording: true,
      model_line: 'single', required_paths: [], required_executables: [], dependency_packages: [] } };
  const authorization = { schema_version: 1, authorization_id: 'owner-authorization',
    ticket_key: 'ORCH-007', action, authorization_ref: 'owner:#114', subject_ref: 'subject-007',
    subject_identity: null, authority_refs: ['github:#114'], agent_required: true,
    ...(action === 'finding-fix' || action === 'focused-review'
      ? { finding, finding_context_refs: ['review/affected-code.md'] } : {}),
    ...(action === 'focused-review' ? { review_id: 'focused-1' } : {}),
    ...(action === 'acceptance-agent' ? { acceptance_id: 'acceptance-1', agent_criterion: {
      criteria_ref: '#114-AC-smoke', requirement: '真实 ticket-design Agent session smoke',
      behavior: 'agent-session' } } : {}) };
  const authorityPath = path.join(root, 'authority.json');
  writeFileSync(authorityPath, JSON.stringify({ schema_version: 1, policies: [policy],
    authorizations: [authorization] }), 'utf8');
  const authority = new FileWorkflowAgentAuthoritySource(authorityPath, { forbiddenRoots: [repo] });
  const companionIds = { card_store_id: randomUUID(), card_id: randomUUID(), dispatch_id: randomUUID() };
  const trustedAuthority = companionText ? { snapshot: (...args: Parameters<typeof authority.snapshot>) => {
    const snapshot = authority.snapshot(...args);
    return { ...snapshot, source: { ...snapshot.source, kind: 'adapter' as const, canonical_path: null },
      companion: { schema_version: 1, ...companionIds, revision: 1, content_digest: 'a'.repeat(64),
        confirmation_at: '2026-01-01T00:00:00.000Z', ticket_scope_digest: 'b'.repeat(64),
        product_endpoint: 'to-pr', action: action === 'finding-fix' ? 'implementation' : 'review',
        policy_digest: snapshot.policy.digest },
      confirmed_request: companionText };
  } } : authority;
  let starts = 0, sends = 0, lastPrompt = '';
  let lastLaunch: { model: string; reasoning: string; service_tier: string } | null = null;
  const manager = { get harness() { return harness; }, workflowAgentAuthority: trustedAuthority,
    async startGuarded(input: any, guard: (dispatch: any) => unknown) {
    starts++; lastPrompt = input.prompt;
    lastLaunch = { model: input.model, reasoning: input.reasoning, service_tier: input.service_tier ?? 'default' };
    assert.equal(input.permissions, undefined);
    const fingerprint = sha256(input.request_id);
    guard({ request_id: input.request_id, fingerprint, cwd: input.cwd,
      config: { model: input.model, reasoning: input.reasoning, service_tier: input.service_tier ?? 'default' },
      permissions: { sandbox_mode: 'danger-full-access', approval_policy: 'on-request' },
      launch: { prompt_sha256: sha256(input.prompt), prompt_utf8_bytes: Buffer.byteLength(input.prompt),
        sender: input.sender ?? null, model: input.model ?? null, reasoning: input.reasoning ?? null,
        service_tier: input.service_tier ?? 'default', timeout_ms: null, permission_selection: null } });
    const session_id = randomUUID(), run_id = randomUUID();
    sessions.set(session_id, { id: session_id, cwd: input.cwd, codex_thread_id: randomUUID() });
    runs.set(run_id, { id: run_id, session_id, status: 'running' });
    requests.set(input.request_id, { request_id: input.request_id, fingerprint, session_id, run_id,
      status: 'running' });
  }, async sendGuarded(input: any, guard: (dispatch: any) => unknown) {
    sends++; lastPrompt = input.prompt;
    lastLaunch = { model: input.model, reasoning: input.reasoning, service_tier: input.service_tier ?? 'default' };
    const fingerprint = sha256(input.request_id);
    guard({ request_id: input.request_id, fingerprint, cwd: repo, session_id: input.session_id,
      config: { model: input.model, reasoning: input.reasoning, service_tier: input.service_tier ?? 'default' },
      permissions: { sandbox_mode: 'danger-full-access', approval_policy: 'on-request' },
      launch: { prompt_sha256: sha256(input.prompt), prompt_utf8_bytes: Buffer.byteLength(input.prompt),
        sender: input.sender ?? null, model: input.model ?? null, reasoning: input.reasoning ?? null,
        service_tier: input.service_tier ?? 'default', timeout_ms: null, permission_selection: null } });
    const run_id = randomUUID();
    runs.set(run_id, { id: run_id, session_id: input.session_id, status: 'running' });
    requests.set(input.request_id, { request_id: input.request_id, fingerprint, session_id: input.session_id,
      run_id, status: 'running' });
  } };
  const makeLauncher = () => new WorkflowAgentLauncher({ manager, harness, workflowAuthority: trustedAuthority,
    environment: { observe: () => ({ required_paths: [], required_executables: [] }) } as any,
    context: () => ({ integrity: { state: 'complete' }, attention: { unknown_side_effects: [] },
      retrieval: { references: [{ location: 'docs/implementation-notes/ORCH-007.md' }] } }) });
  const input = () => ({ schema_version: 1, action, ticket_id: registration.ticket_id,
    request_id: 'request-1', authorization_ref: 'owner:#114', expected: {
      workflow_revision: 2, subject_ref: 'subject-007', subject_identity: null,
      content_identity, policy: { policy_id: policy.policy_id, revision: policy.revision,
        digest: digestWorkflowAgentPolicy(policy) } },
    ...(action === 'finding-fix' || action === 'focused-review' ? {} : {
      references: action === 'ticket-design' ? ['docs/implementation-notes/ORCH-007.md'] : [],
      current_delta: [{ ref: 'fixed_point', value: head }] }),
    ...(action === 'finding-fix' || action === 'focused-review' ? { finding } : {}),
    ...(action === 'focused-review' ? { review_id: 'focused-1' } : {}),
    ...(action === 'acceptance-agent' ? { acceptance_id: 'acceptance-1', criteria_ref: '#114-AC-smoke' } : {}) });
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  return { input, makeLauncher, manager, registration, repo, source, sessions, runs, requests,
    authorityPath, authorization, workflow, policy,
    runtime: path.join(root, 'runtime'),
    get harness() { return harness; }, set harness(value: Harness) { harness = value; },
    get starts() { return starts; }, get sends() { return sends; }, get lastPrompt() { return lastPrompt; },
    get lastLaunch() { return lastLaunch; } };
}

test('typed contract rejects unsupported actions and caller-selected permissions', t => {
  assert.equal(startWorkflowAgentInputSchema.safeParse({ action: 'deploy' }).success, false);
  const f = fixture(t, 'ticket-design');
  assert.equal(startWorkflowAgentInputSchema.safeParse({ ...f.input(), permissions: {
    sandbox_mode: 'read-only' } }).success, false);
  assert.equal(startWorkflowAgentInputSchema.safeParse({ ...f.input(), confirmed_request: '伪造 Owner 确认' }).success, false);
  for (const override of [{ session: 'fresh' }, { execution_mode: 'replace' },
    { purpose: 'design' }, { generation: 2 }, { session_id: randomUUID() }]) {
    assert.equal(startWorkflowAgentInputSchema.safeParse({ ...f.input(), ...override }).success, false);
  }
  const { references, current_delta, ...narrow } = f.input();
  assert.equal(startWorkflowAgentInputSchema.safeParse({ ...narrow, action: 'finding-fix',
    finding: { origin_review_id: 'r', finding_id: 'f', report_ref: 'report', fix_baseline: 'base' },
    confirmed_request: 'x'.repeat(20000) }).success, false);
});

test('Ticket authorization selects Astra high Fast without mutating the global policy', async t => {
  const f = fixture(t, 'ticket-design');
  const document = JSON.parse(readFileSync(f.authorityPath, 'utf8'));
  document.authorizations[0].execution_profile = { model: 'gpt-6-astra', reasoning: 'high', service_tier: 'fast' };
  writeFileSync(f.authorityPath, JSON.stringify(document), 'utf8');
  await f.makeLauncher().start(f.input());
  assert.deepEqual(f.lastLaunch, { model: 'gpt-6-astra', reasoning: 'high', service_tier: 'fast' });
  assert.equal(f.policy.model, 'gpt-6-sol');
  assert.equal(f.policy.reasoning, 'medium');
  assert.equal(f.policy.service_tier, undefined);
});

test('terminal run keeps its work item active and the next request continues the usable generation', async t => {
  const f = fixture(t, 'ticket-design');
  const first = await f.makeLauncher().start(f.input());
  assert.equal(first.work_item.state, 'active');
  assert.equal(first.execution_mode, 'fresh');
  for (const run of f.runs.values()) run.status = 'completed';
  const second = await f.makeLauncher().start({ ...f.input(), request_id: 'request-2',
    work_item: { work_item_id: first.work_item.work_item_id, revision: first.work_item.revision } });
  assert.equal(f.starts, 1);
  assert.equal(f.sends, 1);
  assert.equal(second.work_item.work_item_id, first.work_item.work_item_id);
  assert.equal(second.work_item.generation, 1);
  assert.equal(second.execution_mode, 'continue');
  assert.equal(second.runtime.session_id, first.runtime.session_id);
});

test('an expanded issue set remains in the same repair work item and generation', async t => {
  const f = fixture(t, 'finding-fix');
  const first = await f.makeLauncher().start(f.input());
  for (const run of f.runs.values()) run.status = 'completed';
  const finding = f.input().finding!;
  const secondFinding = { ...finding, finding_id: 'finding-2' };
  f.workflow.snapshot.findings.push({ ...secondFinding, status: 'open' });
  const { finding: _finding, ...auth } = f.authorization;
  writeFileSync(f.authorityPath, JSON.stringify({ schema_version: 1, policies: [f.policy],
    authorizations: [{ ...auth, finding_batch: [finding, secondFinding] }] }), 'utf8');
  const { finding: _old, ...input } = f.input();
  const second = await f.makeLauncher().start({ ...input, request_id: 'request-2',
    finding_batch: [finding, secondFinding],
    work_item: { work_item_id: first.work_item.work_item_id, revision: first.work_item.revision } });
  assert.equal(second.work_item.work_item_id, first.work_item.work_item_id);
  assert.equal(second.work_item.issue_set.length, 2);
  assert.equal(f.starts, 1); assert.equal(f.sends, 1);
});

test('missing runtime thread replaces the generation but keeps work item identity', async t => {
  const f = fixture(t, 'ticket-design');
  const first = await f.makeLauncher().start(f.input());
  for (const run of f.runs.values()) run.status = 'interrupted';
  f.sessions.get(first.runtime.session_id).codex_thread_id = null;
  const second = await f.makeLauncher().start({ ...f.input(), request_id: 'request-2',
    work_item: { work_item_id: first.work_item.work_item_id, revision: first.work_item.revision } });
  assert.equal(second.work_item.work_item_id, first.work_item.work_item_id);
  assert.equal(second.execution_mode, 'replace');
  assert.equal(second.work_item.generation, 2);
  assert.equal(second.work_item.generations[0].state, 'retired');
  assert.notEqual(second.runtime.session_id, first.runtime.session_id);
});

test('repair handoff refuses a fabricated failed verification without a managed reviewer', async t => {
  const f = fixture(t, 'finding-fix');
  const first = await f.makeLauncher().start(f.input());
  for (const run of f.runs.values()) run.status = 'completed';
  const operations = f.harness.executionOperations;
  operations.dependencies.assessWorkflow = () => ({ state: 'verified' });
  for (const finding of f.workflow.snapshot.findings) finding.status = 'fixed-unverified';
  const grant = { decision_ref: 'owner:handoff', work_item_id: first.work_item.work_item_id,
    expected_revision: first.work_item.revision, workflow_revision: 2,
    subject_ref: 'subject-007', content_version: f.input().expected.content_identity.digest,
    action: 'await-verification', evidence_refs: ['review/report.md'] };
  const waiting = operations.transitionWorkItem(grant);
  assert.equal(waiting.state, 'awaiting_verification');
  assert.equal(waiting.generations[0].state, 'suspended');
  (f.workflow.snapshot.reviews as any[]).push({ review_id: 'focused-1', mode: 'focused',
    original_review_id: 'review-1', subject_ref: 'subject-007', isolated: true, applicability: 'verified', status: 'findings',
    subject_identity: subjectIdentity(f.workflow.snapshot.subject as any) });
  assert.throws(() => operations.transitionWorkItem({ ...grant, decision_ref: 'review:failed',
    expected_revision: waiting.revision, action: 'reopen', review_id: 'focused-1' }), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
});

test('public MCP exposes the typed Workflow Agent launcher', async t => {
  const f = fixture(t, 'ticket-design');
  const server = createHttpServer(f.manager as any, undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'workflow-agent-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  t.after(async () => { await client.close(); await new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  }); });
  const result = await client.callTool({ name: 'start_workflow_agent', arguments: f.input() });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as any).state, 'bound');
  assert.equal((result.structuredContent as any).action, 'ticket-design');
});

test('ticket-design uses fresh Main reservation, native Full Access and durable request dedupe', async t => {
  const f = fixture(t, 'ticket-design');
  const confirmedInput = f.input();
  const receipt = await f.makeLauncher().start(confirmedInput);
  assert.equal(receipt.state, 'bound');
  assert.equal(receipt.action, 'ticket-design');
  assert.equal(receipt.destination.kind, 'main');
  assert.equal(receipt.destination.conversation_id, f.registration.conversation_id);
  assert.equal(receipt.actual_permissions.sandbox_mode, 'danger-full-access');
  assert.equal(receipt.actual_permissions.approval_policy, 'on-request');
  assert.match(f.lastPrompt, /不要修改实现代码/);
  assert.doesNotMatch(f.lastPrompt, /已确认卡片原文/);
  assert.equal(f.starts, 1);
  const retry = await f.makeLauncher().start(confirmedInput);
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.operation_id, receipt.operation_id);
  assert.equal(f.starts, 1);
  const { references, current_delta, ...sameRequest } = f.input();
  await assert.rejects(f.makeLauncher().start({ ...sameRequest, action: 'finding-fix',
    finding: { origin_review_id: 'review-1', finding_id: 'finding-1',
      report_ref: 'review/report.md', fix_baseline: git(f.repo, 'rev-parse', 'HEAD') } }),
    (error: any) => error.code === 'REQUEST_CONFLICT');
  f.harness.close();
  f.harness = new Harness(f.runtime, f.source);
  const afterRestart = await f.makeLauncher().start(confirmedInput);
  assert.equal(afterRestart.operation_id, receipt.operation_id);
  assert.equal(afterRestart.deduplicated, true);
  assert.equal(f.starts, 1);
});

test('new phase actions use narrow finding context and typed child reservations', async t => {
  for (const action of ['finding-fix', 'focused-review', 'acceptance-agent'] as const) {
    await t.test(action, async subtest => {
      const f = fixture(subtest, action);
      const receipt = await f.makeLauncher().start(f.input());
      assert.equal(receipt.state, 'bound');
      assert.equal(receipt.destination.kind, action === 'finding-fix' ? 'main' : 'child');
      if (action === 'focused-review') assert.equal(receipt.destination.relation.kind, 'review');
      if (action === 'acceptance-agent') assert.equal(receipt.destination.relation.kind, 'acceptance');
      if (action !== 'acceptance-agent') {
        assert.match(f.lastPrompt, /review\/report\.md/);
        assert.doesNotMatch(f.lastPrompt, /docs\/implementation-notes\/ORCH-007\.md/);
        assert.match(f.lastPrompt, /review\/affected-code\.md/);
      }
    });
  }
});

test('finding actions reject caller-supplied broad context', t => {
  for (const action of ['finding-fix', 'focused-review'] as const) {
    const f = fixture(t, action);
    assert.equal(startWorkflowAgentInputSchema.safeParse({ ...f.input(), references: ['unrelated.md'] }).success, false);
    assert.equal(startWorkflowAgentInputSchema.safeParse({ ...f.input(), current_delta: [
      { ref: 'unrelated', value: 'injected' }] }).success, false);
  }
});

test('finding-fix and focused-review omit trusted Companion original from narrow context', async t => {
  for (const action of ['finding-fix', 'focused-review'] as const) {
    await t.test(action, async subtest => {
      const original = '完整原文：实现、merge PR 并 deploy 线上';
      const f = fixture(subtest, action, original);
      const receipt = await f.makeLauncher().start(f.input());
      assert.equal(receipt.state, 'bound');
      assert.doesNotMatch(f.lastPrompt, /完整原文|已确认卡片原文|merge PR|deploy/);
      assert.match(f.lastPrompt, /review\/report\.md/);
    });
  }
});

test('focused review rejects a pending review for another subject', async t => {
  const f = fixture(t, 'focused-review');
  const workflow = f.harness.workflowHistory.current.get(f.registration.ticket_id)!;
  workflow.snapshot.reviews[0].subject_ref = 'another-subject';
  await assert.rejects(f.makeLauncher().start(f.input()),
    (error: any) => error.code === 'WORKFLOW_AGENT_REVIEW_CONFLICT');
  workflow.snapshot.reviews[0].subject_ref = 'subject-007';
  workflow.snapshot.reviews[0].subject_identity = 'a'.repeat(64);
  await assert.rejects(f.makeLauncher().start(f.input()),
    (error: any) => error.code === 'WORKFLOW_AGENT_REVIEW_CONFLICT');
  assert.equal(f.starts, 0);
});

test('acceptance agent requires a matching Agent session criterion', async t => {
  const f = fixture(t, 'acceptance-agent');
  await assert.rejects(f.makeLauncher().start({ ...f.input(), criteria_ref: '#114-AC-other' }),
    (error: any) => error.code === 'WORKFLOW_AGENT_NOT_AUTHORIZED');
  const workflow = f.harness.workflowHistory.current.get(f.registration.ticket_id)!;
  workflow.snapshot.acceptance.criteria = [];
  await assert.rejects(f.makeLauncher().start(f.input()),
    (error: any) => error.code === 'WORKFLOW_AGENT_ACCEPTANCE_NOT_REQUIRED');
  assert.equal(f.starts, 0);
});
