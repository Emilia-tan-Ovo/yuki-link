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
import { pcm16Wav } from '../desktop/media/wav.mjs';
import { DEFAULT_VOICE } from '../desktop/voice-config.mjs';

test('worker voice ASR is once per scope; TTS reads committed text only; stale/cancel loses audio', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-voice-ipc-')), emitted = [], calls = [];
  const handle = createWorkerHandler({ post: m => emitted.push(structuredClone(m)), createSession: () => new BackendSession({ directory: dir, provider: async () => ({ content: '正文', reasoningContent: '仅历史' }) }), createVoice: () => ({ transcribe: async input => { calls.push(['asr', input]); return { text: '问' }; }, synthesize: async input => { calls.push(['tts', input]); return { wav: pcm16Wav(new Float32Array([1]), 8000) }; } }) });
  t.after(async () => { await handle({ type: 'close' }); await rm(dir, { recursive: true, force: true }); });
  await handle({ type: 'start', generation: 1, voiceConfig: { ...DEFAULT_VOICE, enabled: true }, voiceKey: 'fake' });
  const scope = { schemaVersion: 1, connectionGeneration: 1, voiceTurnId: 'voice', voiceEpoch: 1, requestId: 'capture' };
  await handle({ type: 'voice-start', generation: 1, scope });
  const audio = () => ({ type: 'voice-asr', generation: 1, scope, requestId: 'capture', wav: pcm16Wav(new Float32Array([1]), 8000) });
  await handle(audio()); await handle(audio()); assert.equal(calls.length, 1); assert.equal(emitted.at(-1).text, '问');
  await handle({ type: 'voice-tts', generation: 1, scope, requestId: 'not-committed', finalText: 'forged' }); assert.equal(calls.length, 1);
  await handle({ type: 'submit', generation: 1, requestId: 'r', origin: 'voice-final', voiceScope: scope, text: '问' });
  await handle({ type: 'voice-tts', generation: 1, scope, requestId: 'r', finalText: 'forged' });
  assert.equal(calls[1][1].finalText, '正文'); assert.equal(JSON.stringify(calls[1]).includes('仅历史'), false);
  assert.equal(emitted.at(-1).type, 'voice-audio');
  await handle({ type: 'voice-stop', generation: 1, scope }); await handle({ type: 'voice-tts', generation: 1, scope, requestId: 'r' }); assert.equal(calls.length, 2);
});

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
test('audio worklet is served as JavaScript and stale worker ASR cannot deliver after cancellation', async t => {
  const response = await assetResponse(fileURLToPath(new URL('../desktop', import.meta.url)), 'yuki://app/media/recorder-worklet.mjs');
  assert.equal(response.headers.get('content-type'), 'text/javascript');
  const dir = await mkdtemp(join(tmpdir(), 'yuki-voice-cancel-')); let finish; const posts = [];
  const handle = createWorkerHandler({ post: m => posts.push(structuredClone(m)), createSession: () => new BackendSession({ directory: dir, provider: async () => ({ content: '文字' }) }), createVoice: () => ({ transcribe: () => new Promise(r => { finish = r; }) }) });
  t.after(async () => { await handle({ type: 'close' }); await rm(dir, { recursive: true, force: true }); });
  await handle({ type: 'start', generation: 1, voiceConfig: { ...DEFAULT_VOICE, enabled: true }, voiceKey: 'fixture' });
  const scope = { schemaVersion: 1, connectionGeneration: 1, voiceTurnId: 'voice', voiceEpoch: 1, requestId: 'capture' };
  await handle({ type: 'voice-start', generation: 1, scope });
  const pending = handle({ type: 'voice-asr', generation: 1, scope, requestId: 'capture', wav: pcm16Wav(new Float32Array([1]), 8000) });
  await handle({ type: 'voice-stop', generation: 1, scope }); finish({ text: 'late' }); await pending;
  assert.equal(posts.some(m => m.type === 'voice-asr-final'), false);
});
