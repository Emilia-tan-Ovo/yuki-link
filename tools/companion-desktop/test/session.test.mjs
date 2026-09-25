import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendSession } from '../backend/session.mjs';
import { DEFAULT_ROLE_CARD } from '../backend/prompt-composer.mjs';

test('one Emilia conversation survives reopening and its provider sees earlier turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const provider = async input => { requests.push(input); return '艾米莉亚：收到 ' + input.messages.at(-1).content; };
  const first = new BackendSession({ directory: dir, provider });
  assert.equal(first.status().identity, 'Emilia');
  assert.equal(first.history().length, 0);
  assert.equal((await first.submit('早上好')).text, '艾米莉亚：收到 早上好');
  first.close();
  const reopened = new BackendSession({ directory: dir, provider });
  assert.deepEqual(reopened.history().map(x => x.role), ['user', 'assistant']);
  await reopened.submit('还记得吗');
  assert.deepEqual(requests[1].messages.slice(-3).map(x => x.content), ['早上好', '艾米莉亚：收到 早上好', '还记得吗']);
  assert.match(requests[0].messages[2].content, /configured/);
  assert.match(requests[0].messages[3].content, /无已注入记忆/);
  assert.match(requests[1].messages[2].content, /configured/); // reopened session does not inherit verified
  reopened.close();
});

test('runtime capability status changes on provider success and failure only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  let fail = false;
  const session = new BackendSession({ directory: dir, provider: async input => { seen.push(JSON.parse(input.messages[2].content.split('\n')[1]).text.service); if (fail) throw Error('remote failed'); return '好'; } });
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
  const session = new BackendSession({ directory: dir, provider: async ({ messages }) => { seen.push(messages[1].content); if (seen.length === 1) await new Promise(resolve => { release = resolve; }); return '好'; } });
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
