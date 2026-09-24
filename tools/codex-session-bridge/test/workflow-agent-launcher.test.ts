import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Harness } from '../src/harness/harness.ts';
import { createHttpServer } from '../src/http.js';
import { FileWorkflowAgentAuthoritySource, WorkflowAgentLauncher, digestWorkflowAgentPolicy,
  startWorkflowAgentInputSchema } from '../src/orchestration/workflow-agent-launcher.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(t: test.TestContext, action: 'ticket-design' | 'finding-fix' | 'focused-review' | 'acceptance-agent') {
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
        finding_refs: [{ origin_review_id: finding.origin_review_id, finding_id: finding.finding_id }] }] : [],
      acceptance: { acceptance_id: 'acceptance-1', status: 'pending', criteria: [] } } };
  harness.workflowHistory.current.set(registration.ticket_id, workflow as any);
  const policy = { schema_version: 1, policy_id: 'workflow-agent-policy', revision: 1,
    project_key: 'YCA', action, workflow_phase: phase, model: 'gpt-6-sol', reasoning: 'medium',
    permission_selection: 'owner-native-default', preflight: { require_recording: true,
      model_line: 'single', required_paths: [], required_executables: [], dependency_packages: [] } };
  const authorization = { schema_version: 1, authorization_id: 'owner-authorization',
    ticket_key: 'ORCH-007', action, authorization_ref: 'owner:#114', subject_ref: 'subject-007',
    subject_identity: null, authority_refs: ['github:#114'], agent_required: true,
    ...(action === 'finding-fix' || action === 'focused-review' ? { finding } : {}),
    ...(action === 'focused-review' ? { review_id: 'focused-1' } : {}),
    ...(action === 'acceptance-agent' ? { acceptance_id: 'acceptance-1' } : {}) };
  const authorityPath = path.join(root, 'authority.json');
  writeFileSync(authorityPath, JSON.stringify({ schema_version: 1, policies: [policy],
    authorizations: [authorization] }), 'utf8');
  const authority = new FileWorkflowAgentAuthoritySource(authorityPath, { forbiddenRoots: [repo] });
  let starts = 0, lastPrompt = '';
  const manager = { get harness() { return harness; }, workflowAgentAuthority: authority,
    async startGuarded(input: any, guard: (dispatch: any) => unknown) {
    starts++; lastPrompt = input.prompt;
    assert.equal(input.permissions, undefined);
    const reserved = harness.executionOperations.findByRequest(registration.ticket_id, 'request-1');
    assert.equal(reserved?.state, 'reserved');
    const fingerprint = sha256(input.request_id);
    guard({ request_id: input.request_id, fingerprint, cwd: input.cwd,
      config: { model: input.model, reasoning: input.reasoning },
      permissions: { sandbox_mode: 'danger-full-access', approval_policy: 'on-request' },
      launch: { prompt_sha256: sha256(input.prompt), prompt_utf8_bytes: Buffer.byteLength(input.prompt),
        sender: input.sender ?? null, model: input.model ?? null, reasoning: input.reasoning ?? null,
        timeout_ms: null, permission_selection: null } });
    const session_id = randomUUID(), run_id = randomUUID();
    sessions.set(session_id, { id: session_id, cwd: input.cwd, codex_thread_id: randomUUID() });
    runs.set(run_id, { id: run_id, session_id, status: 'running' });
    requests.set(input.request_id, { request_id: input.request_id, fingerprint, session_id, run_id,
      status: 'running' });
  } };
  const makeLauncher = () => new WorkflowAgentLauncher({ manager, harness, workflowAuthority: authority,
    environment: { observe: () => ({ required_paths: [], required_executables: [] }) } as any,
    context: () => ({ integrity: { state: 'complete' }, attention: { unknown_side_effects: [] },
      retrieval: { references: [{ location: 'docs/implementation-notes/ORCH-007.md' }] } }) });
  const input = () => ({ schema_version: 1, action, ticket_id: registration.ticket_id,
    request_id: 'request-1', authorization_ref: 'owner:#114', expected: {
      workflow_revision: 2, subject_ref: 'subject-007', subject_identity: null,
      content_identity, policy: { policy_id: policy.policy_id, revision: policy.revision,
        digest: digestWorkflowAgentPolicy(policy) } },
    references: action === 'ticket-design' ? ['docs/implementation-notes/ORCH-007.md'] : ['review/report.md'],
    current_delta: [{ ref: 'fixed_point', value: head }],
    ...(action === 'finding-fix' || action === 'focused-review' ? { finding } : {}),
    ...(action === 'focused-review' ? { review_id: 'focused-1' } : {}),
    ...(action === 'acceptance-agent' ? { acceptance_id: 'acceptance-1' } : {}) });
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  return { input, makeLauncher, manager, registration, repo, source, sessions, runs,
    runtime: path.join(root, 'runtime'),
    get harness() { return harness; }, set harness(value: Harness) { harness = value; },
    get starts() { return starts; }, get lastPrompt() { return lastPrompt; } };
}

test('typed contract rejects unsupported actions and caller-selected permissions', t => {
  assert.equal(startWorkflowAgentInputSchema.safeParse({ action: 'deploy' }).success, false);
  const f = fixture(t, 'ticket-design');
  assert.equal(startWorkflowAgentInputSchema.safeParse({ ...f.input(), permissions: {
    sandbox_mode: 'read-only' } }).success, false);
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
  const receipt = await f.makeLauncher().start(f.input());
  assert.equal(receipt.state, 'bound');
  assert.equal(receipt.action, 'ticket-design');
  assert.equal(receipt.destination.kind, 'main');
  assert.equal(receipt.destination.conversation_id, f.registration.conversation_id);
  assert.equal(receipt.actual_permissions.sandbox_mode, 'danger-full-access');
  assert.equal(receipt.actual_permissions.approval_policy, 'on-request');
  assert.match(f.lastPrompt, /不要修改实现代码/);
  assert.equal(f.starts, 1);
  const retry = await f.makeLauncher().start(f.input());
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.operation_id, receipt.operation_id);
  assert.equal(f.starts, 1);
  await assert.rejects(f.makeLauncher().start({ ...f.input(), action: 'finding-fix' }),
    (error: any) => error.code === 'REQUEST_CONFLICT');
  f.harness.close();
  f.harness = new Harness(f.runtime, f.source);
  const afterRestart = await f.makeLauncher().start(f.input());
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
      }
    });
  }
});
