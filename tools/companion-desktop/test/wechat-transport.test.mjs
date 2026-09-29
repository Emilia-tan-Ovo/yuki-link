import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatApi, WeChatApiError, parseWeixinJson, weixinOrigin } from '../desktop/wechat/api.mjs';
import { ChannelStore } from '../desktop/wechat/channel-store.mjs';
import { WeChatService } from '../desktop/wechat/service.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-wechat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'channel.json');
  const crypto = { seal: plain => Buffer.from(plain).toString('base64'), open: sealed => Buffer.from(sealed, 'base64').toString() };
  return { file, crypto, store: await ChannelStore.load(file, crypto) };
}
const auth = { userId: 'owner', botId: 'bot', token: 'private-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
const message = (id, more = {}) => ({ message_id: id, from_user_id: 'owner', to_user_id: 'bot', message_type: 1, message_state: 2, create_time_ms: 1001, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '你好' } }], ...more });

test('official origin, response limit, and uint64 message IDs remain exact', async () => {
  assert.equal(weixinOrigin('https://region.ilinkai.weixin.qq.com/'), 'https://region.ilinkai.weixin.qq.com');
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://evil-ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:443', 'https://ilinkai.weixin.qq.com/a']) assert.throws(() => weixinOrigin(url), WeChatApiError);
  assert.equal(parseWeixinJson('{"msgs":[{"message_id":18446744073709551615,"text":"\\\"message_id\\\": 3"}]}').msgs[0].message_id, '18446744073709551615');
  const api = new WeChatApi(async () => new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615}]}'));
  assert.equal((await api.updates(auth, '', new AbortController().signal)).msgs[0].message_id, '18446744073709551615');
  const contradictory = new WeChatApi(async () => new Response('{"ret":0,"errcode":5}'));
  await assert.rejects(contradictory.send(auth, 'context', '回复', 'client', new AbortController().signal), error => error instanceof WeChatApiError && error.kind === 'invalid_response');
});

test('local confirmation, owner filtering, durable claim, and binding scope', async t => {
  const { file, crypto, store } = await fixture(t);
  const accepted = [];
  const api = { qr: async () => ({ qrcode: 'q', qrcode_img_content: 'qr-content' }), qrStatus: async () => ({ status: 'confirmed', bot_token: auth.token, ilink_bot_id: auth.botId, ilink_user_id: auth.userId, baseurl: auth.baseUrl }), updates: async () => ({ ret: 0, get_updates_buf: 'cursor-1', msgs: [message('18446744073709551615'), message('18446744073709551615'), message('other', { from_user_id: 'stranger' }), message('group', { group_id: 'group' }), message('old', { create_time_ms: 999 })] }) };
  const service = new WeChatService({ store, api, receive: async input => { accepted.push(input); await store.finish(input.messageId, input.bindingEpoch, { status: 'handled' }); }, now: () => 1000 });
  const qr = await service.beginLogin(0);
  await service.checkLogin(qr.qrcode);
  assert.equal(service.snapshot().status, 'awaiting_local_confirmation');
  assert.equal(store.binding(), null);
  await service.confirmBinding(service.snapshot().revision);
  await service.resume();
  assert.equal(service.snapshot().status, 'connected');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].messageId, '18446744073709551615');
  assert.equal(store.cursor(), 'cursor-1');
  assert.doesNotMatch(await (await import('node:fs/promises')).readFile(file, 'utf8'), /private-token|owner|cursor-1/);
  const reopened = await ChannelStore.load(file, crypto);
  const afterRestart = new WeChatService({ store: reopened, api, receive: async input => accepted.push(input), now: () => 1000 });
  await afterRestart.pollOnce();
  assert.equal(accepted.length, 1);
  await reopened.bind({ ...auth, userId: 'new-owner' }, 2000);
  assert.equal(reopened.cursor(), '');
  assert.equal(reopened.record('18446744073709551615'), null);
});

test('QR expiry, transport outage, and auth expiry retain truthful states', async t => {
  const { store } = await fixture(t);
  let now = 1000, failure = new WeChatApiError('network');
  const api = { qr: async () => ({ qrcode: 'q', qrcode_img_content: 'qr' }), qrStatus: async () => ({ status: 'expired' }), updates: async () => { throw failure; } };
  const service = new WeChatService({ store, api, receive: async () => {}, now: () => now });
  await service.beginLogin(0);
  await service.checkLogin('q');
  assert.equal(service.snapshot().status, 'qr_expired');
  await store.bind(auth, 1000);
  await service.resume();
  assert.equal(service.snapshot().status, 'unavailable');
  assert.ok(store.binding());
  failure = new WeChatApiError('expired');
  await service.resume();
  assert.equal(service.snapshot().status, 'auth_expired');
  assert.equal(store.binding(), null);
});

test('missing bot identity reports protocol mismatch before claim and cursor', async t => {
  const { store } = await fixture(t);
  await store.bind(auth, 1000);
  const accepted = [];
  const msgs = [message('no-owner', { from_user_id: undefined }), message('no-bot', { to_user_id: undefined }), message('valid')];
  const service = new WeChatService({ store, api: { updates: async () => ({ ret: 0, msgs, get_updates_buf: 'next' }) }, receive: async input => { accepted.push(input); await store.finish(input.messageId, input.bindingEpoch, { status: 'handled' }); }, now: () => 1000 });
  await service.resume();
  assert.equal(service.snapshot().status, 'protocol_mismatch');
  assert.deepEqual(accepted.map(row => row.messageId), []);
  assert.equal(store.record('no-owner'), null);
  assert.equal(store.record('no-bot'), null);
  assert.equal(store.cursor(), '');
});

test('pending claim prevents cursor advance; old poll cannot restore status after rebind', async t => {
  const { store } = await fixture(t);
  await store.bind(auth, 1000);
  const service = new WeChatService({ store, api: { updates: async () => ({ ret: 0, msgs: [message('unresolved')], get_updates_buf: 'next' }) }, receive: async () => {}, now: () => 1000 });
  await service.resume();
  assert.equal(store.record('unresolved').status, 'pending');
  assert.equal(store.cursor(), '');
  const oldEpoch = store.epoch();
  await store.bind(auth, 1000);
  assert.notEqual(store.epoch(), oldEpoch);
  assert.equal(store.record('unresolved'), null);
});

test('pause during async local confirmation cannot restore an old binding', async t => {
  const { store } = await fixture(t);
  let release;
  const originalBind = store.bind.bind(store);
  store.bind = (...args) => new Promise(resolve => { release = () => resolve(originalBind(...args)); });
  const api = { qr: async () => ({ qrcode: 'q', qrcode_img_content: 'qr' }), qrStatus: async () => ({ status: 'confirmed', bot_token: auth.token, ilink_bot_id: auth.botId, ilink_user_id: auth.userId, baseurl: auth.baseUrl }) };
  const service = new WeChatService({ store, api, receive: async () => {}, now: () => 1000 });
  await service.beginLogin(0);
  await service.checkLogin('q');
  const confirming = service.confirmBinding(service.snapshot().revision);
  await new Promise(resolve => setImmediate(resolve));
  await service.pause();
  release();
  await assert.rejects(confirming, /superseded/u);
  assert.equal(store.binding(), null);
  assert.equal(service.snapshot().status, 'unbound');
});

test('unready shared worker blocks WeChat admission before a durable claim', async t => {
  const { store } = await fixture(t);
  await store.bind(auth, 1000);
  let polled = 0;
  const service = new WeChatService({ store, api: { updates: async () => { polled++; return { ret: 0, msgs: [message('in')], get_updates_buf: 'next' }; } }, receive: async () => {}, backendReady: () => false, now: () => 1000 });
  await service.resume();
  assert.equal(service.snapshot().status, 'backend_unavailable');
  assert.equal(polled, 0);
  assert.equal(store.record('in'), null);
});
