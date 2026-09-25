import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendSession } from '../backend/session.mjs';
import { DEFAULT_ROLE_CARD } from '../backend/prompt-composer.mjs';

function runtimeService(messages) {
  const marker = '\nRuntime Capabilities（本轮受信快照）：\n';
  assert.equal(messages[0].role, 'system');
  const [core, snapshot] = messages[0].content.split(marker);
  assert.ok(core);
  assert.ok(snapshot);
  return JSON.parse(snapshot).text.service;
}

test('one Emilia conversation survives reopening and its provider sees earlier turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const provider = async input => { requests.push(input); return { content: '艾米莉亚：收到 ' + input.messages.at(-1).content, reasoningContent: null, metadata: null }; };
  const first = new BackendSession({ directory: dir, provider });
  assert.equal(first.status().identity, 'Emilia');
  assert.equal(first.history().length, 0);
  const firstReply = await first.submit('早上好');
  assert.equal(firstReply.text, '艾米莉亚：收到 早上好');
  assert.deepEqual(firstReply.messages, first.displayHistory());
  first.close();
  const reopened = new BackendSession({ directory: dir, provider });
  assert.deepEqual(reopened.history().map(x => x.role), ['user', 'assistant']);
  await reopened.submit('还记得吗');
  assert.deepEqual(requests[1].messages.slice(-3).map(x => x.content), ['早上好', '艾米莉亚：收到 早上好', '还记得吗']);
  assert.equal(runtimeService(requests[0].messages), 'configured');
  assert.equal(requests[0].messages[1].role, 'user');
  assert.ok(requests[0].messages[1].content.includes(JSON.stringify(DEFAULT_ROLE_CARD.text)));
  assert.ok(requests[0].messages[1].content.includes('Companion Memory：无已注入记忆。'));
  assert.equal(runtimeService(requests[1].messages), 'configured'); // reopened session does not inherit verified
  reopened.close();
});

test('runtime capability status changes on provider success and failure only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  let fail = false;
  const session = new BackendSession({ directory: dir, provider: async input => { seen.push(runtimeService(input.messages)); if (fail) throw Error('remote failed'); return { content: '好', reasoningContent: null, metadata: null }; } });
  await session.submit('A');
  assert.equal(session.status().service, 'verified');
  fail = true;
  await assert.rejects(session.submit('B'), /remote failed/);
  assert.equal(session.status().service, 'unknown');
  await assert.rejects(session.submit(' '), /请输入/);
  assert.equal(session.status().service, 'unknown');
  session.busy = true;
  await assert.rejects(session.submit('忙吗'), /上一条/);
  session.busy = false;
  assert.equal(session.status().service, 'unknown');
  await assert.rejects(session.submit('C'), /remote failed/);
  assert.deepEqual(seen, ['configured', 'verified', 'unknown']);
  session.close();
});

test('a submitted role card is frozen per turn, including an in-flight save', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release;
  const seen = [];
  const session = new BackendSession({ directory: dir, provider: async ({ messages }) => { seen.push(messages[1].content); if (seen.length === 1) await new Promise(resolve => { release = resolve; }); return { content: '好', reasoningContent: null, metadata: null }; } });
  const a = { schemaVersion: 1, text: '卡 A' }, b = { schemaVersion: 1, text: '卡 B' };
  const first = session.submit('T1', a);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await first;
  await session.submit('T2', b);
  assert.match(seen[0], /卡 A/);
  assert.match(seen[1], /卡 B/);
  assert.equal(seen[0].includes('卡 B'), false);
  session.close();
});

test('unconfigured real service reports a blocker and never claims a reply', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = new BackendSession({ directory: dir, provider: null });
  assert.equal(session.status().service, 'unconfigured');
  await assert.rejects(session.submit('你好'), /DeepSeek 凭据未配置/);
  assert.equal(session.history().length, 0);
  session.close();
});

test('reasoning is display-only, bounded and absent from next provider context and memory seam', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = 'REASONING_ONLY_MARKER';
  const requests = [];
  const provider = async input => { requests.push(input); return { content: '最终回答', reasoningContent: requests.length === 1 ? marker + '界'.repeat(100000) : null, metadata: { source: 'deepseek', requestedThinking: 'high', requestModel: 'deepseek-flash', responseModel: 'served', fullResponseMs: 1234, finishReason: 'stop' } }; };
  const first = new BackendSession({ directory: dir, provider });
  const reply = await first.submit('第一轮', DEFAULT_ROLE_CARD, { schemaVersion: 1, enabled: true, effort: 'high' });
  assert.equal(reply.messages[1].reasoningContent.includes(marker), true);
  assert.equal(reply.messages[1].metadata.reasoningTruncated, true);
  assert.ok(Buffer.byteLength(reply.messages[1].reasoningContent) <= 256 * 1024);
  assert.equal(JSON.stringify(first.history()).includes(marker), false);
  first.close();
  const reopened = new BackendSession({ directory: dir, provider });
  assert.equal(reopened.displayHistory()[1].reasoningContent.includes(marker), true);
  await reopened.submit('第二轮');
  assert.equal(JSON.stringify(requests[1].messages).includes(marker), false);
  assert.equal(requests[1].messages[1].content.includes(marker), false);
  reopened.close();
});

test('failed provider leaves no turn and releases busy; persistence failure is distinct', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = new BackendSession({ directory: dir, provider: async () => { throw Error('remote failed'); } });
  await assert.rejects(session.submit('问'), /remote failed/);
  assert.equal(session.busy, false);
  assert.deepEqual(session.displayHistory(), []);
  session.close();
});

test('provider success followed by assistant insert failure rolls back and reports local storage failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = new BackendSession({ directory: dir, provider: async () => ({ content: '完成', reasoningContent: null, metadata: null }) });
  session.memory.db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'private path and payload'); END");
  await assert.rejects(session.submit('提问'), error => {
    assert.equal(error.message, '本地对话保存失败，请稍后重试。');
    assert.equal(error.name, 'LocalPersistenceError');
    return true;
  });
  assert.deepEqual(session.displayHistory(), []);
  assert.equal(session.busy, false);
  assert.equal(session.status().service, 'verified');
  session.close();
});

test('reasoning truncation retains complete UTF-8 code points at the 256 KiB boundary', async t => {
  const limit = 256 * 1024;
  const cases = [
    ['ASCII exact boundary', 'a'.repeat(limit + 1), 'a'.repeat(limit)],
    ['two-byte exact boundary', 'é'.repeat(limit / 2 + 1), 'é'.repeat(limit / 2)],
    ['three-byte partial boundary', 'a'.repeat(limit - 1) + '界', 'a'.repeat(limit - 1)],
    ['four-byte partial boundary', 'a'.repeat(limit - 2) + '😀', 'a'.repeat(limit - 2)]
  ];
  for (const [name, reasoningContent, expected] of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const session = new BackendSession({ directory: dir, provider: async () => ({ content: '最终回答', reasoningContent, metadata: { source: 'deepseek' } }) });
    const reply = await session.submit(name);
    const saved = reply.messages[1];
    assert.equal(saved.reasoningContent, expected, name);
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(saved.reasoningContent)), expected);
    assert.ok(Buffer.byteLength(saved.reasoningContent) <= limit);
    assert.equal(saved.metadata.reasoningTruncated, true);
    assert.equal(saved.text, '最终回答');
    session.close();
  }
});

test('explicit memory reaches composer, correction removes old prompt context, and reopening preserves forgetting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const provider = async ({ messages }) => { seen.push(JSON.stringify(messages)); return { content: '收到', reasoningContent: 'PRIVATE_REASONING', metadata: null }; };
  let session = new BackendSession({ directory: dir, provider });
  await session.submit('我以前喜欢红茶');
  const old = session.remember({ text: '喜欢红茶', sourceKind: 'explicit_chat' });
  await session.submit('红茶呢');
  assert.match(seen.at(-1), /喜欢红茶/);
  assert.doesNotMatch(seen.at(-1), /PRIVATE_REASONING/);
  assert.equal(session.runtimeCapabilities().memoryManagement, true);
  const fresh = session.correctMemory(old.id, '喜欢绿茶');
  await session.submit('绿茶呢');
  assert.match(seen.at(-1), /喜欢绿茶/);
  assert.doesNotMatch(seen.at(-1), /红茶/);
  session.close(); session = new BackendSession({ directory: dir, provider });
  assert.ok(session.displayHistory().length >= 2);
  session.forgetMemory(fresh.id);
  await session.submit('绿茶呢');
  assert.doesNotMatch(seen.at(-1), /喜欢绿茶/);
  session.close();
});

test('memory commands reject provider busy and unrelated facts do not enter prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release;
  const seen = [];
  const session = new BackendSession({ directory: dir, provider: async ({ messages }) => { seen.push(JSON.stringify(messages)); await new Promise(resolve => { release = resolve; }); return { content: '好' }; } });
  const entry = session.remember({ text: '喜欢红茶', sourceKind: 'explicit_chat' });
  const pending = session.submit('谈谈天气');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(seen[0], /喜欢红茶/);
  assert.throws(() => session.forgetMemory(entry.id), /上一条/);
  assert.equal(session.listMemories().length, 1);
  release(); await pending; session.close();
});
