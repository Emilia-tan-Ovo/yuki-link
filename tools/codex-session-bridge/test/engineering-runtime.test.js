import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEngineeringRuntime } from '../src/engineering/runtime.js';
import { createEngineeringHttpServer, stopEngineeringRun } from '../src/engineering/http.js';
import { projectEngineeringEvent } from '../src/engineering/projection.js';
import { digestWorkflowAgentPolicy } from '../src/orchestration/workflow-agent-launcher.ts';
import { digestImplementationPolicy, FileImplementationLaunchAuthoritySource } from '../src/orchestration/implementation-launcher.ts';
import { DEFAULT_MODEL, DEFAULT_REASONING } from '../src/model-policy.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const scope = { connection: 'fixture', profile: 'fixture', chat: 'durable-chat', project: 'fixture-project' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw Error('fixture timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
class FixtureExecutor {
  calls = [];
  start(run, session, prompt, callbacks) {
    this.calls.push({ run, session, prompt, callbacks });
    callbacks.onSpawn(null);
    callbacks.onEvent({ type: 'thread.started', thread_id: session.codex_thread_id ?? randomUUID() });
    callbacks.onEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'fixture command', aggregated_output: 'ok', exit_code: 0 } });
    return { stop: async () => callbacks.onDone({ code: 1, signal: null, error: null }) };
  }
  complete(index) {
    this.calls[index].callbacks.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture completed' } });
    this.calls[index].callbacks.onDone({ code: 0, signal: null, error: null });
  }
}
function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yer-fixture-')), repo = path.join(root, 'repo'), directory = path.join(root, 'runtime');
  mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repo, 'code.txt'), 'base\n', 'utf8'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const head = git(repo, 'rev-parse', 'HEAD');
  const policy = { schema_version: 1, policy_id: 'fixture-policy', revision: 1, project_key: 'fixture',
    action: 'ticket-design', workflow_phase: 'ticket-design', model: DEFAULT_MODEL, reasoning: DEFAULT_REASONING,
    permission_selection: 'owner-native-default', preflight: { require_recording: true, model_line: 'single',
      required_paths: [], required_executables: [], dependency_packages: [] } };
  const policyFile = path.join(root, 'policy.json');
  writeFileSync(policyFile, JSON.stringify({ schema_version: 1, policies: [policy], authorizations: [] }), 'utf8');
  const permissions = { version: 1, kind: 'native', stored: true, sandbox_mode: 'danger-full-access',
    approval_policy: 'never', approvals_reviewer: 'user', workspace_write: null, source: 'fixture-native' };
  const executor = new FixtureExecutor();
  const options = { runtime: directory, roots: [repo], executor,
    catalog: { validate: async (model, reasoning) => {
      if (model !== 'gpt-6-astra' || reasoning !== 'xhigh') throw Error('unexpected model');
      return { model, reasoning, capability_checked_at: new Date().toISOString() };
    }, list: async () => ({ models: [{ model: 'gpt-6-astra', reasoning: ['xhigh'] }] }) },
    permissionResolver: { resolve: async () => ({ ...permissions, resolved_at: new Date().toISOString() }) },
    authorityFiles: { workflowAgentAuthority: policyFile }, profile: { model: 'gpt-6-astra', reasoning: 'xhigh', service_tier: 'fast' } };
  let runtime = createEngineeringRuntime(options);
  const harness = runtime.manager.harness;
  const registration = harness.register({ project_key: 'fixture', project_name: 'Fixture', ticket_key: 'TEST-1', title: 'fixture',
    reference: 'local:TEST-1', expected_worktree: repo, fixed_point: head });
  const ticket = harness.tickets.get(registration.ticket_id);
  const content_identity = runtime.manager.engineering.currentContent(ticket);
  // A fixture workflow/source, not a claim of real repository acceptance.
  const workflow = { ticket_id: ticket.id, conversation_id: ticket.main_conversation_id, workflow_revision: 1,
    assessment: { state: 'unknown', checked_at: new Date().toISOString(), reasons: [], artifacts: [], runtime: [] },
    snapshot: { phase: 'ticket-design', checkpoint: { worktree: repo, head }, subject: { subject_id: 'subject', head,
      staged: [], unstaged: [], untracked: [] }, artifacts: [], runtime_refs: [], findings: [], reviews: [],
      acceptance: { acceptance_id: 'acceptance', status: 'pending', actor: { method: 'deterministic' }, criteria: [] } } };
  harness.workflowHistory.current.set(ticket.id, workflow);
  runtime.manager.engineering.launcherOptions = { environment: { observe: () => ({ required_paths: [], required_executables: [] }) },
    context: () => ({ integrity: { state: 'complete' }, attention: { unknown_side_effects: [] },
      retrieval: { references: [{ location: 'docs/fixture.md' }] } }) };
  const input = { schema_version: 1, action: 'ticket-design', ticket_id: ticket.id, request_id: 'fixture-request',
    authorization_ref: 'proposed-owner-action', expected: { workflow_revision: 1, subject_ref: 'subject', subject_identity: null,
      content_identity, policy: { policy_id: policy.policy_id, revision: 1, digest: digestWorkflowAgentPolicy(policy) } },
    references: ['docs/fixture.md'], current_delta: [] };
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, directory, ticket, input, executor, policy, policyFile, options, permissions,
    get runtime() { return runtime; }, get manager() { return runtime.manager; },
    restart: async () => { await runtime.close(); runtime = createEngineeringRuntime(options); return runtime; } };
}
async function confirm(f, input = f.input) {
  const authority = f.manager.engineering;
  const plan = authority.propose({ kind: 'workflow', input });
  const preview = await authority.preview({ plan_id: plan.plan_id, scope });
  const receipt = await authority.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope });
  return { plan, preview, receipt };
}

test('YER without ComputerTools/Companion confirms once, continues same item, and recovers history', async t => {
  const f = setup(t);
  assert.equal(f.runtime.taskHost.filesystem, undefined);
  assert.equal(f.manager.companionDispatch, undefined);
  assert.throws(() => createEngineeringRuntime(f.options), { code: 'RUNTIME_LOCKED' });
  await assert.rejects(f.manager.engineering.start(f.input), /NOT_AUTHORIZED/);
  assert.throws(() => f.manager.engineering.propose({ kind: 'workflow', input: { ...f.input, confirmed: true } }));
  const { plan, preview, receipt } = await confirm(f);
  await until(() => f.executor.calls.length === 1);
  assert.equal(receipt.work_item.state, 'active');
  assert.equal(f.executor.calls[0].run.model, 'gpt-6-astra');
  assert.equal(f.executor.calls[0].run.reasoning, 'xhigh');
  assert.equal(f.executor.calls[0].run.service_tier, 'fast');
  assert.equal(f.policy.model, DEFAULT_MODEL); assert.equal(f.policy.reasoning, DEFAULT_REASONING);
  const again = await f.manager.engineering.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope });
  assert.equal(again.operation_id, receipt.operation_id); assert.equal(f.executor.calls.length, 1);
  await assert.rejects(f.manager.engineering.confirm({ preview_id: preview.preview_id, payload_digest: '0'.repeat(64), scope }), /CONFIRMATION_CONFLICT/);
  await assert.rejects(f.manager.engineering.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest,
    scope: { ...scope, chat: 'other-chat' } }), /CONFIRMATION_CONFLICT/);
  f.executor.complete(0); await tick();
  const continuation = await f.manager.engineering.start({ ...f.input, request_id: 'continuation',
    authorization_ref: preview.authorization_ref, work_item: { work_item_id: receipt.work_item.work_item_id, revision: receipt.work_item.revision } });
  await until(() => f.executor.calls.length === 2);
  assert.equal(continuation.execution_mode, 'continue');
  assert.equal(continuation.runtime.session_id, receipt.runtime.session_id);
  assert.equal(continuation.work_item.work_item_id, receipt.work_item.work_item_id);
  f.manager.harness.scan();
  const snapshot = f.manager.engineeringProjection.snapshot(f.ticket.id);
  assert.ok(snapshot.runs.some(run => run.service_tier === 'fast' && run.permissions.sandbox_mode === 'danger-full-access'));
  const sourceId = snapshot.source_id;
  const first = f.manager.engineeringProjection.events(f.ticket.id, { source_id: sourceId, after: 0, until: snapshot.high_water_cursor, limit: 2 });
  assert.equal(first.events.length, 2); assert.equal(first.has_more, true);
  const next = f.manager.engineeringProjection.events(f.ticket.id, { source_id: sourceId, after: first.next_cursor, limit: 100 });
  assert.ok(next.events.some(event => event.category === 'tool/command'));
  assert.ok(next.events.filter(event => event.category === 'tool/command')
    .every(event => event.work_item_id === receipt.work_item.work_item_id));
  assert.ok(next.events.every(event => event.cursor > first.next_cursor));
  assert.throws(() => f.manager.engineeringProjection.events(f.ticket.id, { source_id: randomUUID() }), /SOURCE_CHANGED/);
  stopEngineeringRun(f.manager, { ticket_id: f.ticket.id, work_item: { work_item_id: continuation.work_item.work_item_id,
    revision: continuation.work_item.revision }, session_id: continuation.runtime.session_id, run_id: continuation.runtime.run_id });
  await until(() => f.manager.status({ session_id: continuation.runtime.session_id, run_id: continuation.runtime.run_id }).run.status === 'stopped');
  await f.restart();
  assert.equal(f.manager.harness.journal.sourceId, sourceId);
  assert.equal(f.manager.engineering.operation(f.ticket.id, plan.request_id).operation_id, receipt.operation_id);
  assert.ok(f.manager.engineeringProjection.events(f.ticket.id, { source_id: sourceId, after: first.next_cursor }).events.length > 0);
  assert.equal(f.executor.calls.length, 2);
});

test('trusted implementation confirmation reaches the existing Notes-bound launcher', async t => {
  const f = setup(t), authority = f.manager.engineering;
  const notes = '# Implementation Notes\nFixture implementation only.\n';
  writeFileSync(path.join(f.repo, 'notes.md'), notes, 'utf8');
  const policy = { ...f.policy, action: 'ticket-implementation', workflow_phase: 'implementation',
    supported_contract_versions: [1], authority_refs: ['fixture-owner-policy'] };
  const policyFile = path.join(f.root, 'implementation-policy.json');
  writeFileSync(policyFile, JSON.stringify({ schema_version: 1, active_policy: policy, authorizations: [] }), 'utf8');
  authority.sources.implementationLaunchAuthority = new FileImplementationLaunchAuthoritySource(policyFile, { forbiddenRoots: [f.repo] });
  f.manager.harness.workflowHistory.current.get(f.ticket.id).snapshot.phase = 'implementation';
  const input = { schema_version: 1, action: 'implementation', ticket_id: f.ticket.id,
    request_id: 'implementation-fixture', authorization_ref: 'proposed-owner-action', current_delta: [],
    expected: { workflow_revision: 1, subject_ref: 'subject', content_identity: authority.currentContent(f.ticket),
      policy: { policy_id: policy.policy_id, revision: policy.revision, digest: digestImplementationPolicy(policy) },
      notes: { path: 'notes.md', sha256: createHash('sha256').update(notes).digest('hex') } } };
  const { receipt } = await confirm(f, input);
  await until(() => f.executor.calls.length === 1);
  assert.equal(receipt.work_item.purpose, 'implementation');
  assert.equal(f.executor.calls[0].run.service_tier, 'fast');
  assert.equal(f.executor.calls[0].session.permissions.sandbox_mode, 'danger-full-access');
  assert.match(f.executor.calls[0].prompt, /notes\.md/);
  f.executor.complete(0); await tick();
  const snapshot = f.manager.engineeringProjection.snapshot(f.ticket.id);
  assert.equal(snapshot.workflow.current.acceptance.status, 'pending');
  assert.equal(snapshot.work_items[0].state, 'active', 'run completion must not claim lifecycle completion');
});

test('stale previews, changed policy and failed journal cannot dispatch', async t => {
  const f = setup(t), authority = f.manager.engineering;
  const plan = authority.propose({ kind: 'workflow', input: f.input });
  let preview = await authority.preview({ plan_id: plan.plan_id, scope });
  authority.now = () => Date.parse(preview.expires_at) + 1;
  await assert.rejects(authority.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope }), /EXPIRED/);
  authority.now = Date.now;
  preview = await authority.preview({ plan_id: plan.plan_id, scope });
  writeFileSync(path.join(f.repo, 'code.txt'), 'external editor\n', 'utf8');
  await assert.rejects(authority.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope }), /SUBJECT_IDENTITY_CONFLICT/);
  writeFileSync(path.join(f.repo, 'code.txt'), 'base\n', 'utf8');
  const policy = JSON.parse(readFileSync(f.policyFile, 'utf8')); policy.policies[0].revision++;
  writeFileSync(f.policyFile, JSON.stringify(policy), 'utf8');
  await assert.rejects(authority.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope }), /POLICY_CONFLICT/);
  f.manager.harness.journal.failure = 'fixture-write-failed';
  assert.throws(() => authority.propose({ kind: 'workflow', input: { ...f.input, request_id: 'another' } }), /RECORDING_FAILED/);
  assert.equal(f.executor.calls.length, 0);
  f.manager.harness.journal.failure = null;
});

test('engineering verification is receipt-bound; epoch loss is unknown and never re-executes', async t => {
  const f = setup(t);
  const { receipt } = await confirm(f); await until(() => f.executor.calls.length === 1);
  f.executor.complete(0); await tick();
  const authority = f.manager.engineering;
  const taskPlan = authority.propose({ kind: 'verification', input: { ticket_id: f.ticket.id, request_id: 'verify',
    work_item: { work_item_id: receipt.work_item.work_item_id, revision: receipt.work_item.revision },
    content_identity: f.input.expected.content_identity, label: 'fixture verification', script: "Write-Output 'verified-fixture'", timeout_ms: 10000 } });
  const preview = await authority.preview({ plan_id: taskPlan.plan_id, scope });
  const task = await authority.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope });
  await until(() => f.runtime.taskHost.tasks.status({ task_id: task.task_id }).status === 'completed');
  assert.equal(f.runtime.taskHost.tasks.status({ task_id: task.task_id }).exit_code, 0);
  assert.match(JSON.stringify(f.runtime.taskHost.tasks.output({ task_id: task.task_id })), /verified-fixture/);
  assert.equal((await authority.confirm({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope })).task_id, task.task_id);
  const source = f.manager.harness.journal.sourceId;
  await f.restart();
  const recovered = f.manager.engineering.operation(f.ticket.id, 'verify');
  assert.equal(recovered.reconciliation_required, true);
  assert.equal(recovered.receipt.task_id, task.task_id);
  assert.equal(f.manager.harness.journal.sourceId, source);
  assert.equal(f.runtime.taskHost.tasks.records.size, 0);
});

test('loopback HTTP/MCP exposes only engineering tools and separates trusted confirmation', async t => {
  const f = setup(t), server = createEngineeringHttpServer(f.manager, { adapterToken: 'fixture-only-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = new Client({ name: 'fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('start_workflow_agent') && names.includes('get_engineering_events'));
  assert.ok(!names.some(name => /^(filesystem|powershell|git_|task_|codex_start|codex_send|dispatch_confirmed)/.test(name)));
  assert.ok(!names.some(name => /confirm|preview/.test(name)));
  const identity = await (await fetch(base + '/engineering/identity')).json();
  const headers = { 'content-type': 'application/json', 'x-yer-source-id': identity.source_id };
  const plan = f.manager.engineering.propose({ kind: 'workflow', input: f.input });
  const route = base + '/engineering/tickets/' + f.ticket.id + '/preview';
  assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify({ plan_id: plan.plan_id, scope }) })).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { ...headers, authorization: 'Bearer fixture-only-token',
    origin: 'https://untrusted.invalid' }, body: '{}' })).status, 403);
  const previewResponse = await fetch(route, { method: 'POST', headers: { ...headers, authorization: 'Bearer fixture-only-token' },
    body: JSON.stringify({ plan_id: plan.plan_id, scope }) });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const response = await fetch(base + '/engineering/tickets/' + f.ticket.id + '/confirm', { method: 'POST',
    headers: { ...headers, authorization: 'Bearer fixture-only-token' },
    body: JSON.stringify({ preview_id: preview.preview_id, payload_digest: preview.payload_digest, scope }) });
  assert.equal(response.status, 200); const result = await response.json();
  await until(() => f.executor.calls.length === 1);
  await client.close();
  const reconnected = new Client({ name: 'fixture-again', version: '1' });
  await reconnected.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  t.after(() => reconnected.close());
  const found = await reconnected.callTool({ name: 'get_engineering_operation', arguments: { ticket_id: f.ticket.id, request_id: f.input.request_id } });
  assert.equal(found.structuredContent.operation_id, result.receipt.operation_id);
  assert.equal(f.executor.calls.length, 1);
  const probe = fileURLToPath(new URL('../../hermes-yer-adapter/test/ipc_probe.py', import.meta.url));
  const python = await promisify(execFile)(process.env.YER_TEST_PYTHON ?? 'python',
    [probe, base, identity.source_id, f.ticket.id, f.input.request_id], { windowsHide: true, timeout: 20000 });
  const direct = JSON.parse(python.stdout);
  assert.equal(direct.operation_id, result.receipt.operation_id);
  assert.equal(direct.proxy_bypassed, true);
});

test('backend-neutral event DTO preserves source labels, bounds payload, and excludes internal reasoning', () => {
  const record = { schema_version: 1, cursor: 1, source_id: randomUUID(), event_id: randomUUID(), observed_at: new Date().toISOString(),
    data: { kind: 'event', event: { ticket_id: randomUUID(), conversation_id: randomUUID(), session_id: randomUUID(), run_id: randomUUID(),
      kind: 'dsh.progress', source_at: null, payload: { backend_kind: 'dsh-fixture', text: 'public progress' }, integrity: { redacted: false } } } };
  const event = projectEngineeringEvent(record, randomUUID());
  assert.equal(event.backend_kind, 'dsh-fixture'); assert.equal(event.source_id, record.source_id);
  assert.equal(event.payload.text, 'public progress');
  record.data.event.payload.text = 'x'.repeat(50000);
  assert.equal(projectEngineeringEvent(record, '').integrity.truncated, true);
  record.data.event.payload = { item: { type: 'reasoning', text: 'private' } };
  assert.equal(projectEngineeringEvent(record, ''), null);
});
