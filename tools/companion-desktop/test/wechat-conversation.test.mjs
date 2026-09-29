import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from '../desktop/wechat/channel-store.mjs';
import { WeChatConversation } from '../desktop/wechat/conversation.mjs';
import { WeChatApiError } from '../desktop/wechat/api.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-wechat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const crypto = { seal: value => Buffer.from(value).toString('base64'), open: value => Buffer.from(value, 'base64').toString() };
  const file = join(dir, 'channel.json'), store = await ChannelStore.load(file, crypto);
  const auth = { userId: 'owner', botId: 'bot', token: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com' };
  await store.bind(auth, 1);
  await store.setPaused(false);
  return { store, file, crypto, auth };
}
const backend = overrides => ({
  submit: async () => ({ committed: true, final: true, finalText: '回复', turnId: 'turn', messageId: 'assistant' }),
  list: async () => ({ committed: true, final: true, listVersion: 'v1', entries: [{ id: 'm1', text: '喜欢红茶' }] }),
  remember: async () => ({ committed: true, final: true, finalText: '已记住' }),
  correct: async () => ({ committed: true, final: true, finalText: '已更正' }),
  forget: async () => ({ committed: true, final: true, finalText: '已遗忘' }),
  lookup: async () => null,
  ...overrides,
});
async function claim(store, id, text, contextToken = 'ctx') {
  await store.claim(id, contextToken, { text, epoch: store.epoch() });
  return { messageId: id, text, contextToken, bindingEpoch: store.epoch() };
}

test('only committed final text is sent; unknown transport does not retry', async t => {
  const { store } = await fixture(t), sends = [], calls = [];
  const conversation = new WeChatConversation({ store, backend: backend({ submit: async input => { calls.push(input); return { committed: true, final: true, finalText: '回复', turnId: 't', messageId: 'm', reasoningContent: 'private' }; } }), api: { send: async (...args) => { sends.push(args); throw Error('timeout'); } } });
  const input = await claim(store, 'in', '你好', 'original-token');
  assert.equal((await conversation.receive(input)).delivery, 'unknown');
  assert.equal((await conversation.receive(input)).duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], 'original-token');
  assert.equal(sends[0][2], '回复');
  assert.equal(store.record('in').parts[0].status, 'unknown');
  assert.equal(store.record('in').delivery, 'unknown');
});

test('natural language mentioning memory words stays in normal dialogue', async t => {
  const { store } = await fixture(t);
  const calls = [], sends = [];
  const conversation = new WeChatConversation({
    store,
    backend: backend({ submit: async input => { calls.push(input); return { outcome: 'committed', finalText: '月桂-73', turnId: 'turn-recall', messageId: 'assistant-recall', memoryRevision: 1 }; }, list: async () => ({ outcome: 'committed', memoryRevision: 1, entries: [], listVersion: 'v1' }) }),
    api: { send: async (_auth, token, text) => { sends.push({ token, text }); return { ret: 0 }; } },
  });
  const text = '我刚刚在桌面记住的009验收测试代号是什么？';
  const result = await conversation.receive(await claim(store, 'natural-memory-question', text, 'ctx-natural'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, text);
  assert.equal(result.delivery, 'accepted_by_transport');
  assert.deepEqual(sends, [{ token: 'ctx-natural', text: '月桂-73' }]);
});

test('pending backend result is never sent and processing restart is not replayed', async t => {
  const { store, file, crypto } = await fixture(t);
  let calls = 0, sends = 0;
  const adapter = () => new WeChatConversation({ store, backend: backend({ submit: async () => { calls++; return { committed: false, final: false, finalText: '草稿' }; } }), api: { send: async () => { sends++; } } });
  const input = await claim(store, 'in', '你好');
  assert.equal((await adapter().receive(input)).processing, 'unknown');
  const reopened = await ChannelStore.load(file, crypto);
  assert.equal(reopened.record('in').status, 'unknown');
  assert.equal((await adapter().receive(input)).duplicate, true);
  assert.equal(calls, 1);
  assert.equal(sends, 0);
  const input2 = await claim(store, 'processing', '你好');
  await store.finish('processing', input2.bindingEpoch, { status: 'processing' });
  assert.equal((await adapter().receive(input2)).duplicate, true);
  assert.equal(calls, 1);
});

test('reopen uses receipt lookup only; missing receipt remains unknown', async t => {
  const { store, file, crypto } = await fixture(t);
  const input = await claim(store, 'lost', '你好');
  await store.finish('lost', input.bindingEpoch, { status: 'processing' });
  const reopened = await ChannelStore.load(file, crypto);
  let submits = 0, lookups = 0, sends = 0;
  const conversation = new WeChatConversation({ store: reopened, backend: backend({
    submit: async () => { submits++; throw Error('unexpected replay'); },
    lookup: async query => { lookups++; assert.equal(query.operationId, reopened.record('lost').operationId); return null; },
  }), api: { send: async () => { sends++; } } });
  assert.equal((await conversation.reconcile('lost')).status, 'unknown');
  assert.equal((await conversation.receive(input)).duplicate, true);
  assert.equal(submits, 0);
  assert.equal(lookups, 1);
  assert.equal(sends, 0);
});

test('unbind and same-account rebind block late backend results', async t => {
  const { store, auth } = await fixture(t);
  for (const change of [() => store.unbind(), () => store.bind(auth, 2)]) {
    if (!store.binding()) { await store.bind(auth, 1); await store.setPaused(false); }
    let release, sends = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const conversation = new WeChatConversation({ store, backend: backend({ submit: async () => pending }), api: { send: async () => { sends++; } } });
    const input = await claim(store, 'in', '你好');
    const receiving = conversation.receive(input);
    await new Promise(resolve => setImmediate(resolve));
    const oldEpoch = store.epoch();
    await change();
    assert.notEqual(store.epoch(), oldEpoch);
    release({ committed: true, final: true, finalText: '迟到', turnId: 't', messageId: 'm' });
    assert.equal((await receiving).processing, 'binding_changed');
    assert.equal(sends, 0);
  }
});

test('selection codes change with list version and epoch; no second memory copy', async t => {
  const { store, auth } = await fixture(t);
  let version = 'v1', corrections = 0;
  const conversation = new WeChatConversation({ store, backend: backend({
    list: async () => ({ committed: true, final: true, listVersion: version, entries: [{ id: 'm1', text: '喜欢红茶' }] }),
    correct: async () => { corrections++; return { committed: true, final: true, finalText: '已更正' }; },
  }), api: { send: async () => ({ ret: 0 }) } });
  await conversation.receive(await claim(store, 'list', '/记忆'));
  const oldCode = Object.keys(conversation.selection.codes)[0];
  assert.equal(JSON.stringify(store.snapshot()).includes('喜欢红茶'), false);
  version = 'v2';
  await conversation.receive(await claim(store, 'change', `/更正 ${oldCode} 喜欢绿茶`));
  assert.equal(corrections, 0);
  await conversation.receive(await claim(store, 'list2', '/记忆'));
  const code = Object.keys(conversation.selection.codes)[0];
  await store.bind(auth, 2);
  await store.setPaused(false);
  await conversation.receive(await claim(store, 'change2', `/更正 ${code} 喜欢绿茶`));
  assert.equal(corrections, 0);
});

test('context follows original inbound; segmented unknown is not whole-message acceptance', async t => {
  const { store } = await fixture(t), sent = [];
  const conversation = new WeChatConversation({ store, backend: backend({ submit: async () => ({ committed: true, final: true, finalText: '字'.repeat(1600), turnId: 't', messageId: 'm' }) }), api: { send: async (_auth, token, part) => { sent.push({ token, part }); return sent.length === 1 ? { ret: 0 } : {}; } } });
  const original = await claim(store, 'first', '你好', 'token-first');
  await claim(store, 'second', '别的输入', 'token-second');
  assert.equal((await conversation.receive(original)).delivery, 'unknown');
  assert.deepEqual(store.record('first').parts.map(part => part.status), ['accepted_by_transport', 'unknown']);
  assert.deepEqual(sent.map(row => row.token), ['token-first', 'token-first']);
  assert.equal(sent[0].part.length, 1500);
});

test('memory correction between delivery parts invalidates the remaining snapshot', async t => {
  const { store } = await fixture(t);
  let revision = 1, sends = 0;
  const conversation = new WeChatConversation({ store, backend: backend({
    submit: async () => ({ outcome: 'committed', finalText: '字'.repeat(1600), turnId: 't', messageId: 'm', memoryRevision: 1 }),
    list: async () => ({ outcome: 'committed', memoryRevision: revision, entries: [] }),
  }), api: { send: async () => { sends++; revision = 2; return { ret: 0 }; } } });
  assert.equal((await conversation.receive(await claim(store, 'stale', '你好'))).delivery, 'stale_memory');
  assert.equal(sends, 1);
  assert.deepEqual(store.record('stale').parts.map(part => part.status), ['accepted_by_transport']);
});

test('pause during processing persistence prevents backend admission', async t => {
  const { store } = await fixture(t);
  const input = await claim(store, 'paused-before-backend', '你好');
  const finish = store.finish.bind(store);
  let release, calls = 0;
  store.finish = (...args) => args[2]?.status === 'processing' ? new Promise(resolve => { release = async () => resolve(finish(...args)); }) : finish(...args);
  const conversation = new WeChatConversation({ store, backend: backend({ submit: async () => { calls++; } }), api: { send: async () => {} }, isAuthorized: () => !store.paused() });
  const receiving = conversation.receive(input);
  await new Promise(resolve => setImmediate(resolve));
  await store.setPaused(true);
  await release();
  assert.equal((await receiving).processing, 'binding_changed');
  assert.equal(calls, 0);
});

test('rebind during delivery intent cannot redirect an old reply', async t => {
  const { store, auth } = await fixture(t);
  const input = await claim(store, 'old-reply', '你好', 'old-token');
  const finish = store.finish.bind(store);
  let release;
  store.finish = (...args) => args[2]?.parts?.length === 1 ? new Promise(resolve => { release = async () => resolve(finish(...args)); }) : finish(...args);
  const sent = [];
  const conversation = new WeChatConversation({ store, backend: backend({ submit: async () => ({ committed: true, finalText: '回复', turnId: 't', messageId: 'm' }) }), api: { send: async (...args) => { sent.push(args); return { ret: 0 }; } } });
  const receiving = conversation.receive(input);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await store.bind({ ...auth, userId: 'new-owner' }, 2);
  await store.setPaused(false);
  await release();
  assert.equal((await receiving).processing, 'binding_changed');
  assert.equal(sent.length, 0);
});

test('accepted first part and rejected second part retain partial delivery', async t => {
  const { store } = await fixture(t);
  let sent = 0;
  const conversation = new WeChatConversation({ store, backend: backend({ submit: async () => ({ committed: true, finalText: '字'.repeat(1600), turnId: 't', messageId: 'm' }) }), api: { send: async () => ++sent === 1 ? { ret: 0 } : Promise.reject(new WeChatApiError('rejected')) } });
  assert.equal((await conversation.receive(await claim(store, 'partial', '你好'))).delivery, 'partial');
  assert.deepEqual(store.record('partial').parts.map(part => part.status), ['accepted_by_transport', 'failed']);
});
