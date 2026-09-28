import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/harness/journal.ts';
import { ExecutionOperations } from '../src/orchestration/execution-operations.ts';
import { ConversationHistory } from '../src/harness/conversations.ts';
import { subjectIdentity } from '../src/harness/workflow.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: test.TestContext) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'work-item-contract-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const ticket = { id: randomUUID(), main_conversation_id: randomUUID() };
  const sessions = new Map<string, any>(), runs = new Map<string, any>(), requests = new Map<string, any>();
  const content: any = { scheme: 'yuki-git-subject', version: 1, scope: {}, completeness: 'complete', digest: 'sha256:' + 'a'.repeat(64) };
  const workflow: any = { workflow_revision: 1, snapshot: { subject: { subject_id: 'subject', head: 'a'.repeat(40),
    staged: [], unstaged: [], untracked: [] }, findings: [], reviews: [] } };
  const source: any = { session: (id: string) => sessions.get(id), runs: (id: string) => [...runs.values()].filter(r => r.session_id === id),
    lookupRequest: (id: string) => requests.get(id), activeRuns: () => [...runs.values()].filter(r => r.status === 'running') };
  const dependencies: any = { ticket: () => ticket, source, bindings: new Map(), health: () => ({ state: 'recording', reason: null }),
    assessWorkflow: () => ({ state: 'verified' }),
    workflow: () => workflow, currentIdentity: () => content };
  let operations = new ExecutionOperations(new Journal(cwd), dependencies);
  let counter = 0;
  const input = (action = 'ticket-design', ref?: any): any => ({ ticket_id: ticket.id, request_id: 'request-' + (++counter),
    ...(ref ? { work_item: { work_item_id: ref.work_item_id, revision: ref.revision } } : {}),
    destination: action.includes('review') ? { kind: 'child', relation: { kind: 'review', review_id: 'review', participant: 'coordinator' } }
      : { kind: 'main' }, expected_workflow_revision: workflow.workflow_revision, subject_ref: 'subject', content_identity: { ...content },
    launch: { cwd, prompt: 'execute current work item', sender: 'orchestrator', model: 'fixture', reasoning: 'low', timeout_ms: null, permissions: null },
    authorization_boundary: { schema_version: 1, policy_id: 'policy', decision_ref: 'owner:scope', concurrency: { mode: 'single-line', decision_ref: null } },
    workflow_agent: { caller_fingerprint: hash('caller'), action,
      contract: { schema_version: 1, session: 'fresh', destination: action.includes('review') ? 'review-child' : 'main', review_policy: null },
      policy: { schema_version: 1, policy_id: 'policy', revision: 1, digest: hash('policy'), project_key: 'project', action,
        workflow_phase: action, model: 'fixture', reasoning: 'low', permission_selection: 'owner-native-default',
        preflight: { require_recording: true, model_line: 'single', required_paths: [], required_executables: [], dependency_packages: [] } },
      authorization: { schema_version: 1, authorization_id: 'authority', ticket_key: 'delivery', action,
        authorization_ref: 'owner:scope', subject_ref: 'subject', subject_identity: null, authority_refs: ['owner'],
        ...(action === 'finding-fix' || action === 'focused-review' ? { finding: { origin_review_id: 'review', finding_id: 'issue',
          report_ref: 'report.md', fix_baseline: 'baseline' } } : {}), ...(action.includes('review') ? { review_id: 'review' } : {}) },
      authority_source: { schema_version: 1, kind: 'adapter', reference: 'trusted-adapter', canonical_path: null, sha256: hash('authority') },
      prompt_context: { references: ['scope.md'], current_delta: [] },
      preflight: { workflow_revision: 1, subject_ref: 'subject', subject_identity: null, environment: { required_paths: [], required_executables: [] } } } });
  const begin = (request: any, bind = true) => {
    const reserved = operations.reserve(request);
    const session_id = reserved.continuation_session_id ?? randomUUID(), run_id = randomUUID();
    const fingerprint = hash(reserved.runtime.request_id);
    operations.guardDispatch(reserved.operation_id, { request_id: reserved.runtime.request_id, fingerprint, cwd,
      ...(reserved.execution_mode === 'continue' ? { session_id } : {}), config: { model: 'fixture', reasoning: 'low' },
      permissions: { sandbox_mode: 'danger-full-access' }, launch: { prompt_sha256: hash(request.launch.prompt),
        prompt_utf8_bytes: Buffer.byteLength(request.launch.prompt), sender: 'orchestrator', model: 'fixture', reasoning: 'low',
        timeout_ms: null, permission_selection: null } });
    sessions.set(session_id, { id: session_id, cwd, codex_thread_id: randomUUID(), permissions: { sandbox_mode: 'danger-full-access' } });
    runs.set(run_id, { id: run_id, session_id, status: 'running' });
    requests.set(reserved.runtime.request_id, { request_id: reserved.runtime.request_id, fingerprint, session_id, run_id, status: 'running' });
    if (!bind) return operations.requireReconciliation(reserved.operation_id, 'LOST_RESPONSE', 'response was interrupted');
    operations.markStarted(reserved.operation_id);
    return operations.bind(reserved.operation_id);
  };
  const finish = () => { for (const run of runs.values()) run.status = 'completed'; for (const request of requests.values()) request.status = 'completed'; };
  const decision = (item: any, action: string) => ({ decision_ref: 'owner:decision', work_item_id: item.work_item_id,
    expected_revision: item.revision, workflow_revision: workflow.workflow_revision, subject_ref: 'subject',
    content_version: content.digest, action, evidence_refs: ['verified-handoff.md'] });
  return { input, begin, finish, decision, content, workflow, sessions, runs, requests, dependencies,
    get operations() { return operations; }, restart: () => { operations = new ExecutionOperations(new Journal(cwd), dependencies); } };
}

test('restart recovers generation ownership and normal content evolution continues it', t => {
  const f = fixture(t), first = f.begin(f.input()); f.finish(); f.restart();
  assert.equal(f.operations.workItems.get(first.work_item!.work_item_id).state, 'active');
  f.content.digest = 'sha256:' + 'b'.repeat(64);
  const next = f.begin(f.input('ticket-design', first.work_item));
  assert.equal(next.runtime.session_id, first.runtime.session_id);
  assert.equal(next.work_item!.content_version, f.content.digest);
});

test('active, unknown, revision, authority and renamed subject cannot create replacement work', t => {
  const f = fixture(t), first = f.begin(f.input());
  assert.throws(() => f.begin(f.input('ticket-design', first.work_item)), { code: 'DESTINATION_BUSY' });
  f.finish();
  assert.throws(() => f.begin(f.input()), { code: 'WORK_ITEM_REVISION_CONFLICT' });
  const stale = f.input('ticket-design', { ...first.work_item, revision: 1 });
  assert.throws(() => f.begin(stale), { code: 'WORK_ITEM_REVISION_CONFLICT' });
  const changedAuthority = f.input('ticket-design', first.work_item);
  changedAuthority.workflow_agent.authorization.authorization_ref = 'different';
  assert.throws(() => f.begin(changedAuthority), { code: 'WORK_ITEM_AUTHORITY_CONFLICT' });
  const renamed = f.input(); renamed.subject_ref = 'renamed';
  assert.throws(() => f.begin(renamed), { code: 'WORK_ITEM_SCOPE_CONFLICT' });
  f.runs.get(first.runtime.run_id).status = 'unknown';
  assert.throws(() => f.begin(f.input('ticket-design', first.work_item)), { code: 'DESTINATION_BUSY' });
});

test('role transitions need handoff evidence and primary review has its own session', t => {
  const f = fixture(t), design = f.begin(f.input()); f.finish();
  assert.throws(() => f.begin(f.input('implementation')), { code: 'WORK_ITEM_PREDECESSOR_INCOMPLETE' });
  assert.throws(() => f.operations.transitionWorkItem({ ...f.decision(design.work_item, 'complete'), evidence_refs: [] }));
  f.operations.transitionWorkItem(f.decision(design.work_item, 'complete'));
  const implementation = f.begin(f.input('implementation')); f.finish();
  f.operations.transitionWorkItem(f.decision(implementation.work_item, 'complete'));
  const review = f.begin(f.input('review'));
  assert.notEqual(review.runtime.session_id, implementation.runtime.session_id);
  assert.notEqual(implementation.runtime.session_id, design.runtime.session_id);
  assert.equal(review.work_item!.purpose, 'primary-review');
  assert.ok(review.work_item!.parent_refs.includes(implementation.work_item!.work_item_id));
});

test('unfinished focused round cannot silently switch the content under review', t => {
  const f = fixture(t), first = f.begin(f.input('focused-review')); f.finish();
  f.content.digest = 'sha256:' + 'b'.repeat(64);
  assert.throws(() => f.begin(f.input('focused-review', first.work_item)), { code: 'WORK_ITEM_REVIEW_ROUND_CONFLICT' });
});

test('retired generation cannot be continued and request/content conflicts fail closed', t => {
  const f = fixture(t), request = f.input(), first = f.begin(request); f.finish();
  assert.throws(() => f.operations.reserve({ ...request, launch: { ...request.launch, prompt: 'different' } }), { code: 'REQUEST_CONFLICT' });
  const retired = f.operations.transitionWorkItem(f.decision(first.work_item, 'retire-generation'));
  const second = f.begin(f.input('ticket-design', retired));
  assert.equal(second.execution_mode, 'replace');
  assert.notEqual(second.runtime.session_id, first.runtime.session_id);
  assert.equal(second.work_item!.generations[0].state, 'retired');
});

test('a different destination still obeys the single model line invariant', t => {
  const f = fixture(t); f.begin(f.input());
  assert.throws(() => f.begin(f.input('review')), { code: 'MODEL_LINE_BUSY' });
});

test('scope split requires trusted parent linkage; arbitrary work item identifiers cannot fork work', t => {
  const f = fixture(t), first = f.begin(f.input()); f.finish();
  assert.throws(() => f.begin(f.input('ticket-design', { work_item_id: randomUUID(), revision: 1 })),
    { code: 'WORK_ITEM_IDENTITY_CONFLICT' });
  const independent = f.input();
  independent.workflow_agent.authorization.work_item_scope = { scope_ref: 'independent-risk',
    parent_work_item_id: first.work_item!.work_item_id, decision_ref: 'owner:separate-risk' };
  const second = f.begin(independent);
  assert.notEqual(second.work_item!.work_item_id, first.work_item!.work_item_id);
  assert.deepEqual(second.work_item!.parent_refs, [first.work_item!.work_item_id]);
  assert.equal(second.execution_mode, 'fresh');
});

test('raw calls cannot continue managed or retired sessions even with a diagnostic grant', t => {
  const f = fixture(t), first = f.begin(f.input()); f.finish();
  const raw = { session_id: first.runtime.session_id, request_id: 'raw-bypass', prompt: 'bypass' };
  const grant = { authority_digest: 'a'.repeat(64), authorization_ref: 'owner:diagnostic',
    action: 'send', category: 'diagnostic', reason: 'fixture' };
  assert.throws(() => f.operations.reserveRaw(raw, grant), { code: 'MANAGED_SESSION_REQUIRES_WORK_ITEM_GATE' });
});

test('restart reconciles an exact accepted runtime request without replacement execution', t => {
  const f = fixture(t), interrupted = f.begin(f.input(), false); f.finish(); f.restart();
  const ref = { work_item_id: interrupted.work_item!.work_item_id, revision: interrupted.work_item!.revision };
  const reconciled = f.operations.reconcileWorkItem(ref);
  assert.equal(reconciled.state, 'bound');
  assert.equal(f.runs.size, 1);
  const next = f.begin(f.input('ticket-design', reconciled.work_item));
  assert.equal(next.runtime.session_id, reconciled.runtime.session_id);
  assert.equal(next.work_item!.generation, 1);
});

test('review continuation is isolated only when all session runs have the same durable owner', t => {
  const f = fixture(t);
  const conversations = new ConversationHistory(f.operations.journal, f.dependencies.source, {} as any,
    f.dependencies.ticket, f.dependencies.bindings);
  f.dependencies.assessChild = (session: string, run: string, conversation: string) =>
    conversations.assessExecution(session, run, conversation);
  f.dependencies.source.events = (run: any) => [{ type: 'codex', data: {
    type: 'thread.started', thread_id: f.sessions.get(run.session_id).codex_thread_id } }];
  const first = f.begin(f.input('focused-review')); f.finish();
  f.runs.get(first.runtime.run_id).created_at = '2026-01-01T00:00:00.000Z';
  // Supply an ordered runtime view, as the real runtime adapter does.
  f.dependencies.source.runs = (id: string) => [...f.runs.values()].filter(run => run.session_id === id)
    .map(run => ({ ...run, created_at: run.created_at ?? '2026-01-01T00:01:00.000Z' }));
  const second = f.begin(f.input('focused-review', first.work_item)); f.finish();
  assert.equal(second.destination.kind === 'child' && second.destination.isolation.state, 'verified');
  f.restart();
  const restored = new ConversationHistory(f.operations.journal, f.dependencies.source, {} as any,
    f.dependencies.ticket, f.dependencies.bindings);
  assert.equal(restored.assessExecution(second.runtime.session_id!, second.runtime.run_id!,
    second.destination.conversation_id).state, 'verified');
  f.runs.set('unowned', { id: 'unowned', session_id: first.runtime.session_id, status: 'completed',
    created_at: '2026-01-01T00:00:30.000Z' });
  assert.equal(restored.assessExecution(second.runtime.session_id!, second.runtime.run_id!,
    second.destination.conversation_id).state, 'mismatch');
});

test('changing review cycle cannot skip an unfinished work item', t => {
  const f = fixture(t); f.begin(f.input('finding-fix')); f.finish();
  assert.throws(() => f.begin(f.input('review')), { code: 'WORK_ITEM_PREDECESSOR_INCOMPLETE' });
  assert.throws(() => f.begin(f.input('focused-review')), { code: 'WORK_ITEM_PREDECESSOR_INCOMPLETE' });
});

test('verified issues stay in the durable set when the remaining repair batch continues', t => {
  const f = fixture(t), request = f.input('finding-fix');
  const issue = request.workflow_agent.authorization.finding;
  delete request.workflow_agent.authorization.finding;
  request.workflow_agent.authorization.finding_batch = [issue, { ...issue, finding_id: 'second' }];
  const first = f.begin(request); f.finish();
  const second = f.begin(f.input('finding-fix', first.work_item));
  assert.equal(second.execution_mode, 'continue');
  assert.deepEqual(second.work_item!.issue_set, ['review:issue', 'review:second']);
});

test('review completion cannot borrow another review report for the same subject', t => {
  const f = fixture(t), first = f.begin(f.input('review')); f.finish();
  f.workflow.snapshot.reviews = [{ review_id: 'unrelated', status: 'passed', isolated: true,
    applicability: 'verified', subject_ref: 'subject' }];
  assert.throws(() => f.operations.transitionWorkItem({ ...f.decision(first.work_item, 'complete'),
    review_id: 'unrelated' }), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
});

test('primary completion requires managed execution references and current isolation; continuation remains valid', t => {
  const f = fixture(t);
  const conversations = new ConversationHistory(f.operations.journal, f.dependencies.source, {} as any,
    f.dependencies.ticket, f.dependencies.bindings);
  f.dependencies.assessChild = (session: string, run: string, conversation: string) => conversations.assessExecution(session, run, conversation);
  f.dependencies.source.events = (run: any) => [{ type: 'codex', data: {
    type: 'thread.started', thread_id: f.sessions.get(run.session_id).codex_thread_id } }];
  const first = f.begin(f.input('review')); f.finish();
  const second = f.begin(f.input('review', first.work_item)); f.finish();
  f.workflow.snapshot.artifacts = [{ artifact_id: 'report', role: 'review-report', kind: 'file', revision: hash('report') }];
  f.workflow.snapshot.runtime_refs = [{ runtime_ref_id: 'run', kind: 'codex-run', session_id: second.runtime.session_id, run_id: second.runtime.run_id }];
  const report = { review_id: 'review', mode: 'full', status: 'passed', isolated: true, applicability: 'verified',
    subject_ref: 'subject', subject_identity: subjectIdentity(f.workflow.snapshot.subject), artifact_refs: ['report'], execution_refs: [] as string[] };
  f.workflow.snapshot.reviews = [report];
  const decision = { ...f.decision(second.work_item, 'complete'), review_id: 'review' };
  assert.throws(() => f.operations.transitionWorkItem(decision), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
  report.execution_refs = ['run'];
  const events = f.dependencies.source.events; f.dependencies.source.events = () => [];
  assert.throws(() => f.operations.transitionWorkItem(decision), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
  f.dependencies.source.events = events;
  assert.equal(f.operations.transitionWorkItem(decision).state, 'completed');
});
