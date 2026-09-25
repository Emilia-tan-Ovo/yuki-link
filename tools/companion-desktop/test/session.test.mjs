import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendSession } from '../backend/session.mjs';

test('one Emilia conversation survives reopening and its provider sees earlier turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const provider = async input => { requests.push(input); return '艾米莉亚：收到 ' + input.text; };
  const first = new BackendSession({ directory: dir, provider });
  assert.equal(first.status().identity, 'Emilia');
  assert.equal(first.history().length, 0);
  assert.equal((await first.submit('早上好')).text, '艾米莉亚：收到 早上好');
  first.close();
  const reopened = new BackendSession({ directory: dir, provider });
  assert.deepEqual(reopened.history().map(x => x.role), ['user', 'assistant']);
  await reopened.submit('还记得吗');
  assert.deepEqual(requests[1].history.map(x => x.content), ['早上好', '艾米莉亚：收到 早上好']);
  reopened.close();
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
