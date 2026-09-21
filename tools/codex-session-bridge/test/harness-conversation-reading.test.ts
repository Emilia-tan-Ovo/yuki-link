import test from 'node:test';
import assert from 'node:assert/strict';
import { groupConversation, groupIsOpen, setGroupOpen, conversationTabs } from '../ui/conversation-reading.ts';
import { mergePage, captureAnchor, restoreAnchor } from '../ui/conversation-state.ts';
import type { ConversationItem, ConversationLink, ConversationPage } from '../src/harness/presentation-model.ts';

function item(n: number, changes: Partial<NonNullable<ConversationItem['execution']>> = {}): ConversationItem {
  return { id: 'item-' + n, cursor: n, timestamp: new Date(n * 1000).toISOString(),
    participant: { id: 'engineer', role: 'engineer', label: 'Sylvia' }, sourceRefs: [],
    integrity: { redacted: false, truncated: false, incomplete: false }, rawEvidence: { marker: n },
    kind: 'tool', content: { title: '命令', command: 'echo fixture', output: 'evidence-' + n, status: 'completed' },
    execution: { category: 'command', source: 'source', scope: 'run', operationId: 'call-' + n,
      status: 'completed', observedAt: new Date(n * 1000).toISOString(), issues: [], ...changes } };
}
test('whitelist merges only consecutive same category/participant/source/scope with trusted time', () => {
  assert.equal(groupConversation([item(1), item(2)]).length, 1);
  for (const change of [{ category: 'observation' as const }, { source: 'other' }, { scope: 'other' }, { scope: null },
    { observedAt: 'invalid' }, { observedAt: new Date(302_000).toISOString() }, { observedAt: new Date(0).toISOString() }]) {
    assert.equal(groupConversation([item(1), item(2, change)]).length, 2, JSON.stringify(change));
  }
  assert.equal(groupConversation([item(1), { ...item(2), participant: { id: 'other', label: 'Emilia', role: 'coordinator' } }]).length, 2);
  for (const kind of ['message', 'workflow', 'control', 'unknown', 'lifecycle', 'task'] as const) {
    const boundary: ConversationItem = kind === 'message' ? { ...item(2), execution: undefined, kind, content: { text: 'human narrative' } }
      : { ...item(2), execution: undefined, kind, content: { title: 'boundary/recovery', text: '', status: null } };
    assert.equal(groupConversation([item(1), boundary, item(3)]).length, 3);
  }
});
test('call identity deduplicates started/result; incomplete identity falls back to records; completed stays completed', () => {
  const records = [item(1, { status: 'not-yet-observed', operationId: 'call' }), item(2, { operationId: 'call' })];
  const [group] = groupConversation(records);
  assert.equal(group.kind, 'execution-group'); if (group.kind !== 'execution-group') return;
  assert.equal(group.count, 1); assert.equal(group.countKind, 'calls'); assert.equal(group.status, 'completed');
  assert.deepEqual(group.members, records); assert.deepEqual(group.memberIds, ['item-1', 'item-2']);
  const [fallback] = groupConversation([records[0], item(2, { operationId: null })]);
  assert.equal(fallback.kind, 'execution-group'); if (fallback.kind === 'execution-group') {
    assert.equal(fallback.countKind, 'records'); assert.equal(fallback.count, 2);
  }
});
test('failure and integrity gaps break groups and remain in the summary', () => {
  const bad = { ...item(2, { status: 'failed', issues: ['退出码 1', 'stderr 诊断'] }), integrity: { redacted: true, truncated: true, incomplete: true } };
  const rows = groupConversation([item(1), bad, item(3)]);
  assert.equal(rows.length, 3);
  const group = rows[1]; assert.equal(group.kind, 'execution-group'); if (group.kind !== 'execution-group') return;
  assert.deepEqual(group.issues, ['退出码 1', 'stderr 诊断']); assert.deepEqual(group.integrity, bad.integrity);
  const [uncertain] = groupConversation([{ ...item(1), integrity: { redacted: false, truncated: 'unknown', incomplete: 'unknown' } }]);
  assert.equal(uncertain.kind === 'execution-group' && uncertain.integrity.incomplete, 'unknown');
});
test('cross-page regroup retains keys, atomic cursors, open membership and prepend/append anchor identity', () => {
  const page = (items: ConversationItem[]): ConversationPage => ({ id: 'conversation', ticket_id: 'ticket', items,
    page: { first_cursor: items[0].cursor, last_cursor: items.at(-1)!.cursor, high_water_cursor: 4, has_older: true, has_newer: false } });
  const initial = page([item(2), item(3)]), previous = groupConversation(initial.items), original = previous[0];
  assert.equal(original.kind, 'execution-group'); if (original.kind !== 'execution-group') return;
  const open = setGroupOpen(original, new Set(), true);
  const merged = mergePage(mergePage(initial, page([item(1)]), 'before'), page([item(4)]), 'after');
  const [group] = groupConversation(merged.items, previous);
  assert.equal(group.kind, 'execution-group'); if (group.kind !== 'execution-group') return;
  assert.equal(group.id, original.id); assert.deepEqual(group.memberIds, [1, 2, 3, 4].map(n => 'item-' + n));
  assert.equal(groupIsOpen(group, open), true); assert.equal(groupIsOpen(group, setGroupOpen(group, open, false)), false);
  assert.deepEqual(merged.items.map(i => i.cursor), [1, 2, 3, 4]);
  const oldNode = { dataset: { itemId: 'item-2', memberIds: JSON.stringify(original.memberIds) }, getBoundingClientRect: () => ({ top: 110, bottom: 170 }) };
  const newNode = { dataset: { itemId: 'item-1', memberIds: JSON.stringify(group.memberIds) }, getBoundingClientRect: () => ({ top: 200, bottom: 270 }) };
  let nodes = [oldNode];
  const container = { scrollTop: 30, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => nodes } as unknown as HTMLElement;
  const anchor = captureAnchor(container)!; assert.equal(anchor.id, 'item-2'); nodes = [newNode];
  restoreAnchor(container, anchor); assert.equal(container.scrollTop, 120);
});
test('duplicate Focused Review labels retain distinct conversation/review/participant/full finding relations', () => {
  const relation = (n: number): ConversationLink => ({ id: 'child-' + n, label: 'Focused Review · spec', kind: 'focused',
    review_id: 'review-' + n, participant: 'spec', isolation: 'verified', original_review_id: 'original', finding_refs: ['original/F' + n] });
  const tabs = conversationTabs([relation(1), relation(2)]);
  assert.deepEqual(tabs.map(t => t.name), ['Focused 1', 'Focused 2']);
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]; assert.equal(tab.id, 'child-' + (i + 1)); assert.equal(tab.review_id, 'review-' + (i + 1));
    for (const part of [tab.id, tab.review_id!, 'spec', 'verified', 'original', tab.finding_refs[0]]) assert.ok(tab.accessibleName.includes(part));
  }
});
