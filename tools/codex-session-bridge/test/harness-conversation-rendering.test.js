import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { groupConversation } from '../ui/conversation-reading.ts';

test('execution details are absent from collapsed markup; expanding group exposes every atomic disclosure', async t => {
  const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  t.after(() => server.close());
  const { ExecutionGroupRow, ConversationRow } = await server.ssrLoadModule('/renderers.tsx');
  const item = { id: 'atomic-1', cursor: 1, timestamp: '2026-09-21T00:00:00Z',
    participant: { id: 'engineer', role: 'engineer', label: 'Sylvia' }, sourceRefs: [],
    integrity: { redacted: false, truncated: true, incomplete: false }, rawEvidence: { marker: 'RAW_EVIDENCE' },
    kind: 'tool', content: { title: '命令记录', command: 'COMMAND_EVIDENCE', output: 'OUTPUT_EVIDENCE', status: 'failed' },
    execution: { category: 'command', source: 'source', scope: 'run', operationId: 'call',
      status: 'failed', observedAt: '2026-09-21T00:00:00Z', issues: ['退出码 1'] } };
  const [group] = groupConversation([item]);
  const closed = renderToStaticMarkup(createElement(ExecutionGroupRow, { group, open: false, onOpenChange() {} }));
  assert.match(closed, /aria-expanded="false"/);
  for (const summary of ['退出码 1', '来源截断', '失败']) assert.ok(closed.includes(summary));
  for (const hidden of ['COMMAND_EVIDENCE', 'OUTPUT_EVIDENCE', 'RAW_EVIDENCE', '命令记录']) assert.ok(!closed.includes(hidden));
  const opened = renderToStaticMarkup(createElement(ExecutionGroupRow, { group, open: true, onOpenChange() {} }));
  assert.match(opened, /aria-expanded="true"/); assert.ok(opened.includes('命令记录')); assert.ok(opened.includes('atomic-1'));
  assert.match(opened, /aria-expanded="false"/); // Individual record remains independently collapsed.
  const atomic = renderToStaticMarkup(createElement(ConversationRow, { item }));
  for (const hidden of ['COMMAND_EVIDENCE', 'OUTPUT_EVIDENCE', 'RAW_EVIDENCE']) assert.ok(!atomic.includes(hidden));
  assert.ok(atomic.includes('Advanced')); assert.match(atomic, /aria-expanded="false"/);
  const narrative = renderToStaticMarkup(createElement(ConversationRow, { item: { ...item, execution: undefined, kind: 'message', content: { text: 'HUMAN_NARRATIVE' } } }));
  assert.ok(narrative.includes('HUMAN_NARRATIVE'));
});
