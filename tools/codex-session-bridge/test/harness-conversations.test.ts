import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { Harness } from '../src/harness/harness.ts';
import { createHarnessServer } from '../src/harness/server.ts';
import type { SourceEvent, SourceRun, SourceSession } from '../src/harness/model.ts';
import { closeFixtureResources, createFixtureUi, fixtureCookie } from './fixtures/harness-ui.ts';

type Wire = Record<string, any>;
const payload = (result: Record<string, unknown>) => result.structuredContent as Wire;

function workflow(reviewId: string, sessionId: string, runId: string): Wire {
  return {
    phase: 'review', actor: { name: 'Emilia', method: 'deterministic' },
    checkpoint: { artifact_id: 'checkpoint', ticket_key: 'HARNESS-006', worktree: 'source-not-provided',
      branch: null, fixed_point: null, head: null, phase: 'review', schema_version: 1 },
    subject: { subject_id: 'implementation-1', fixed_point: null, head: null, scope: [], staged: [], unstaged: [],
      untracked: [], ticket_ref: 'issue:46', spec_ref: 'issue:39', standards: ['AGENTS.md'], tests: [] },
    artifacts: [{ artifact_id: 'checkpoint', role: 'checkpoint', kind: 'reference', location: 'checkpoint:HARNESS-006',
      revision: null, source_schema: 'checkpoint-v1', source: 'engineering-workflow', observed_at: null,
      integrity: 'source-not-provided' }],
    reviews: [{ review_id: reviewId, original_review_id: null, mode: 'full', status: 'pending', subject_ref: 'implementation-1',
      subject_identity: null, artifact_refs: [], standards: { status: 'pending', evidence: [], reason: null },
      spec: { status: 'pending', evidence: [], reason: null }, finding_refs: [], isolated: true,
      applicability: 'unknown', reason: null, execution_refs: ['review-run'] }],
    findings: [],
    acceptance: { acceptance_id: null, status: 'not-recorded', actor: { name: 'Emilia', method: 'deterministic' },
      subject_ref: null, criteria: [], evidence: [], evidence_refs: [], execution_refs: [], applicability: 'not-applicable', reason: null },
    closeout: { status: 'pending', artifact_refs: [], evidence: [], applicability: 'not-applicable', reason: null },
    runtime_refs: [{ runtime_ref_id: 'review-run', kind: 'codex-run', session_id: sessionId, run_id: runId,
      task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' }],
  };
}

async function fixture(options: { failAfterConnect?: (root: string, mcp: ReturnType<typeof createHttpServer>,
  ui: ReturnType<typeof createHarnessServer>) => void } = {}) {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-conversations-'));
  let harness: Harness | undefined;
  let mcp: ReturnType<typeof createHttpServer> | undefined;
  let ui: ReturnType<typeof createHarnessServer> | undefined;
  let client: Client | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await closeFixtureResources(client, mcp, ui, harness); }
    finally { rmSync(runtime, { recursive: true, force: true }); }
  };
  try {
  const uiRoot = createFixtureUi(runtime);
  const sessions = new Map<string, SourceSession>(), runs = new Map<string, SourceRun[]>(), events = new Map<string, SourceEvent[]>();
  const addExecution = (message: string, options: { thread?: boolean; priorRun?: boolean } = {}) => {
    const session: SourceSession = { id: randomUUID(), cwd: runtime,
      codex_thread_id: options.thread === false ? null : randomUUID(), permissions: {} };
    const run: SourceRun = { id: randomUUID(), session_id: session.id, created_at: new Date().toISOString(), model: 'fixture',
      reasoning: 'medium', status: 'completed', config_source: 'fixture', timeout_ms: null, exit_code: 0 };
    const threadEvents: SourceEvent[] = options.thread === false ? [] : [{ seq: 0, at: run.created_at,
      session_id: session.id, run_id: run.id, type: 'codex', data: { type: 'thread.started', thread_id: session.codex_thread_id } }];
    const runEvents: SourceEvent[] = [
      ...threadEvents,
      { seq: threadEvents.length, at: run.created_at, session_id: session.id, run_id: run.id, type: 'codex',
        data: { type: 'item.completed', item: { type: 'agent_message', text: message } } },
    ];
    const prior: SourceRun | null = options.priorRun ? { ...run, id: randomUUID(),
      created_at: new Date(Date.parse(run.created_at) - 1000).toISOString() } : null;
    sessions.set(session.id, session); runs.set(session.id, prior ? [prior, run] : [run]); events.set(run.id, runEvents);
    if (prior) events.set(prior.id, []);
    return { session, run };
  };
  const first = addExecution('fresh review evidence');
  const source = { session: (id: string) => { const value = sessions.get(id); if (!value) throw new Error('session unavailable'); return value; },
    runs: (id: string) => runs.get(id) ?? [], events: (run: SourceRun) => events.get(run.id) ?? [],
    attribution: () => ({ state: 'unknown' }) };
  harness = new Harness(runtime, source);
  const mcpServer = createHttpServer({ harness }); mcp = mcpServer;
  const uiServer = createHarnessServer(harness, undefined, { uiRoot }); ui = uiServer;
  await new Promise<void>(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => uiServer.listen(0, '127.0.0.1', resolve));
  client = new Client({ name: 'conversation-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`)));
  options.failAfterConnect?.(runtime, mcpServer, uiServer);
  const base = `http://127.0.0.1:${(uiServer.address() as AddressInfo).port}`;
  const home = await fetch(base), cookie = fixtureCookie(home);
  return { runtime, source, session: first.session, run: first.run, addExecution, harness, client, mcp: mcpServer, ui: uiServer, base, cookie,
    get: async (route: string) => { const response = await fetch(base + route, { headers: { cookie } });
      assert.equal(response.status, 200); return response.json() as Promise<Wire>; },
    close };
  } catch (error) { await close(); throw error; }
}

test('conversation fixture 初始化失败与重复关闭均释放服务和临时目录', async () => {
  let opened: { root: string; mcp: ReturnType<typeof createHttpServer>; ui: ReturnType<typeof createHarnessServer> } | undefined;
  await assert.rejects(fixture({ failAfterConnect: (root, mcp, ui) => {
    opened = { root, mcp, ui }; throw new Error('injected bootstrap failure');
  } }), /injected bootstrap failure/);
  assert.ok(opened);
  assert.equal(opened.mcp.listening, false);
  assert.equal(opened.ui.listening, false);
  assert.equal(existsSync(opened.root), false);

  const f = await fixture();
  assert.match(f.cookie, /^yuki_harness=/);
  await f.close(); await f.close();
  assert.equal(f.mcp.listening, false);
  assert.equal(f.ui.listening, false);
  assert.equal(existsSync(f.runtime), false);
});

test('公开入口把真实 Full Review 记录为独立子 Conversation，且不混入主历史', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话', reference: 'issue:46',
  } }));
  const reviewId = 'review-full-1';
  const recorded = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1,
    snapshot: workflow(reviewId, f.session.id, f.run.id),
  } });
  assert.equal(recorded.isError, undefined);

  const associated = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), session_id: f.session.id, run_id: f.run.id,
    relation: { kind: 'review', review_id: reviewId, participant: 'coordinator' },
  } }));
  assert.ok(associated.conversation_id);
  assert.notEqual(associated.conversation_id, ticket.conversation_id);
  assert.equal(associated.isolation.state, 'verified');

  const detail = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(detail.ticket.main_conversation_id, ticket.conversation_id);
  assert.deepEqual(detail.child_conversations.map((value: Wire) => value.conversation_id), [associated.conversation_id]);
  assert.ok(!JSON.stringify(detail.records).includes('fresh review evidence'));

  const child = await f.get('/api/conversations/' + associated.conversation_id);
  assert.equal(child.parent_conversation_id, ticket.conversation_id);
  assert.equal(child.relation.review_id, reviewId);
  assert.equal(child.isolation.state, 'verified');
  assert.match(JSON.stringify(child.records), /fresh review evidence/);
});

test('focused re-review 与 Agent Acceptance 使用独立子 Conversation，deterministic Acceptance 不创建占位', async t => {
  const f = await fixture(); t.after(f.close);
  const focused = f.addExecution('focused re-review evidence');
  const acceptance = f.addExecution('agent acceptance evidence');
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话', reference: 'issue:46',
  } }));
  const fullId = 'review-full-1', focusedId = 'review-focused-1';
  const snapshot = workflow(fullId, f.session.id, f.run.id);
  snapshot.reviews[0].status = 'findings';
  snapshot.reviews[0].finding_refs = [{ origin_review_id: fullId, finding_id: 'F1' }];
  snapshot.reviews.push({ review_id: focusedId, original_review_id: fullId, mode: 'focused', status: 'pending',
    subject_ref: 'implementation-1', subject_identity: null, artifact_refs: [],
    standards: { status: 'pending', evidence: [], reason: null }, spec: { status: 'pending', evidence: [], reason: null },
    finding_refs: [{ origin_review_id: fullId, finding_id: 'F1' }], isolated: true, applicability: 'unknown', reason: null,
    execution_refs: ['focused-run'] });
  snapshot.findings.push({ origin_review_id: fullId, finding_id: 'F1', status: 'open', severity: 'normal', summary: 'fixture finding',
    subject_ref: 'implementation-1', subject_identity: null, verification_review_id: null, artifact_refs: [], evidence: [],
    applicability: 'unknown', reason: null });
  snapshot.runtime_refs.push({ runtime_ref_id: 'focused-run', kind: 'codex-run', session_id: focused.session.id,
    run_id: focused.run.id, task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' });
  const recorded = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot,
  } });
  assert.equal(recorded.isError, undefined);

  const deterministic = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), session_id: acceptance.session.id, run_id: acceptance.run.id,
    relation: { kind: 'acceptance', acceptance_id: 'acceptance-1' },
  } }));
  assert.equal(deterministic.error.code, 'ATTRIBUTION_MISMATCH');

  const associate = async (session: SourceSession, run: SourceRun, relation: Wire) => payload(await f.client.callTool({
    name: 'harness_associate_child_conversation', arguments: { ticket_id: ticket.ticket_id, request_id: randomUUID(),
      session_id: session.id, run_id: run.id, relation },
  }));
  const fullChild = await associate(f.session, f.run, { kind: 'review', review_id: fullId, participant: 'coordinator' });
  const focusedChild = await associate(focused.session, focused.run,
    { kind: 'review', review_id: focusedId, participant: 'coordinator' });
  assert.notEqual(fullChild.conversation_id, focusedChild.conversation_id);

  snapshot.acceptance = { acceptance_id: 'acceptance-1', status: 'pending', actor: { name: 'Acceptance Agent', method: 'agent' },
    subject_ref: 'implementation-1', criteria: [], evidence: [], evidence_refs: [], execution_refs: ['acceptance-run'],
    applicability: 'unknown', reason: null };
  snapshot.runtime_refs.push({ runtime_ref_id: 'acceptance-run', kind: 'codex-run', session_id: acceptance.session.id,
    run_id: acceptance.run.id, task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' });
  assert.equal((await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: 1, schema_version: 1, snapshot,
  } })).isError, undefined);
  const acceptanceChild = await associate(acceptance.session, acceptance.run,
    { kind: 'acceptance', acceptance_id: 'acceptance-1' });

  const detail = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(detail.child_conversations.length, 3, 'must not invent Standards/Spec placeholders');
  assert.deepEqual(detail.workflow.current.reviews[0].child_conversations.map((value: Wire) => value.participant), ['coordinator']);
  const focusedSummary = detail.child_conversations.find((value: Wire) => value.conversation_id === focusedChild.conversation_id);
  assert.equal(focusedSummary.relation.original_review_id, fullId);
  assert.deepEqual(focusedSummary.relation.finding_refs, [{ origin_review_id: fullId, finding_id: 'F1' }]);
  assert.deepEqual(detail.workflow.current.acceptance.child_conversations.map((value: Wire) => value.conversation_id),
    [acceptanceChild.conversation_id]);
});

test('association 请求幂等、归属冲突与 Journal 重启重建保持一致', async () => {
  const f = await fixture();
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话', reference: 'issue:46',
  } }));
  const reviewId = 'review-full-1';
  assert.equal((await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1,
    snapshot: workflow(reviewId, f.session.id, f.run.id),
  } })).isError, undefined);
  const requestId = randomUUID();
  const input = { ticket_id: ticket.ticket_id, request_id: requestId, session_id: f.session.id, run_id: f.run.id,
    relation: { kind: 'review', review_id: reviewId, participant: 'coordinator' } };
  const first = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: input }));
  const retry = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: input }));
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.cursor, first.cursor);
  const changed = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: {
    ...input, relation: { ...input.relation, participant: 'standards' },
  } }));
  assert.equal(changed.error.code, 'REQUEST_CONFLICT');
  const aliasRequestId = randomUUID();
  const aliasInput = { ...input, request_id: aliasRequestId };
  const alias = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: aliasInput }));
  assert.equal(alias.deduplicated, true);
  assert.equal(alias.cursor, first.cursor);
  const changedAlias = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: {
    ...aliasInput, relation: { ...aliasInput.relation, participant: 'standards' },
  } }));
  assert.equal(changedAlias.error.code, 'REQUEST_CONFLICT');
  const mainConflict = payload(await f.client.callTool({ name: 'harness_attach', arguments: {
    ticket_id: ticket.ticket_id, session_id: f.session.id, run_id: f.run.id,
  } }));
  assert.equal(mainConflict.error.code, 'ATTRIBUTION_CONFLICT');

  await f.client.close(); f.mcp.close(); f.mcp.closeAllConnections(); f.ui.close(); f.ui.closeAllConnections(); f.harness.close();
  const restored = new Harness(f.runtime, f.source);
  try {
    const afterRestart = restored.associateChildConversation(input);
    assert.equal(afterRestart.deduplicated, true);
    assert.equal(afterRestart.conversation_id, first.conversation_id);
    assert.throws(() => restored.associateChildConversation({
      ...aliasInput, relation: { ...aliasInput.relation, participant: 'standards' },
    }), (error: unknown) => (error as { code?: string }).code === 'REQUEST_CONFLICT');
    assert.equal(restored.detail(ticket.ticket_id).child_conversations.length, 1);
    assert.match(JSON.stringify(restored.conversationDetail(first.conversation_id)), /fresh review evidence/);
  } finally { restored.close(); rmSync(f.runtime, { recursive: true, force: true }); }
});

test('Journal append 失败不发布 child relation、binding 或成功回执', async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话', reference: 'issue:46',
  } }));
  const reviewId = 'review-full-1';
  assert.equal((await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1,
    snapshot: workflow(reviewId, f.session.id, f.run.id),
  } })).isError, undefined);
  const journal = path.join(f.runtime, 'harness', 'history.jsonl');
  renameSync(journal, journal + '.saved'); mkdirSync(journal);
  const rejected = payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), session_id: f.session.id, run_id: f.run.id,
    relation: { kind: 'review', review_id: reviewId, participant: 'coordinator' },
  } }));
  assert.equal(rejected.error.code, 'RECORDING_FAILED');
  assert.deepEqual(f.harness.conversations.summary(ticket.ticket_id), []);
  assert.equal([...f.harness.bindings.values()].some(value => value.conversation_id !== ticket.conversation_id), false);
});

test('隔离 assessment 对缺失来源返回 unknown，对 session/run 复用返回 mismatch', async t => {
  const f = await fixture(); t.after(f.close);
  const unknown = f.addExecution('missing thread evidence', { thread: false });
  const reused = f.addExecution('reused session evidence', { priorRun: true });
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话', reference: 'issue:46',
  } }));
  const reviewId = 'review-full-1', snapshot = workflow(reviewId, f.session.id, f.run.id);
  snapshot.reviews[0].participant_execution_refs = [
    { participant: 'standards', runtime_ref_id: 'standards-run' },
    { participant: 'spec', runtime_ref_id: 'spec-run' },
  ];
  snapshot.runtime_refs.push(
    { runtime_ref_id: 'standards-run', kind: 'codex-run', session_id: unknown.session.id, run_id: unknown.run.id,
      task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' },
    { runtime_ref_id: 'spec-run', kind: 'codex-run', session_id: reused.session.id, run_id: reused.run.id,
      task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' },
  );
  assert.equal((await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot,
  } })).isError, undefined);
  const associate = async (execution: { session: SourceSession; run: SourceRun }, participant: string) => payload(await f.client.callTool({
    name: 'harness_associate_child_conversation', arguments: { ticket_id: ticket.ticket_id, request_id: randomUUID(),
      session_id: execution.session.id, run_id: execution.run.id, relation: { kind: 'review', review_id: reviewId, participant } },
  }));
  assert.equal((await associate(unknown, 'standards')).isolation.state, 'unknown');
  assert.equal((await associate(reused, 'spec')).isolation.state, 'mismatch');
});

test('独立 reviewer 只能按 Workflow 声明的 participant 关联 runtime ref', async t => {
  const f = await fixture(); t.after(f.close);
  const standards = f.addExecution('standards evidence');
  const spec = f.addExecution('spec evidence');
  const legacy = f.addExecution('legacy coordinator evidence');
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话', reference: 'issue:46',
  } }));
  const reviewId = 'review-full-1', snapshot = workflow(reviewId, f.session.id, f.run.id);
  snapshot.reviews[0].participant_execution_refs = [
    { participant: 'standards', runtime_ref_id: 'standards-run' },
    { participant: 'spec', runtime_ref_id: 'spec-run' },
  ];
  snapshot.reviews.push({ ...structuredClone(snapshot.reviews[0]), review_id: 'review-legacy',
    execution_refs: ['legacy-run'], participant_execution_refs: undefined });
  snapshot.runtime_refs.push(
    { runtime_ref_id: 'standards-run', kind: 'codex-run', session_id: standards.session.id, run_id: standards.run.id,
      task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' },
    { runtime_ref_id: 'spec-run', kind: 'codex-run', session_id: spec.session.id, run_id: spec.run.id,
      task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' },
    { runtime_ref_id: 'legacy-run', kind: 'codex-run', session_id: legacy.session.id, run_id: legacy.run.id,
      task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' },
  );
  assert.equal((await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot,
  } })).isError, undefined);
  const associate = async (execution: { session: SourceSession; run: SourceRun }, participant: 'coordinator' | 'standards' | 'spec',
    targetReviewId = reviewId) =>
    payload(await f.client.callTool({ name: 'harness_associate_child_conversation', arguments: {
      ticket_id: ticket.ticket_id, request_id: randomUUID(), session_id: execution.session.id, run_id: execution.run.id,
      relation: { kind: 'review', review_id: targetReviewId, participant },
    } }));

  assert.equal((await associate(spec, 'standards')).error.code, 'ATTRIBUTION_MISMATCH');
  assert.equal((await associate(standards, 'spec')).error.code, 'ATTRIBUTION_MISMATCH');
  assert.ok((await associate(standards, 'standards')).conversation_id);
  assert.equal((await associate(legacy, 'standards', 'review-legacy')).error.code, 'ATTRIBUTION_MISMATCH');
  assert.ok((await associate(legacy, 'coordinator', 'review-legacy')).conversation_id);
});

test('同一 session 不因绑定顺序而跨 child Conversation 复用', async t => {
  const f = await fixture(); t.after(f.close);
  const laterFirst = f.addExecution('later run bound first', { priorRun: true });
  const earlierFirst = f.addExecution('earlier run bound first', { priorRun: true });
  const continuation = f.addExecution('same conversation continuation', { priorRun: true });
  const ticket = payload(await f.client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'yuki-link', project_name: 'yuki-link', ticket_key: 'HARNESS-006', title: 'Review 子会话', reference: 'issue:46',
  } }));
  const snapshot = workflow('review-a', f.session.id, f.run.id);
  const addReviewExecution = (reviewId: string, runtimeRefId: string, session: SourceSession, run: SourceRun) => {
    snapshot.reviews.push({ ...structuredClone(snapshot.reviews[0]), review_id: reviewId, execution_refs: [runtimeRefId] });
    snapshot.runtime_refs.push({ runtime_ref_id: runtimeRefId, kind: 'codex-run', session_id: session.id, run_id: run.id,
      task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' });
  };
  const laterFirstPrior = f.source.runs(laterFirst.session.id)[0];
  const earlierFirstPrior = f.source.runs(earlierFirst.session.id)[0];
  addReviewExecution('review-b', 'later-current', laterFirst.session, laterFirst.run);
  addReviewExecution('review-c', 'later-prior', laterFirst.session, laterFirstPrior);
  addReviewExecution('review-d', 'earlier-prior', earlierFirst.session, earlierFirstPrior);
  addReviewExecution('review-e', 'earlier-current', earlierFirst.session, earlierFirst.run);
  const continuationPrior = f.source.runs(continuation.session.id)[0];
  snapshot.reviews.push({ ...structuredClone(snapshot.reviews[0]), review_id: 'review-f',
    execution_refs: ['continuation-prior', 'continuation-current'] });
  snapshot.runtime_refs.push(
    { runtime_ref_id: 'continuation-prior', kind: 'codex-run', session_id: continuation.session.id,
      run_id: continuationPrior.id, task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' },
    { runtime_ref_id: 'continuation-current', kind: 'codex-run', session_id: continuation.session.id,
      run_id: continuation.run.id, task_id: null, call_id: null, expected_state: 'completed', source: 'bridge durable run' },
  );
  assert.equal((await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: ticket.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot,
  } })).isError, undefined);
  const associate = async (execution: { session: SourceSession; run: SourceRun }, reviewId: string) => payload(await f.client.callTool({
    name: 'harness_associate_child_conversation', arguments: { ticket_id: ticket.ticket_id, request_id: randomUUID(),
      session_id: execution.session.id, run_id: execution.run.id,
      relation: { kind: 'review', review_id: reviewId, participant: 'coordinator' } },
  }));

  assert.ok((await associate(laterFirst, 'review-b')).conversation_id);
  assert.equal((await associate({ session: laterFirst.session, run: laterFirstPrior }, 'review-c')).error.code,
    'ATTRIBUTION_CONFLICT');
  assert.ok((await associate({ session: earlierFirst.session, run: earlierFirstPrior }, 'review-d')).conversation_id);
  assert.equal((await associate(earlierFirst, 'review-e')).error.code, 'ATTRIBUTION_CONFLICT');
  const continuedFrom = await associate({ session: continuation.session, run: continuationPrior }, 'review-f');
  const continuedTo = await associate(continuation, 'review-f');
  assert.equal(continuedTo.conversation_id, continuedFrom.conversation_id);
  assert.notEqual(continuedTo.binding_id, continuedFrom.binding_id);
});
