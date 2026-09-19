import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { Harness } from '../src/harness/harness.ts';
import { createHarnessServer } from '../src/harness/server.ts';

type Wire = Record<string, any>;
const payload = (result: Record<string, unknown>) => result.structuredContent as Wire;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-workflow-'));
  const worktree = path.join(root, 'repo');
  const runtime = path.join(root, 'runtime');
  mkdirSync(worktree); mkdirSync(runtime);
  git(worktree, 'init', '-b', 'main');
  git(worktree, 'config', 'user.name', 'Fixture');
  git(worktree, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(worktree, 'tracked.txt'), 'baseline\n', 'utf8');
  git(worktree, 'add', 'tracked.txt'); git(worktree, 'commit', '-m', 'baseline');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const checkpoint = path.join(worktree, '.local', 'workflow-state', 'HARNESS-005.md');
  mkdirSync(path.dirname(checkpoint), { recursive: true });
  writeFileSync(checkpoint, `---\nschema_version: 1\nticket: "HARNESS-005 / GitHub #45"\nphase: review\nworktree: "${worktree.replaceAll('\\', '/')}"\nbranch: "main"\nfixed_point: "${head}"\nhead: "${head}"\n---\n`, 'utf8');
  const source = {
    session: () => { throw new Error('No Codex session'); }, runs: () => [], events: () => [],
    attribution: () => ({ state: 'unknown' }),
  };
  const harness = new Harness(runtime, source, undefined, { git: () => 'git' });
  const mcp = createHttpServer({ harness });
  const ui = createHarnessServer(harness);
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'workflow-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`)));
  const home = await fetch(`http://127.0.0.1:${(ui.address() as AddressInfo).port}/`);
  const cookie = home.headers.get('set-cookie')!.split(';')[0];
  return { root, worktree, runtime, head, checkpoint, source, harness, client, mcp, ui, cookie,
    base: `http://127.0.0.1:${(ui.address() as AddressInfo).port}`,
    close: async () => { await client.close(); mcp.close(); mcp.closeAllConnections(); ui.close(); ui.closeAllConnections();
      harness.close(); rmSync(root, { recursive: true, force: true }); } };
}

function snapshot(f: Awaited<ReturnType<typeof fixture>>, phase = 'review'): Wire {
  const at = new Date().toISOString();
  return {
    phase,
    actor: { name: 'Emilia', method: 'deterministic' },
    checkpoint: { artifact_id: 'checkpoint', ticket_key: 'HARNESS-005 / GitHub #45',
      worktree: f.worktree, branch: 'main', fixed_point: f.head, head: f.head, phase, schema_version: 1 },
    subject: { subject_id: 'implementation-1', fixed_point: f.head, head: f.head,
      scope: ['tracked.txt'], staged: [], unstaged: [], untracked: [],
      ticket_ref: 'issue:45', spec_ref: 'docs/specs/yuki-harness-v0.md',
      standards: ['AGENTS.md'], tests: ['node --test test/harness-workflow.test.ts'] },
    artifacts: [{ artifact_id: 'checkpoint', role: 'checkpoint', kind: 'file', location: f.checkpoint,
      revision: sha256(f.checkpoint), source_schema: 'checkpoint-v1', source: 'engineering-workflow',
      observed_at: at, integrity: 'observed' }],
    reviews: [], findings: [],
    acceptance: { acceptance_id: null, status: 'not-recorded', actor: { name: 'Emilia', method: 'deterministic' },
      subject_ref: null, criteria: [], evidence: [], evidence_refs: [], execution_refs: [],
      applicability: 'not-applicable', reason: '尚未验收' },
    closeout: { status: 'pending', artifact_refs: [], evidence: [], applicability: 'not-applicable', reason: '尚未收尾' },
    runtime_refs: [],
  };
}

function checkpointPhase(f: Awaited<ReturnType<typeof fixture>>, phase: string) {
  const current = readFileSync(f.checkpoint, 'utf8');
  writeFileSync(f.checkpoint, current.replace(/^phase: .*$/m, `phase: ${phase}`), 'utf8');
}

test('公开 MCP 记录 Workflow 后，首页与 Ticket 可追溯真实阶段且不自动 accepted', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-005', title: 'Workflow 证据',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  const requestId = randomUUID();
  const firstSnapshot = snapshot(f);
  const recorded = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: requestId, expected_revision: null, schema_version: 1, snapshot: firstSnapshot,
  } });
  assert.equal(recorded.isError, undefined);
  assert.equal(payload(recorded).workflow_revision, 1);
  assert.equal(payload(recorded).applicability.state, 'verified');
  assert.equal(payload(recorded).recording.state, 'recording');

  const projects = await (await fetch(f.base + '/api/projects', { headers: { cookie: f.cookie } })).json() as Wire;
  const summary = projects.projects[0].tickets[0].workflow;
  assert.equal(summary.phase, 'review');
  assert.equal(summary.acceptance.status, 'not-recorded');
  assert.equal(summary.acceptance.accepted, false, 'run/phase progression must never infer Acceptance');

  const detail = await (await fetch(f.base + '/api/tickets/' + ticket.ticket_id, { headers: { cookie: f.cookie } })).json() as Wire;
  assert.equal(detail.ticket.main_conversation_id, ticket.conversation_id);
  assert.equal(detail.workflow.current.revision, 1);
  assert.equal(detail.workflow.current.subject.subject_id, 'implementation-1');
  assert.equal(detail.workflow.current.assessment.state, 'verified');
  assert.ok(detail.records.some((record: Wire) => record.data.kind === 'workflow_snapshot'));
  const page = await (await fetch(f.base + '/tickets/' + ticket.ticket_id, { headers: { cookie: f.cookie } })).text();
  assert.match(page, /Workflow · review/);
  assert.match(page, /尚未验收/);

  const retry = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: requestId, expected_revision: null, schema_version: 1, snapshot: firstSnapshot,
  } }));
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.workflow_revision, 1);
  assert.equal(retry.cursor, payload(recorded).cursor);

  const conflict = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: requestId, expected_revision: null, schema_version: 1,
    snapshot: { ...firstSnapshot, actor: { name: '另一提交者', method: 'deterministic' } },
  } });
  assert.equal(payload(conflict).error.code, 'REQUEST_CONFLICT');
  const oldRevision = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: firstSnapshot,
  } });
  assert.equal(payload(oldRevision).error.code, 'WORKFLOW_REVISION_CONFLICT');

  const other = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话',
    reference: 'issue:46', expected_worktree: f.worktree,
  } }));
  const crossed = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: other.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: firstSnapshot,
  } });
  assert.equal(payload(crossed).error.code, 'ATTRIBUTION_MISMATCH');

  writeFileSync(path.join(f.worktree, 'tracked.txt'), 'changed\n', 'utf8');
  f.harness.scan(true);
  const stale = f.harness.detail(ticket.ticket_id);
  assert.ok(stale.workflow.current);
  assert.equal(stale.workflow.current.assessment.state, 'stale');
  assert.equal(stale.workflow.current.revision, 1, 'fact refresh must not advance submitted revision');
  assert.ok(stale.records.some((record: Wire) => record.data.kind === 'workflow_observation'));
  writeFileSync(path.join(f.worktree, 'tracked.txt'), 'baseline\n', 'utf8');
  f.harness.scan(true);
  const restored = f.harness.detail(ticket.ticket_id);
  assert.ok(restored.workflow.current);
  assert.equal(restored.workflow.current.assessment.state, 'verified');
  assert.ok(restored.workflow.history.length >= 3, 'A→B→A applicability changes must remain observable');

  checkpointPhase(f, 'review');
  const reviewed = snapshot(f);
  reviewed.reviews = [{ review_id: 'review-full', original_review_id: null, mode: 'full', status: 'findings',
    subject_ref: 'implementation-1', artifact_refs: [],
    standards: { status: 'passed', evidence: ['standards-report'], reason: null },
    spec: { status: 'findings', evidence: ['SPEC-1'], reason: '发现一项问题' },
    finding_refs: [{ origin_review_id: 'review-full', finding_id: 'SPEC-1' }], isolated: true,
    applicability: 'verified', reason: null }];
  reviewed.findings = [{ origin_review_id: 'review-full', finding_id: 'SPEC-1', status: 'open', severity: 'P2',
    summary: '需要修复', subject_ref: 'implementation-1', verification_review_id: null, artifact_refs: [],
    evidence: ['review-report'], applicability: 'verified', reason: null }];
  const revision2 = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 1, schema_version: 1, snapshot: reviewed,
  } }));
  assert.equal(revision2.workflow_revision, 2);

  checkpointPhase(f, 'implementation');
  const fixed = snapshot(f, 'implementation');
  fixed.subject.subject_id = 'fix-1';
  fixed.reviews = reviewed.reviews;
  fixed.findings = [{ ...reviewed.findings[0], status: 'fixed', subject_ref: 'fix-1' }];
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 2, schema_version: 1, snapshot: fixed,
  } })).workflow_revision, 3);

  checkpointPhase(f, 'review');
  const verified = snapshot(f);
  verified.subject.subject_id = 'fix-1';
  const focused = { review_id: 'review-focused', original_review_id: 'review-full', mode: 'focused', status: 'passed',
    subject_ref: 'fix-1', artifact_refs: [],
    standards: { status: 'not-applicable', evidence: [], reason: '原 Standards 结论未变' },
    spec: { status: 'passed', evidence: ['focused-report'], reason: null },
    finding_refs: [{ origin_review_id: 'review-full', finding_id: 'SPEC-1' }], isolated: true,
    applicability: 'verified', reason: null };
  verified.reviews = [reviewed.reviews[0], focused];
  verified.findings = [{ ...reviewed.findings[0], status: 'verified', subject_ref: 'fix-1',
    verification_review_id: 'review-focused', evidence: ['review-report', 'focused-report'] }];
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 3, schema_version: 1, snapshot: verified,
  } })).workflow_revision, 4);

  checkpointPhase(f, 'acceptance');
  const accepted = snapshot(f, 'acceptance');
  accepted.subject.subject_id = 'fix-1'; accepted.reviews = verified.reviews; accepted.findings = verified.findings;
  accepted.acceptance = { acceptance_id: 'acceptance-1', status: 'passed', actor: { name: 'Emilia', method: 'deterministic' },
    subject_ref: 'fix-1', criteria: [{ criteria_ref: '#45-AC1', status: 'pass', evidence: ['fixture-public-seam'], notes: null }],
    evidence: ['fixture-public-seam'], evidence_refs: [], execution_refs: [], applicability: 'verified', reason: '逐项核对通过' };
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 4, schema_version: 1, snapshot: accepted,
  } })).workflow_revision, 5);
  const acceptedSummary = f.harness.overview().projects[0].tickets.find(value => value.id === ticket.ticket_id)!.workflow as Wire;
  assert.equal(acceptedSummary.acceptance.accepted, true, JSON.stringify(acceptedSummary));
  assert.equal(acceptedSummary.phase, 'acceptance');

  const protectedSnapshot = snapshot(f);
  protectedSnapshot.artifacts.push({ ...protectedSnapshot.artifacts[0], artifact_id: 'private-git',
    location: path.join(f.worktree, '.git', 'config'), revision: null });
  const protectedResult = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 5, schema_version: 1, snapshot: protectedSnapshot,
  } });
  assert.equal(payload(protectedResult).error.code, 'INVALID_WORKFLOW_RECORD');
  assert.equal((f.harness.workflowHistory.summary(ticket.ticket_id) as Wire).revision, 5);
});

test('重启从 Journal 重建 Workflow revision、幂等回执与主 Conversation', async t => {
  const f = await fixture();
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'restart', project_name: 'restart', ticket_key: 'HARNESS-005', title: '恢复 Workflow',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  const requestId = randomUUID(), value = snapshot(f);
  const first = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: requestId, expected_revision: null, schema_version: 1, snapshot: value,
  } }));
  f.harness.close();
  const restored = new Harness(f.runtime, f.source, undefined, { git: () => 'git' });
  t.after(async () => { restored.close(); await f.close(); });
  const detail = restored.detail(ticket.ticket_id);
  assert.equal(detail.ticket.main_conversation_id, ticket.conversation_id);
  assert.ok(detail.workflow.current);
  assert.equal(detail.workflow.current.revision, 1);
  assert.equal(detail.workflow.current.subject.subject_id, 'implementation-1');
  const retried = restored.recordWorkflow({ ticket_id: ticket.ticket_id, request_id: requestId,
    expected_revision: null, schema_version: 1, snapshot: value });
  assert.equal(retried.deduplicated, true);
  assert.equal(retried.cursor, first.cursor);
});

test('Workflow 副本先脱敏，保存失败不发布新 revision 或未保存结论', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'failure', project_name: 'failure', ticket_key: 'HARNESS-005', title: '保存失败',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  const firstSnapshot = snapshot(f);
  firstSnapshot.actor.name = 'password=fixtureSecretValue';
  const first = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: firstSnapshot,
  } }));
  assert.equal(first.workflow_revision, 1);
  const journal = path.join(f.runtime, 'harness', 'history.jsonl');
  assert.ok(!readFileSync(journal, 'utf8').includes('fixtureSecretValue'));

  const backup = journal + '.saved';
  renameSync(journal, backup); mkdirSync(journal);
  const rejected = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 1, schema_version: 1, snapshot: snapshot(f),
  } });
  assert.equal(payload(rejected).error.code, 'RECORDING_FAILED');
  assert.equal((f.harness.workflowHistory.summary(ticket.ticket_id) as Wire).revision, 1);
  assert.equal(f.harness.health().state, 'recording-failed');
});

test('staged rename 按 porcelain v1 -z 双路径记录核对当前目标路径', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'rename', project_name: 'rename', ticket_key: 'HARNESS-005', title: 'rename subject',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  git(f.worktree, 'mv', 'tracked.txt', 'renamed.txt');
  const value = snapshot(f);
  value.subject.scope = ['renamed.txt'];
  value.subject.staged = [{ path: 'renamed.txt', sha256: sha256(path.join(f.worktree, 'renamed.txt')) }];
  const recorded = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: value,
  } }));
  assert.equal(recorded.workflow_revision, 1);
  assert.equal(recorded.applicability.state, 'verified', JSON.stringify(recorded.applicability));
  assert.ok(!recorded.applicability.reasons.some((reason: Wire) => reason.code === 'SUBJECT_CONTENT_CHANGED'));
});

test('当前 Ticket 的 checkpoint ticket_key 冲突保存为 mismatch，跨票 subject 仍拒绝', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'mismatch', project_name: 'mismatch', ticket_key: 'HARNESS-005', title: 'checkpoint mismatch',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  const value = snapshot(f);
  value.checkpoint.ticket_key = 'HARNESS-999 / local drift';
  const recorded = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: value,
  } }));
  assert.equal(recorded.workflow_revision, 1);
  assert.equal(recorded.applicability.state, 'mismatch');
  assert.ok(recorded.applicability.reasons.some((reason: Wire) => reason.code === 'CHECKPOINT_TICKET_MISMATCH'));
  const detail = await (await fetch(f.base + '/api/tickets/' + ticket.ticket_id, { headers: { cookie: f.cookie } })).json() as Wire;
  assert.equal(detail.workflow.current.assessment.state, 'mismatch');

  const other = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'mismatch', project_name: 'mismatch', ticket_key: 'HARNESS-006', title: 'other ticket',
    reference: 'issue:46', expected_worktree: f.worktree,
  } }));
  const crossed = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: other.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: value,
  } });
  assert.equal(payload(crossed).error.code, 'ATTRIBUTION_MISMATCH');
});

test('deterministic Acceptance 可绑定工程 evidence，Agent 身份只接受真实 Codex run 引用', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'acceptance-evidence', project_name: 'acceptance-evidence', ticket_key: 'HARNESS-005', title: 'Acceptance evidence',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  const value = snapshot(f);
  value.runtime_refs = [
    { runtime_ref_id: 'owned-task-1', kind: 'owned-task', session_id: null, run_id: null,
      task_id: 'task-1', call_id: null, expected_state: null, source: 'harness-owned-task' },
    { runtime_ref_id: 'sync-call-1', kind: 'sync-call', session_id: null, run_id: null,
      task_id: null, call_id: randomUUID(), expected_state: null, source: 'harness-sync-call' },
  ];
  value.acceptance = { acceptance_id: 'acceptance-1', status: 'incomplete',
    actor: { name: 'Emilia', method: 'deterministic' }, subject_ref: 'implementation-1', criteria: [], evidence: ['定向测试'],
    evidence_refs: ['owned-task-1', 'sync-call-1'], execution_refs: [], applicability: 'verified', reason: '尚未逐项完成' };
  const recorded = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: value,
  } }));
  assert.equal(recorded.workflow_revision, 1);

  const forged = snapshot(f);
  forged.runtime_refs = value.runtime_refs;
  forged.acceptance = { ...value.acceptance, actor: { name: 'Acceptance Agent', method: 'agent' },
    evidence_refs: [], execution_refs: ['owned-task-1'] };
  const rejected = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 1, schema_version: 1, snapshot: forged,
  } });
  assert.equal(rejected.isError, true);

  const sessionId = randomUUID(), runId = randomUUID();
  (f.source as Wire).runs = () => [{ id: runId, status: 'completed' }];
  const agent = snapshot(f);
  agent.runtime_refs = [{ runtime_ref_id: 'codex-run-1', kind: 'codex-run', session_id: sessionId, run_id: runId,
    task_id: null, call_id: null, expected_state: 'completed', source: 'codex-session-bridge' }];
  agent.acceptance = { ...value.acceptance, actor: { name: 'Acceptance Agent', method: 'agent' },
    evidence_refs: [], execution_refs: ['codex-run-1'] };
  const agentRecorded = payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 1, schema_version: 1, snapshot: agent,
  } }));
  assert.equal(agentRecorded.workflow_revision, 2);
  assert.equal(agentRecorded.applicability.state, 'verified');
});

test('accepted 要求当前 subject 的内容身份及覆盖它的终态 Review 链', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'accepted-gate', project_name: 'accepted-gate', ticket_key: 'HARNESS-005', title: 'accepted gate',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  checkpointPhase(f, 'acceptance');
  const oldReview = snapshot(f, 'acceptance');
  oldReview.subject.subject_id = 'implementation-2';
  oldReview.reviews = [{ review_id: 'review-full', original_review_id: null, mode: 'full', status: 'passed',
    subject_ref: 'implementation-1', artifact_refs: [],
    standards: { status: 'passed', evidence: ['standards-report'], reason: null },
    spec: { status: 'passed', evidence: ['spec-report'], reason: null }, finding_refs: [], isolated: true,
    applicability: 'verified', reason: null }];
  oldReview.acceptance = { acceptance_id: 'acceptance-1', status: 'passed', actor: { name: 'Emilia', method: 'deterministic' },
    subject_ref: 'implementation-2', criteria: [{ criteria_ref: '#45-AC1', status: 'pass', evidence: ['test'], notes: null }],
    evidence: ['test'], evidence_refs: [], execution_refs: [], applicability: 'verified', reason: '逐项核对通过' };
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: oldReview,
  } })).workflow_revision, 1);
  assert.equal((f.harness.workflowHistory.summary(ticket.ticket_id) as Wire).acceptance.accepted, false);

  const checkpointText = readFileSync(f.checkpoint, 'utf8').replace(/^head: .*$/m, 'head: ');
  writeFileSync(f.checkpoint, checkpointText, 'utf8');
  const missingIdentity = snapshot(f, 'acceptance');
  missingIdentity.subject.subject_id = 'implementation-2';
  missingIdentity.subject.head = null;
  missingIdentity.checkpoint.head = null;
  missingIdentity.reviews = [{ ...oldReview.reviews[0], subject_ref: 'implementation-2' }];
  missingIdentity.acceptance = oldReview.acceptance;
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 1, schema_version: 1, snapshot: missingIdentity,
  } })).workflow_revision, 2);
  const summary = f.harness.workflowHistory.summary(ticket.ticket_id) as Wire;
  assert.equal(summary.assessment.state, 'verified', JSON.stringify(summary.assessment));
  assert.equal(summary.acceptance.accepted, false);
});

test('首页突出 Workflow 异常且不误标正常 Ticket', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'home', project_name: 'home', ticket_key: 'HARNESS-005', title: 'home status',
    reference: 'issue:45', expected_worktree: f.worktree,
  } }));
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot: snapshot(f),
  } })).workflow_revision, 1);
  let home = await (await fetch(f.base + '/', { headers: { cookie: f.cookie } })).text();
  assert.match(home, new RegExp('<li><a href="/tickets/' + ticket.ticket_id));
  assert.doesNotMatch(home, new RegExp('<li class="warning"><a href="/tickets/' + ticket.ticket_id));

  writeFileSync(path.join(f.worktree, 'tracked.txt'), 'changed\n', 'utf8');
  home = await (await fetch(f.base + '/', { headers: { cookie: f.cookie } })).text();
  assert.match(home, /异常待处理：applicability stale/);
  writeFileSync(path.join(f.worktree, 'tracked.txt'), 'baseline\n', 'utf8');

  const open = snapshot(f);
  open.reviews = [{ review_id: 'review-full', original_review_id: null, mode: 'full', status: 'findings',
    subject_ref: 'implementation-1', artifact_refs: [],
    standards: { status: 'passed', evidence: ['standards-report'], reason: null },
    spec: { status: 'findings', evidence: ['SPEC-1'], reason: 'finding' },
    finding_refs: [{ origin_review_id: 'review-full', finding_id: 'SPEC-1' }], isolated: true,
    applicability: 'verified', reason: null }];
  open.findings = [{ origin_review_id: 'review-full', finding_id: 'SPEC-1', status: 'open', severity: 'P2',
    summary: '需要修复', subject_ref: 'implementation-1', verification_review_id: null, artifact_refs: [],
    evidence: ['review-report'], applicability: 'verified', reason: null }];
  open.acceptance = { ...open.acceptance, status: 'incomplete', applicability: 'verified', reason: '未完成' };
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 1, schema_version: 1, snapshot: open,
  } })).workflow_revision, 2);
  home = await (await fetch(f.base + '/', { headers: { cookie: f.cookie } })).text();
  assert.match(home, /异常待处理：Acceptance incomplete · finding open 1/);
  assert.match(home, new RegExp('<li class="warning"><a href="/tickets/' + ticket.ticket_id));

  const fixed = snapshot(f);
  fixed.reviews = open.reviews;
  fixed.findings = [{ ...open.findings[0], status: 'fixed' }];
  fixed.acceptance = { ...fixed.acceptance, status: 'failed', applicability: 'verified', reason: '验收失败' };
  assert.equal(payload(await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 2, schema_version: 1, snapshot: fixed,
  } })).workflow_revision, 3);
  home = await (await fetch(f.base + '/', { headers: { cookie: f.cookie } })).text();
  assert.match(home, /异常待处理：Acceptance failed · finding fixed 1/);
});
