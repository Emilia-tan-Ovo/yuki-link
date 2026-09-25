import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { BackendSession } from '../backend/session.mjs';
import { createWorkerHandler } from '../backend/worker.mjs';
import { BackendConnection } from '../desktop/electron/transport.mjs';
import { submittedTurn } from '../desktop/electron/submit-snapshot.mjs';
import { assetResponse } from '../desktop/electron/assets.mjs';
import { fileURLToPath } from 'node:url';

test('transport and worker carry identity; cancel is processed while provider is pending', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-ipc-'));
  const emitted = [], pending = [];
  const handle = createWorkerHandler({ post: message => emitted.push(message), createSession: () => new BackendSession({ directory: dir, provider: input => new Promise(resolve => pending.push({ input, resolve })) }) });
  t.after(async () => { await handle({ type: 'close' }); await rm(dir, { recursive: true, force: true }); });
  await handle({ type: 'start', generation: 7 });
  const snapshot = { roleCard: { schemaVersion: 1, text: '已保存角色卡' }, thinking: { schemaVersion: 1, enabled: true, effort: 'high' } };
  const first = submittedTurn({ id: 'one', requestId: 'one', generation: 7, text: '问', origin: 'typed' }, { snapshot: () => snapshot });
  assert.equal(first.requestId, 'one');
  const work = handle(first);
  await handle({ type: 'cancel-model', requestId: 'one', generation: 7 });
  await work;
  assert.equal(pending[0].input.requestId, 'one');
  assert.equal(pending[0].input.signal.aborted, true);
  assert.equal(emitted.at(-1).type, 'cancel-ack');
  assert.equal(emitted.at(-1).outcome, 'cancelled');
  assert.equal(emitted.at(-1).requestId, 'one');
  pending[0].resolve({ content: '晚回' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(emitted.some(row => row.type === 'reply'), false);
  const next = handle({ ...first, id: 'two', requestId: 'two' });
  pending[1].resolve({ content: '已完成', reasoningContent: '留在文字历史' }); await next;
  await handle({ type: 'cancel-model', requestId: 'two', generation: 7 });
  assert.equal(emitted.at(-1).outcome, 'alreadyCommitted');
  assert.equal(emitted.at(-1).messages.length, 2);
  const before = emitted.length;
  await handle({ ...first, id: 'stale', requestId: 'stale', generation: 6 });
  assert.equal(emitted.length, before);
});

test('transport invalidates messages immediately on close, before replacement starts', async () => {
  const child = new EventEmitter(), received = [], commands = [];
  child.postMessage = command => commands.push(command);
  child.kill = () => child.emit('exit');
  const connection = new BackendConnection({ worker: 'fake-worker', fork: () => child, onMessage: (...args) => received.push(args) });
  connection.start({ preview: true });
  const generation = connection.generation;
  child.emit('message', { type: 'ready' });
  assert.equal(connection.send({ type: 'cancel-model', requestId: 'r' }, generation), true);
  assert.equal(commands.at(-1).generation, generation);
  const closing = connection.close();
  child.emit('message', { type: 'reply', requestId: 'r' });
  assert.deepEqual(received.map(([message]) => message.type), ['ready']);
  assert.equal(connection.send({ type: 'submit' }, generation), false);
  child.emit('message', { type: 'closed' }); await closing;
});

test('shared renderer submit contract is served as browser JavaScript', async () => {
  const response = await assetResponse(fileURLToPath(new URL('../desktop', import.meta.url)), 'yuki://app/turn-contract.mjs');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/javascript');
});
