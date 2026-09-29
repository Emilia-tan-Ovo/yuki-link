import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerHandler } from '../backend/worker.mjs';
import { BackendSession } from '../backend/session.mjs';
import { ChannelStore } from '../desktop/wechat/channel-store.mjs';
import { WeChatConversation } from '../desktop/wechat/conversation.mjs';
import { WeChatWorkerPort } from '../desktop/wechat/worker-port.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, provider) {
  const directory = await mkdtemp(join(tmpdir(), 'yuki-wechat-worker-'));
  const events = [];
  let session;
  t.after(async () => { session?.close(); await rm(directory, { recursive: true, force: true }); });
  const handle = createWorkerHandler({ post: event => events.push(event), createSession: () => (session = new BackendSession({ directory, provider })) });
  await handle({ type: 'start', generation: 1 });
  const send = async (action, input = {}, generation = 1) => {
    const id = randomUUID();
    await handle({ type: 'wechat', generation, id, action, ...input });
    return events.findLast(event => event.type === 'wechat-result' && event.id === id);
  };
  return { directory, events, handle, send, get session() { return session; } };
}

test('worker COMMIT and receipt survive lost reply and a new generation without rerunning model', async t => {
  let calls = 0;
  const flow = await fixture(t, async () => { calls++; return { content: '已接续', reasoningContent: '私密推理' }; });
  const operationId = randomUUID(), payloadDigest = digest('输入');
  const committed = await flow.send('submit', { operationId, requestId: operationId, payloadDigest, text: '输入', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  assert.equal(committed.outcome, 'committed');
  assert.equal(committed.finalText, '已接续');
  assert.equal(JSON.stringify(committed).includes('私密推理'), false);
  await flow.handle({ type: 'start', generation: 2 });
  const receipt = await flow.send('lookup', { operationId, payloadDigest }, 2);
  assert.equal(receipt.receipt.operationId, operationId);
  assert.equal(receipt.receipt.resultId, committed.messageId);
  assert.equal(calls, 1);
  assert.equal(flow.session.displayHistory().length, 2);
  const repeat = await flow.send('submit', { operationId, requestId: operationId, payloadDigest, text: '输入' }, 2);
  assert.equal(repeat.outcome, 'committed');
  assert.equal(calls, 1);
  const conflict = await flow.send('lookup', { operationId, payloadDigest: digest('别的输入') }, 2);
  assert.equal(conflict.outcome, 'rejected');
  assert.equal(conflict.reason, 'identity_conflict');
});

test('memory revision changes without new messages; memory receipts share the same SQLite file', async t => {
  const flow = await fixture(t, async () => ({ content: '回复' }));
  const first = randomUUID();
  const remember = await flow.send('remember', { operationId: first, requestId: first, payloadDigest: digest('红茶'), text: '喜欢红茶' });
  assert.equal(remember.outcome, 'committed');
  assert.equal(remember.memoryRevision, 1);
  const memoryId = remember.entryId;
  const second = randomUUID();
  const correct = await flow.send('correct', { operationId: second, requestId: second, payloadDigest: digest('绿茶'), targetId: memoryId, text: '喜欢绿茶' });
  assert.equal(correct.memoryRevision, 2);
  const third = randomUUID();
  const forget = await flow.send('forget', { operationId: third, requestId: third, payloadDigest: digest('遗忘'), targetId: correct.entryId });
  assert.equal(forget.memoryRevision, 3);
  assert.equal(flow.session.displayHistory().length, 0);
  assert.deepEqual(flow.session.listMemories(), []);
  await flow.handle({ type: 'start', generation: 2 });
  assert.equal((await flow.send('lookup', { operationId: third, payloadDigest: digest('遗忘') }, 2)).receipt.resultId, correct.entryId);
  assert.equal((await flow.send('list', {}, 2)).memoryRevision, 3);
});

test('busy and invalid input are deterministic worker outcomes', async t => {
  let release;
  const flow = await fixture(t, () => new Promise(resolve => { release = resolve; }));
  const first = randomUUID();
  const pending = flow.send('submit', { operationId: first, requestId: first, payloadDigest: digest('输入'), text: '输入' });
  await new Promise(resolve => setImmediate(resolve));
  const second = randomUUID();
  assert.deepEqual((await flow.send('submit', { operationId: second, requestId: second, payloadDigest: digest('第二条'), text: '第二条' })).outcome, 'rejected');
  assert.equal((await flow.send('submit', { operationId: 'wechat:v1:bad', requestId: 'wechat:v1:bad', payloadDigest: digest('x'), text: 'x' })).reason, 'invalid_input');
  release({ content: '已完成' });
  assert.equal((await pending).outcome, 'committed');
});

test('worker port refuses a known unsent operation without calling it unknown', async () => {
  const port = new WeChatWorkerPort({ state: 'disconnected', generation: 1, send: () => false }, () => ({}));
  assert.deepEqual(await port.submit({ operationId: randomUUID(), payloadDigest: digest('text'), text: 'text' }), { outcome: 'rejected', reason: 'backend_unavailable' });
});

test('Desktop fact is recalled on WeChat; WeChat correction and forgetting change later Desktop prompts', async t => {
  const prompts = [];
  const flow = await fixture(t, async input => { prompts.push(input.messages); return { content: 'Emilia 回复' }; });
  const crypto = { seal: value => Buffer.from(value).toString('base64'), open: value => Buffer.from(value, 'base64').toString() };
  const store = await ChannelStore.load(join(flow.directory, 'channel.json'), crypto);
  await store.bind({ userId: 'owner', botId: 'bot', token: 'fixture', baseUrl: 'https://ilinkai.weixin.qq.com' }, 1);
  await store.setPaused(false);
  const port = Object.fromEntries(['submit','list','remember','correct','forget','lookup'].map(action => [action, input => flow.send(action, { ...input, requestId: input.operationId })]));
  port.generation = () => 1;
  const conversation = new WeChatConversation({ store, backend: port, api: { send: async () => ({ ret: 0 }) } });
  const receive = async (id, text) => { await store.claim(id, 'context-' + id, { epoch: store.epoch(), text, backendGeneration: 1 }); return conversation.receive({ messageId: id, text, contextToken: 'context-' + id, bindingEpoch: store.epoch() }); };
  flow.session.remember({ text: '喜欢红茶', sourceKind: 'explicit_chat' });
  assert.equal((await receive('one', '红茶怎么样')).delivery, 'accepted_by_transport');
  assert.match(JSON.stringify(prompts.at(-1)), /喜欢红茶/u);
  await receive('list', '/记忆');
  const code = Object.keys(conversation.selection.codes)[0];
  assert.equal((await receive('correct', `/更正 ${code} 喜欢绿茶`)).delivery, 'accepted_by_transport');
  await flow.session.submit('绿茶怎么样');
  assert.match(JSON.stringify(prompts.at(-1)), /喜欢绿茶/u);
  assert.doesNotMatch(JSON.stringify(prompts.at(-1)), /喜欢红茶/u);
  await receive('list2', '/记忆');
  const code2 = Object.keys(conversation.selection.codes)[0];
  assert.equal((await receive('forget', `/遗忘 ${code2}`)).delivery, 'accepted_by_transport');
  await flow.session.submit('绿茶怎么样');
  assert.doesNotMatch(JSON.stringify(prompts.at(-1)), /喜欢绿茶/u);
});
