import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { groupConversation } from '../ui/conversation-reading.ts';

test('execution details are absent from collapsed markup; expanding group exposes every atomic disclosure', async t => {
  const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  t.after(() => server.close());
  const { AuxiliaryGroupRow, ConversationRow } = await server.ssrLoadModule('/renderers.tsx');
  const { Conversation } = await server.ssrLoadModule('/Conversation.tsx');
  const item = { id: 'atomic-1', cursor: 1, timestamp: '2026-09-21T00:00:00Z',
    participant: { id: 'engineer', role: 'engineer', label: 'Sylvia' }, sourceRefs: [],
    integrity: { redacted: false, truncated: true, incomplete: false }, rawEvidence: { marker: 'RAW_EVIDENCE' },
    kind: 'tool', content: { title: '命令记录', command: 'COMMAND_EVIDENCE', output: 'OUTPUT_EVIDENCE', status: 'failed' },
    auxiliary: { family: 'command', category: 'command', source: 'source', scope: 'run', operationId: 'call',
      status: 'failed', observedAt: '2026-09-21T00:00:00Z', issues: ['退出码 1'] } };
  const [group] = groupConversation([item]);
  const closed = renderToStaticMarkup(createElement(AuxiliaryGroupRow, { group, open: false, onOpenChange() {} }));
  assert.match(closed, /aria-expanded="false"/);
  for (const summary of ['退出码 1', '来源截断', '失败']) assert.ok(closed.includes(summary));
  for (const hidden of ['COMMAND_EVIDENCE', 'OUTPUT_EVIDENCE', 'RAW_EVIDENCE', '命令记录']) assert.ok(!closed.includes(hidden));
  assert.ok(!closed.includes('×1'));
  const opened = renderToStaticMarkup(createElement(AuxiliaryGroupRow, { group, open: true, onOpenChange() {} }));
  assert.match(opened, /aria-expanded="true"/); assert.ok(opened.includes('命令记录')); assert.ok(opened.includes('atomic-1'));
  assert.match(opened, /aria-expanded="false"/); // Individual record remains independently collapsed.
  const atomic = renderToStaticMarkup(createElement(ConversationRow, { item }));
  for (const hidden of ['COMMAND_EVIDENCE', 'OUTPUT_EVIDENCE', 'RAW_EVIDENCE']) assert.ok(!atomic.includes(hidden));
  assert.ok(!atomic.includes('Advanced')); assert.match(atomic, /aria-expanded="false"/);
  const narrative = renderToStaticMarkup(createElement(ConversationRow, { item: { ...item, auxiliary: undefined, kind: 'message', content: { text: 'HUMAN_NARRATIVE' } } }));
  assert.ok(narrative.includes('HUMAN_NARRATIVE'));
  assert.ok(!narrative.includes('reveal-character'));
  const revealed = renderToStaticMarkup(createElement(ConversationRow, {
    item: { ...item, auxiliary: undefined, kind: 'message', content: { text: '中👩🏽‍💻 **bold** `code`' } }, reveal: true,
  }));
  assert.ok(revealed.includes('data-complete-text="中👩🏽‍💻 **bold** `code`"'));
  assert.ok(revealed.includes('reveal-character'));
  assert.ok(revealed.includes('<strong>')); assert.ok(revealed.includes('<code>'));
  for (const kind of ['lifecycle', 'workflow', 'control', 'task', 'unknown']) {
    const auxiliary = { ...item, id: kind, kind, auxiliary: undefined,
      content: { title: kind + ' title', text: kind + '_HIDDEN_BODY', status: 'observed' }, rawEvidence: { marker: kind + '_HIDDEN_RAW' } };
    const markup = renderToStaticMarkup(createElement(ConversationRow, { item: auxiliary }));
    assert.ok(markup.includes(kind + ' title'));
    assert.ok(!markup.includes(kind + '_HIDDEN_BODY'));
    assert.ok(!markup.includes(kind + '_HIDDEN_RAW'));
    assert.ok(!markup.includes('reveal-character'));
  }
  const page = { id: 'conversation', ticket_id: 'ticket', items: [],
    usage: { total_tokens: 125, input_tokens: 100, output_tokens: 25, cached_input_tokens: 40 }, page: { first_cursor: null, last_cursor: null,
    high_water_cursor: 0, has_older: false, has_newer: false } };
  const relation = { id: 'conversation', label: 'Main', kind: 'main', isolation: null, original_review_id: null,
    finding_refs: [], review_id: null, participant: null };
  const conversation = renderToStaticMarkup(createElement(Conversation, { id: 'conversation', initial: page, relation, refresh: 0 }));
  assert.ok(!conversation.includes('只读 Conversation'));
  assert.ok(!conversation.includes('composer-slot'));
  for (const usage of ['Conversation Token', '总计 125', '输入 100', '输出 25', '缓存命中 40']) assert.ok(conversation.includes(usage));
});
