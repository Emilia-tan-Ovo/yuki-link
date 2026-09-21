import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Harness } from '../src/harness/harness.ts';
import { Presentation, projectRecord } from '../src/harness/presentation.ts';
import type { RecordEntry, Source } from '../src/harness/model.ts';
import { mergePage, captureAnchor, restoreAnchor } from '../ui/conversation-state.ts';
import type { ConversationPage } from '../src/harness/presentation-model.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-presentation-'));
  const source: Source = { session: () => { throw new Error('offline'); }, runs: () => [], events: () => [], attribution: () => null };
  const harness = new Harness(root, source), p = new Presentation(harness);
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  const ticket = harness.register({ project_key: 'fixture', project_name: '工程', ticket_key: '012', title: '产品化', reference: 'fixture' });
  function event(kind: string, payload: unknown, id = ticket.conversation_id) {
    return harness.journal.append({ kind: 'event', event: { ticket_id: ticket.ticket_id, conversation_id: id,
      binding_id: randomUUID(), session_id: randomUUID(), run_id: randomUUID(), thread_id: null,
      source_seq: null, source_at: null, kind, payload,
      integrity: { source_redaction: 'unknown', redacted: false, truncated: 'unknown' } } });
  }
  return { harness, p, ticket, event };
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
  const anchor = captureAnchor(container)!; assert.deepEqual(anchor, { id: 'visible', offset: -20 });
  offset += 380; restoreAnchor(container, anchor); assert.equal(container.scrollTop, 430);
  const page: ConversationPage = { id: 'c', ticket_id: 't', items: [], page: { first_cursor: null, last_cursor: null, high_water_cursor: 1, has_older: true, has_newer: false } };
  assert.equal(mergePage(page, { ...page, page: { ...page.page, has_older: false } }, 'after').page.has_older, true);
});
