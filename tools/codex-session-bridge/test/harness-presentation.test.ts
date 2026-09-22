import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Harness } from '../src/harness/harness.ts';
import { Presentation, projectRecord } from '../src/harness/presentation.ts';
import type { RecordEntry, Source, SourceRun } from '../src/harness/model.ts';
import { mergePage, captureAnchor, restoreAnchor } from '../ui/conversation-state.ts';
import type { ConversationPage } from '../src/harness/presentation-model.ts';
import { groupConversation } from '../ui/conversation-reading.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-presentation-'));
  const runs: SourceRun[] = [];
  const source: Source = { session: () => { throw new Error('offline'); }, runs: sessionId => runs.filter(run => run.session_id === sessionId), events: () => [], attribution: () => null };
  const harness = new Harness(root, source), p = new Presentation(harness);
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  const ticket = harness.register({ project_key: 'fixture', project_name: '工程', ticket_key: '012', title: '产品化', reference: 'fixture' });
  function event(kind: string, payload: unknown, id = ticket.conversation_id,
    refs: Partial<{ binding_id: string; session_id: string; run_id: string; thread_id: string | null }> = {}) {
    return harness.journal.append({ kind: 'event', event: { ticket_id: ticket.ticket_id, conversation_id: id,
      binding_id: randomUUID(), session_id: randomUUID(), run_id: randomUUID(), thread_id: null,
      source_seq: null, source_at: null, kind, payload,
      integrity: { source_redaction: 'unknown', redacted: false, truncated: 'unknown' }, ...refs } });
  }
  return { harness, p, ticket, event, runs };
}
test('projection maps messages/tools/lifecycle and preserves protected unknown records without mutation', t => {
  const f = fixture(t);
  const a = projectRecord(f.event('codex', { type: 'item.completed', item: { type: 'agent_message', text: '已完成 **实现**' } }));
  assert.equal(a.kind, 'message'); assert.equal(a.participant.role, 'engineer'); assert.equal(a.participant.provider, 'Codex');
  const tool = projectRecord(f.event('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'node --test', aggregated_output: 'passed' } }));
  assert.equal(tool.kind, 'tool'); if (tool.kind === 'tool') assert.equal(tool.content.output, 'passed');
  assert.equal(projectRecord(f.event('message.sent', { sender: 'Coordinator', text: '开始' })).participant.label, 'Coordinator');
  assert.equal(projectRecord(f.event('codex', { type: 'turn.completed' })).kind, 'lifecycle');
  const unknown = f.event('future-provider-event', { text: 'kept', marker: 'safe' });
  // Re-protection also covers historical records collected under an older policy.
  const historical: RecordEntry = { ...unknown, data: { ...unknown.data } };
  if (historical.data.kind === 'event') historical.data.event = { ...historical.data.event, payload: { text: 'Authorization: Bearer fixture-secret-value-123456' } };
  const projected = projectRecord(historical);
  assert.equal(projected.kind, 'unknown'); assert.equal(projected.cursor, historical.cursor);
  assert.equal(projected.integrity.redacted, true); assert.doesNotMatch(JSON.stringify(projected), /fixture-secret-value/);
  assert.match(JSON.stringify(historical), /fixture-secret-value/);
  assert.ok(projected.sourceRefs.some(r => r.kind === 'record' && r.id === historical.event_id));
});
test('conversation projects persisted run model and refreshes deduplicated whole-history usage', t => {
  const f = fixture(t), sessionId = randomUUID(), runId = randomUUID();
  f.runs.push({ id: runId, session_id: sessionId, created_at: new Date().toISOString(), model: 'gpt-5.6-sol', reasoning: 'medium',
    status: 'completed', config_source: 'fixture', timeout_ms: null, exit_code: 0 });
  f.event('codex', { type: 'item.completed', item: { type: 'agent_message', text: '完成' } }, f.ticket.conversation_id,
    { session_id: sessionId, run_id: runId });
  const first = f.p.conversation(f.ticket.conversation_id);
  const message = first.items.find(item => item.kind === 'message')!;
  assert.equal(message.participant.label, 'Sylvia'); assert.equal(message.participant.provider, 'Codex');
  assert.equal(message.participant.model, 'gpt-5.6-sol');
  assert.deepEqual(first.usage, { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });

  f.event('codex', { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 40 } },
    f.ticket.conversation_id, { session_id: sessionId, run_id: runId });
  f.event('codex', { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 40 } },
    f.ticket.conversation_id, { session_id: sessionId, run_id: runId });
  for (let i = 0; i < 60; i++) f.event('future', { i });
  const refreshed = f.p.conversation(f.ticket.conversation_id, { after: first.page.last_cursor! });
  assert.deepEqual(refreshed.usage, { total_tokens: 125, input_tokens: 100, output_tokens: 25, cached_input_tokens: 40 });
  assert.deepEqual(mergePage(first, refreshed, 'after').usage, refreshed.usage);

  const legacyRunId = randomUUID();
  f.event('codex', { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }, f.ticket.conversation_id,
    { session_id: sessionId, run_id: legacyRunId });
  assert.deepEqual(f.p.conversation(f.ticket.conversation_id).usage,
    { total_tokens: 132, input_tokens: 105, output_tokens: 27, cached_input_tokens: 40 });
});
test('main and child histories share exclusive latest/before/after pagination and global high water', t => {
  const f = fixture(t), childId = randomUUID();
  f.harness.conversations.conversations.set(childId, { conversation_id: childId, ticket_id: f.ticket.ticket_id,
    parent_conversation_id: f.ticket.conversation_id, relation: { kind: 'review', review_id: 'r', participant: 'coordinator' }, created_at: new Date().toISOString() });
  for (let i = 0; i < 125; i++) { f.event('future', { n: i }); f.event('future', { n: i }, childId); }
  for (const id of [f.ticket.conversation_id, childId]) {
    const latest = f.p.conversation(id);
    assert.equal(latest.items.length, 50); assert.equal(latest.page.has_older, true); assert.equal(latest.page.has_newer, false);
    const before = f.p.conversation(id, { before: latest.page.first_cursor! });
    assert.equal(before.items.length, 50); assert.ok(before.items.at(-1)!.cursor < latest.items[0].cursor);
    const merged = mergePage(latest, before, 'before'); assert.equal(merged.items.length, 100);
    assert.equal(mergePage(merged, before, 'before').items.length, 100);
    f.event('future', { n: 'new' }, id);
    const after = f.p.conversation(id, { after: latest.page.last_cursor! }); assert.equal(after.items.length, 1);
    assert.equal(after.page.high_water_cursor, f.harness.journal.records.at(-1)!.cursor);
    assert.throws(() => f.p.conversation(id, { before: 2, after: 1 }), /INVALID_CURSOR/);
    assert.throws(() => f.p.conversation(id, { limit: 101 }), /INVALID_CURSOR/);
    assert.throws(() => f.p.conversation(id, { after: Number.MAX_SAFE_INTEGER }), /INVALID_CURSOR/);
  }
});
test('prepend anchor preserves the first visible row pixel offset; append merge keeps oldest boundary', () => {
  let offset = -20;
  const row = { dataset: { itemId: 'visible' }, getBoundingClientRect: () => ({ top: offset + 100, bottom: offset + 200 }) };
  const container = { scrollTop: 50, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => [row] } as unknown as HTMLElement;
  const anchor = captureAnchor(container)!; assert.deepEqual(anchor, { kind: 'item', id: 'visible', offset: -20 });
  offset += 380; restoreAnchor(container, anchor); assert.equal(container.scrollTop, 430);
  const page: ConversationPage = { id: 'c', ticket_id: 't', items: [], usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }, page: { first_cursor: null, last_cursor: null, high_water_cursor: 1, has_older: true, has_newer: false } };
  assert.equal(mergePage(page, { ...page, page: { ...page.page, has_older: false } }, 'after').page.has_older, true);
});

test('computer started/result projection retains atomic evidence and counts stable call identity once', async t => {
  const f = fixture(t);
  await f.harness.computerCalls.run('powershell', f.ticket.ticket_id, { command: 'fixture command' }, () => ({ stdout: 'fixture output', exit_code: 0 }));
  const records = f.p.conversation(f.ticket.conversation_id).items.filter(i => i.auxiliary);
  assert.equal(records.length, 2);
  assert.equal(records[0].auxiliary!.operationId, records[1].auxiliary!.operationId);
  assert.equal(records[0].auxiliary!.category, 'command');
  const [group] = groupConversation(records);
  assert.equal(group.kind, 'auxiliary-group'); if (group.kind !== 'auxiliary-group') return;
  assert.equal(group.count, 1); assert.equal(group.countKind, 'calls'); assert.equal(group.status, 'succeeded');
  assert.ok(group.members[0].kind === 'tool' && group.members[0].content.command === 'fixture command');
  assert.ok(group.members[1].kind === 'tool' && group.members[1].content.output === 'fixture output');
  await f.harness.computerCalls.run('powershell', f.ticket.ticket_id, {}, () => ({ stdout: '', stderr: 'diagnostic evidence', exit_code: 2 }));
  const bad = f.p.conversation(f.ticket.conversation_id).items.at(-1)!;
  assert.equal(bad.auxiliary!.status, 'succeeded'); // Transport success does not erase execution diagnostics.
  assert.deepEqual(bad.auxiliary!.issues, ['退出码 2', 'stderr 诊断']);
  assert.ok(JSON.stringify(bad.rawEvidence).includes('diagnostic evidence'));
});

test('provider projection gives trusted auxiliary identities for observation and recovery', t => {
  const f = fixture(t);
  const command = projectRecord(f.event('codex', { type: 'item.completed', item: { id: 'i1', type: 'command_execution', status: 'completed', exit_code: 1 } }));
  assert.equal(command.auxiliary!.operationId, 'i1'); assert.equal(command.auxiliary!.status, 'completed');
  assert.deepEqual(command.auxiliary!.issues, ['退出码 1']);
  const refs = { binding_id: randomUUID(), session_id: randomUUID(), run_id: randomUUID(), thread_id: randomUUID() };
  const observation = projectRecord(f.event('source.snapshot', { run: { status: 'running' }, attribution: { state: 'matched' } }, f.ticket.conversation_id, refs));
  assert.equal(observation.auxiliary!.family, 'run-observation'); assert.ok(observation.auxiliary!.scope);
  const recovery = projectRecord(f.event('recovery.observed', {}, f.ticket.conversation_id, refs));
  assert.equal(recovery.auxiliary!.family, 'recovery'); assert.ok(recovery.auxiliary!.scope);
  assert.notEqual(observation.auxiliary!.family, recovery.auxiliary!.family);
  const recoveryAgain = projectRecord(f.event('recovery.observed', {}, f.ticket.conversation_id, refs));
  assert.equal(groupConversation([recovery, recoveryAgain]).length, 1);
  const otherRun = projectRecord(f.event('source.snapshot', { run: { status: 'running' } }, f.ticket.conversation_id, { ...refs, run_id: randomUUID() }));
  assert.notEqual(observation.auxiliary!.scope, otherRun.auxiliary!.scope);
  const mismatch = projectRecord(f.event('source.snapshot', { run: { status: 'running' }, attribution: { state: 'attribution mismatch' } }, f.ticket.conversation_id, refs));
  assert.deepEqual(mismatch.auxiliary!.issues, ['归属不匹配']);
  assert.equal(projectRecord(f.event('future-event', {})).auxiliary, undefined);
  assert.deepEqual(projectRecord(f.event('stderr', { text: 'warning details' })).auxiliary!.issues, ['stderr 诊断']);
});

test('turn.failed is an issue boundary whose closed summary cannot be overwritten by later lifecycle state', t => {
  const f = fixture(t);
  const refs = { binding_id: randomUUID(), session_id: randomUUID(), run_id: randomUUID(), thread_id: randomUUID() };
  const records = ['turn.started', 'turn.failed', 'turn.started']
    .map(type => projectRecord(f.event('codex', { type }, f.ticket.conversation_id, refs)));

  const rows = groupConversation(records);
  assert.equal(rows.length, 3);
  const failure = rows[1];
  assert.equal(failure.kind, 'auxiliary-group');
  if (failure.kind !== 'auxiliary-group') return;
  assert.equal(failure.status, 'turn.failed');
  assert.deepEqual(failure.issues, ['turn.failed']);
});

test('recovery gaps are issue boundaries and remain visible in the closed summary', t => {
  const f = fixture(t);
  const refs = { binding_id: randomUUID(), session_id: randomUUID(), run_id: randomUUID(), thread_id: randomUUID() };
  const payload = (gaps: string[]) => ({
    journal: { source_id: 'journal-source', startup_cursor: 0, source_high_water: [] },
    binding: { id: refs.binding_id, ticket_id: f.ticket.ticket_id, conversation_id: f.ticket.conversation_id,
      session_id: refs.session_id, scope: 'run', run_id: refs.run_id },
    session: { state: 'unavailable', id: refs.session_id, cwd: null, thread_id: null },
    runs: [], projection: { run_cap: 20, current_runs_total: 0, current_runs_included: 0,
      source_high_water_total: 0, source_high_water_included: 0, truncated: false },
    attribution: { state: 'unknown', source: 'current attribution unavailable' }, gaps,
  });
  const records = [payload([]), payload(['SESSION_UNAVAILABLE', 'ATTRIBUTION_UNAVAILABLE']), payload([])]
    .map(value => projectRecord(f.event('recovery.observed', value, f.ticket.conversation_id, refs)));

  const rows = groupConversation(records);
  assert.equal(rows.length, 3);
  const gap = rows[1];
  assert.equal(gap.kind, 'auxiliary-group');
  if (gap.kind !== 'auxiliary-group') return;
  assert.deepEqual(gap.issues, ['SESSION_UNAVAILABLE', 'ATTRIBUTION_UNAVAILABLE']);
});

test('unknown source attribution is an issue boundary and remains visible in the closed summary', t => {
  const f = fixture(t);
  const refs = { binding_id: randomUUID(), session_id: randomUUID(), run_id: randomUUID(), thread_id: randomUUID() };
  const records = ['matched', 'unknown', 'matched'].map(state => projectRecord(f.event('source.snapshot', {
    run: { id: refs.run_id, status: 'running', exit_code: null },
    permissions: { state: 'observed' }, attribution: { state, source: state === 'unknown' ? 'current attribution unavailable' : 'fixture' },
  }, f.ticket.conversation_id, refs)));

  const rows = groupConversation(records);
  assert.equal(rows.length, 3);
  const unknown = rows[1];
  assert.equal(unknown.kind, 'auxiliary-group');
  if (unknown.kind !== 'auxiliary-group') return;
  assert.deepEqual(unknown.issues, ['归属未知']);
});

test('owned task lifecycle and control projection keep operation scopes without crossing task epochs', t => {
  const f = fixture(t), now = new Date().toISOString();
  const binding = { task_id: 'task-a', service_epoch: randomUUID(), request_id: 'request-a', ticket_id: f.ticket.ticket_id,
    cwd: 'C:\\workspace', timeout_ms: 1000, created_at: now, binding_id: randomUUID(), conversation_id: f.ticket.conversation_id,
    source_id: randomUUID(), metadata_redacted: false };
  const snapshot = { task_id: binding.task_id, status: 'stopping', root_state: 'running', exit_code: null, signal: null,
    completion_reason: null, termination: { requested: true, tree_kill: 'pending', attempts: 1 }, tracking_scope: 'process-tree',
    timeout_ms: 1000, output: { limit_bytes: 1024, stdout_bytes: 0, stderr_bytes: 0, pipes_closed: false,
      stdout_truncated: false, stderr_truncated: false, incomplete: false, redacted: false }, audit: 'observed', error: null,
    created_at: now, started_at: now, finished_at: null };
  const task = (kind: string, taskBinding = binding) => projectRecord(f.harness.journal.append({ kind: 'owned_task', task: {
    binding: taskBinding, category: 'lifecycle', seq: kind === 'stop.requested' ? 1 : 2, kind, source_at: now,
    source: 'yca-owned-task', payload: { kind }, snapshot, integrity: { policy: 'bridge-redact-v1', script: 'source-not-provided',
      capture: 'observed', redacted: false, source_redaction: false, truncated: false, incomplete: false,
      stdout: 'not-yet-observed', stderr: 'not-yet-observed', exit_code: 'not-yet-observed' } } }));
  const requested = task('stop.requested'), result = task('stop.result');
  assert.equal(requested.auxiliary!.family, 'owned-task-lifecycle');
  assert.equal(requested.auxiliary!.scope, result.auxiliary!.scope);
  const [taskGroup] = groupConversation([requested, result]);
  assert.equal(taskGroup.kind, 'auxiliary-group');
  if (taskGroup.kind === 'auxiliary-group') { assert.equal(taskGroup.count, 2); assert.deepEqual(taskGroup.memberIds, [requested.id, result.id]); }
  const nextEpoch = task('stop.result', { ...binding, service_epoch: randomUUID(), binding_id: randomUUID() });
  assert.notEqual(result.auxiliary!.scope, nextEpoch.auxiliary!.scope);
  assert.equal(groupConversation([requested, nextEpoch]).length, 2);
  const nextTask = task('stop.result', { ...binding, task_id: 'task-b', binding_id: randomUUID() });
  assert.notEqual(result.auxiliary!.scope, nextTask.auxiliary!.scope);

  const controlId = randomUUID(), target = { kind: 'task', id: binding.task_id };
  const control = (stage: 'requested' | 'result') => projectRecord(f.harness.journal.append({ kind: 'control_action', control: {
    control_id: controlId, ticket_id: f.ticket.ticket_id, action: 'task.stop', stage, outcome: stage === 'requested' ? 'requested' : 'completed',
    target, source_status: {}, occurred_at: now, integrity: { capture: 'recorded', redacted: false } } }));
  const controlRequested = control('requested'), controlResult = control('result');
  assert.equal(controlRequested.auxiliary!.family, 'control:task.stop');
  assert.equal(controlRequested.auxiliary!.scope, controlResult.auxiliary!.scope);
  assert.equal(controlRequested.auxiliary!.operationId, controlResult.auxiliary!.operationId);
  const [controlGroup] = groupConversation([controlRequested, controlResult]);
  assert.equal(controlGroup.kind, 'auxiliary-group');
  if (controlGroup.kind === 'auxiliary-group') { assert.equal(controlGroup.count, 1); assert.equal(controlGroup.countKind, 'calls'); }
});
