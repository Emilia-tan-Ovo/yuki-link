import test from 'node:test';
import assert from 'node:assert/strict';
import { groupConversation, groupIsOpen, setGroupOpen, conversationTabs } from '../ui/conversation-reading.ts';
import { mergePage, captureAnchor, restoreAnchor } from '../ui/conversation-state.ts';
import { MAX_REVEAL_DURATION_MS, SHORT_MESSAGE_STEP_MS, graphemes, revealStepMs,
  createMessageRevealState, selectRevealMessageIds } from '../ui/message-reveal.ts';
import type { ConversationItem, ConversationLink, ConversationPage } from '../src/harness/presentation-model.ts';

function item(n: number, changes: Partial<NonNullable<ConversationItem['auxiliary']>> = {}): ConversationItem {
  return { id: 'item-' + n, cursor: n, timestamp: new Date(n * 1000).toISOString(),
    participant: { id: 'engineer', role: 'engineer', label: 'Sylvia' }, sourceRefs: [],
    integrity: { redacted: false, truncated: false, incomplete: false }, rawEvidence: { marker: n },
    kind: 'tool', content: { title: '命令', command: 'echo fixture', output: 'evidence-' + n, status: 'completed' },
    auxiliary: { family: 'command', category: 'command', source: 'source', scope: 'run', operationId: 'call-' + n,
      status: 'completed', observedAt: new Date(n * 1000).toISOString(), issues: [], ...changes } };
}
function message(n: number): ConversationItem {
  return { ...item(n), auxiliary: undefined, kind: 'message', content: { text: '消息 ' + n } };
}
test('message reveal starts after the opening high water and consumes only appended messages once', () => {
  const page = (items: ConversationItem[], highWater: number): ConversationPage => ({ id: 'conversation', ticket_id: 'ticket', items,
    page: { first_cursor: items[0]?.cursor ?? null, last_cursor: items.at(-1)?.cursor ?? null,
      high_water_cursor: highWater, has_older: false, has_newer: false } });
  const initial = page([message(1)], 1), append = page([message(2), item(3)], 3);
  const state = createMessageRevealState(null);
  assert.deepEqual(selectRevealMessageIds(state, initial, 'after'), [], 'first response establishes the baseline');
  assert.deepEqual(selectRevealMessageIds(state, page([message(0)], 3), 'before'), [], 'prepending history never reveals');
  assert.deepEqual(selectRevealMessageIds(state, append, 'after'), ['item-2'], 'only appended messages reveal');
  assert.deepEqual(selectRevealMessageIds(state, append, 'after'), [], 'a message id is consumed once');
});
test('message reveal keeps the opening baseline across multi-page append', () => {
  const page = (items: ConversationItem[], highWater: number): ConversationPage => ({ id: 'conversation', ticket_id: 'ticket', items,
    page: { first_cursor: items[0]?.cursor ?? null, last_cursor: items.at(-1)?.cursor ?? null,
      high_water_cursor: highWater, has_older: false, has_newer: true } });
  const initial = page([message(50)], 50);
  const firstAppend = page(Array.from({ length: 50 }, (_, index) => item(51 + index)), 110);
  const state = createMessageRevealState(initial);
  assert.deepEqual(selectRevealMessageIds(state, firstAppend, 'after'), []);
  const delayedMessage = page([message(110)], 110);
  assert.deepEqual(selectRevealMessageIds(state, delayedMessage, 'after'), ['item-110']);
});
test('message reveal ignores high water advanced by a prepend while a new message exists', () => {
  const page = (items: ConversationItem[], highWater: number): ConversationPage => ({ id: 'conversation', ticket_id: 'ticket', items,
    page: { first_cursor: items[0]?.cursor ?? null, last_cursor: items.at(-1)?.cursor ?? null,
      high_water_cursor: highWater, has_older: true, has_newer: false } });
  const initial = page([message(100)], 100);
  const state = createMessageRevealState(initial);
  assert.deepEqual(selectRevealMessageIds(state, page([message(50)], 101), 'before'), []);
  assert.deepEqual(selectRevealMessageIds(state, page([message(101)], 101), 'after'), ['item-101']);
  assert.deepEqual(selectRevealMessageIds(state, page([message(50), message(101)], 101), 'after'), []);
});
test('message reveal preserves graphemes and bounds long-message timing', () => {
  assert.deepEqual(graphemes('中👩🏽‍💻A'), ['中', '👩🏽‍💻', 'A']);
  assert.equal(revealStepMs(20), SHORT_MESSAGE_STEP_MS);
  assert.ok(revealStepMs(1_000) * 1_000 <= MAX_REVEAL_DURATION_MS);
});
test('auxiliary grouping uses trusted family identity and monotonic time without a five minute ceiling', () => {
  assert.equal(groupConversation([item(1), item(2)]).length, 1);
  assert.equal(groupConversation([item(1), item(2, { observedAt: new Date(3_602_000).toISOString() })]).length, 1);
  for (const change of [{ family: 'observation' }, { source: 'other' }, { scope: 'other' }, { scope: null },
    { observedAt: 'invalid' }, { observedAt: new Date(0).toISOString() }]) {
    assert.equal(groupConversation([item(1), item(2, change)]).length, 2, JSON.stringify(change));
  }
  assert.equal(groupConversation([item(1), { ...item(2), participant: { id: 'other', label: 'Emilia', role: 'coordinator' } }]).length, 2);
  for (const kind of ['message', 'workflow', 'control', 'unknown', 'lifecycle', 'task'] as const) {
    const boundary: ConversationItem = kind === 'message' ? { ...item(2), auxiliary: undefined, kind, content: { text: 'human narrative' } }
      : { ...item(2), auxiliary: undefined, kind, content: { title: 'boundary/recovery', text: '', status: null } };
    assert.equal(groupConversation([item(1), boundary, item(3)]).length, 3);
  }
});
test('call identity deduplicates started/result; incomplete identity falls back to records; completed stays completed', () => {
  const records = [item(1, { status: 'not-yet-observed', operationId: 'call' }), item(2, { operationId: 'call' })];
  const [group] = groupConversation(records);
  assert.equal(group.kind, 'auxiliary-group'); if (group.kind !== 'auxiliary-group') return;
  assert.equal(group.count, 1); assert.equal(group.countKind, 'calls'); assert.equal(group.status, 'completed');
  assert.deepEqual(group.statuses, ['not-yet-observed', 'completed']);
  assert.deepEqual(group.members, records); assert.deepEqual(group.memberIds, ['item-1', 'item-2']);
  const [fallback] = groupConversation([records[0], item(2, { operationId: null })]);
  assert.equal(fallback.kind, 'auxiliary-group'); if (fallback.kind === 'auxiliary-group') {
    assert.equal(fallback.countKind, 'records'); assert.equal(fallback.count, 2);
  }
});
test('failure and integrity gaps break groups and remain in the summary', () => {
  const bad = { ...item(2, { status: 'failed', issues: ['退出码 1', 'stderr 诊断'] }), integrity: { redacted: true, truncated: true, incomplete: true } };
  const rows = groupConversation([item(1), bad, item(3)]);
  assert.equal(rows.length, 3);
  const group = rows[1]; assert.equal(group.kind, 'auxiliary-group'); if (group.kind !== 'auxiliary-group') return;
  assert.deepEqual(group.issues, ['退出码 1', 'stderr 诊断']); assert.deepEqual(group.integrity, bad.integrity);
  const [uncertain] = groupConversation([{ ...item(1), integrity: { redacted: false, truncated: 'unknown', incomplete: 'unknown' } }]);
  assert.equal(uncertain.kind === 'auxiliary-group' && uncertain.integrity.incomplete, 'unknown');
});
test('running task output with integrity gaps coalesces while preserving the summary warning', () => {
  const records: ConversationItem[] = Array.from({ length: 40 }, (_, n) => ({
    ...item(n, { category: 'output', scope: 'owned-task', operationId: null, status: 'running' }),
    kind: 'task', content: { title: '任务输出', text: 'output-' + n, status: 'running' },
    integrity: { redacted: false, truncated: false, incomplete: true },
  }));
  const rows = groupConversation(records);
  assert.equal(rows.length, 1);
  const group = rows[0]; assert.equal(group.kind, 'auxiliary-group'); if (group.kind !== 'auxiliary-group') return;
  assert.equal(group.members.length, 40); assert.equal(group.count, 40); assert.equal(group.countKind, 'records');
  assert.deepEqual(group.members, records); assert.equal(group.status, 'running');
  assert.equal(group.integrity.incomplete, true);
});
test('integrity flags aggregate without breaking groups while explicit issues remain boundaries', () => {
  for (const category of ['command', 'tool', 'observation', 'output'] as const) {
    const middle = item(2, { family: category, category });
    middle.integrity.incomplete = true;
    const rows = groupConversation([item(1, { family: category, category }), middle, item(3, { family: category, category })]);
    assert.equal(rows.length, 1, category);
    const group = rows[0]; assert.equal(group.kind, 'auxiliary-group'); if (group.kind !== 'auxiliary-group') continue;
    assert.equal(group.integrity.incomplete, true);
    const bad = item(4, { family: category, category, issues: ['采集失败'] });
    assert.equal(groupConversation([middle, bad, item(5, { family: category, category })]).length, 3, category);
  }
});
test('cross-page regroup retains keys, atomic cursors, open membership and prepend/append anchor identity', () => {
  const page = (items: ConversationItem[]): ConversationPage => ({ id: 'conversation', ticket_id: 'ticket', items,
    page: { first_cursor: items[0].cursor, last_cursor: items.at(-1)!.cursor, high_water_cursor: 4, has_older: true, has_newer: false } });
  const initial = page([item(2), item(3)]), previous = groupConversation(initial.items), original = previous[0];
  assert.equal(original.kind, 'auxiliary-group'); if (original.kind !== 'auxiliary-group') return;
  const open = setGroupOpen(original, new Set(), true);
  const merged = mergePage(mergePage(initial, page([item(1)]), 'before'), page([item(4)]), 'after');
  const [group] = groupConversation(merged.items, previous);
  assert.equal(group.kind, 'auxiliary-group'); if (group.kind !== 'auxiliary-group') return;
  assert.equal(group.id, original.id); assert.deepEqual(group.memberIds, [1, 2, 3, 4].map(n => 'item-' + n));
  assert.equal(groupIsOpen(group, open), true); assert.equal(groupIsOpen(group, setGroupOpen(group, open, false)), false);
  assert.deepEqual(merged.items.map(i => i.cursor), [1, 2, 3, 4]);
  const oldNode = { dataset: { itemId: 'item-2', anchorGroupId: original.id, memberIds: JSON.stringify(original.memberIds) }, getBoundingClientRect: () => ({ top: 110, bottom: 170 }) };
  const newNode = { dataset: { itemId: 'item-1', anchorGroupId: group.id, memberIds: JSON.stringify(group.memberIds) }, getBoundingClientRect: () => ({ top: 200, bottom: 270 }) };
  let nodes = [oldNode];
  const container = { scrollTop: 30, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => nodes } as unknown as HTMLElement;
  const anchor = captureAnchor(container)!; assert.deepEqual(anchor, { kind: 'group', id: original.id, memberId: 'item-2', offset: 10 }); nodes = [newNode];
  restoreAnchor(container, anchor); assert.equal(container.scrollTop, 120);
});
test('unchanged expanded group summary restores exactly the same scroll position', () => {
  const member = { dataset: { itemId: 'item-1' }, getBoundingClientRect: () => ({ top: 190, bottom: 250 }) };
  const group = { dataset: { itemId: 'item-1', anchorGroupId: 'group-1', memberIds: '["item-1"]' },
    getBoundingClientRect: () => ({ top: 110, bottom: 300 }) };
  const container = { scrollTop: 500, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => [group, member] } as unknown as HTMLElement;
  const anchor = captureAnchor(container)!;
  assert.deepEqual(anchor, { kind: 'group', id: 'group-1', memberId: 'item-1', offset: 10 });
  restoreAnchor(container, anchor);
  assert.equal(container.scrollTop, 500);
});
test('prepend regroup restores an atomic member to its new collapsed containing group', () => {
  const member = { dataset: { itemId: 'item-2' }, getBoundingClientRect: () => ({ top: 110, bottom: 170 }) };
  const oldGroup = { dataset: { itemId: 'item-1', anchorGroupId: 'old-group', memberIds: '["item-1","item-2"]' },
    getBoundingClientRect: () => ({ top: 50, bottom: 170 }), contains: (node: unknown) => node === member };
  const newGroup = { dataset: { itemId: 'item-0', anchorGroupId: 'new-group', memberIds: '["item-0","item-1","item-2"]' },
    getBoundingClientRect: () => ({ top: 200, bottom: 270 }) };
  let nodes: unknown[] = [oldGroup, member];
  const container = { scrollTop: 500, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => nodes } as unknown as HTMLElement;
  const anchor = captureAnchor(container)!;
  assert.deepEqual(anchor, { kind: 'item', id: 'item-2', offset: 10 });
  nodes = [newGroup];
  restoreAnchor(container, anchor);
  assert.equal(container.scrollTop, 590);
});
test('ordinary item anchors preserve their offset after prepend', () => {
  let top = 110;
  const node = { dataset: { itemId: 'message-1' }, getBoundingClientRect: () => ({ top, bottom: top + 60 }) };
  const container = { scrollTop: 500, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => [node] } as unknown as HTMLElement;
  const anchor = captureAnchor(container)!;
  assert.deepEqual(anchor, { kind: 'item', id: 'message-1', offset: 10 });
  restoreAnchor(container, anchor);
  assert.equal(container.scrollTop, 500);
  top = 200;
  restoreAnchor(container, anchor);
  assert.equal(container.scrollTop, 590);
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
