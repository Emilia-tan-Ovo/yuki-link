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
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SettingsStore } from '../desktop/electron/settings-store.mjs';
import { VoiceRuntime } from '../desktop/electron/voice-runtime.mjs';
import { VoiceTurnCoordinator } from '../desktop/electron/voice-turn.mjs';
import { VoiceReadiness } from '../desktop/electron/voice-readiness.mjs';

for (const action of ['voice-save', 'voice-credential']) test(`${action} IPC hot config preserves pending typed request and generation`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-voice-config-'));
  const settings = await SettingsStore.load(join(dir, 'settings.json'));
  await settings.saveVoice({ ...DEFAULT_VOICE, enabled: true });
  const posts = [], providers = [], handlers = new Map(); let pending, sessions = 0, voiceKey = 'old-fixture';
  const handle = createWorkerHandler({ post: m => { posts.push(m); child.emit('message', m); },
    createSession: () => { ++sessions; return new BackendSession({ directory: dir, provider: input => new Promise(resolve => { pending = { input, resolve }; }) }); },
    createVoice: config => { providers.push(config); return {}; } });
  const child = new EventEmitter(); child.postMessage = data => { void handle(data); }; child.kill = () => child.emit('exit');
  const connection = new BackendConnection({ worker: 'fixture', fork: () => child, onMessage() {} });
  connection.start({ voiceConfig: settings.snapshot().voice, voiceKey, configRevision: 1 });
  t.after(async () => { await connection.close(); await rm(dir, { recursive: true, force: true }); });
  const generation = connection.generation;
  const work = handle({ type: 'submit', generation, requestId: 'typed-pending', origin: 'typed', text: '继续文字' });
  const voice = new VoiceTurnCoordinator({ canAttempt: () => true });
  const media = new VoiceRuntime({ voice, connection, deliver() {}, settings, readiness: new VoiceReadiness(), status: () => ({ service: 'configured' }) });
  media.configure(true); media.activeModel = 'typed-pending';
  let done; const notice = new Promise(resolve => { done = resolve; });
  const main = readFileSync(new URL('../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const start = main.slice(main.indexOf('async function start()'), main.indexOf('function workbenchUrl'));
  const ipc = main.slice(main.indexOf("ipcMain.on('yuki:voice-save'"), main.indexOf("ipcMain.on('yuki:memory'"));
  runInNewContext(`let startRevision = 0; ${start}\n${ipc}`, { media, connection, settings, preview: false, quitting: false,
    dataDir: () => dir, key: async () => 'text-fixture', win: {}, trusted: () => true, deliver: value => { if (value.type === 'notice') done(value); },
    voiceCredentials: { read: async () => voiceKey, importFile: async () => { voiceKey = 'new-fixture'; } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['fixture'] }) },
    ipcMain: { on: (name, fn) => handlers.set(name, fn) } });
  handlers.get('yuki:' + action)({}, { ...DEFAULT_VOICE, enabled: true, inputDevice: 'new-input' });
  const result = await notice;
  assert.match(result.text, /已.*保存/);
  assert.equal(connection.generation, generation);
  assert.equal(pending.input.signal.aborted, false);
  assert.equal(media.activeModel, 'typed-pending');
  assert.equal(sessions, 1);
  assert.equal(providers.length, 2);
  assert.equal(providers.at(-1).key, action === 'voice-credential' ? 'new-fixture' : 'old-fixture');
  if (action === 'voice-save') assert.equal(providers.at(-1).config.inputDevice, 'new-input');
  pending.resolve({ content: '文字完成' }); await work;
  const reply = posts.find(m => m.type === 'reply');
  assert.equal(reply.generation, generation); assert.equal(reply.requestId, 'typed-pending'); assert.equal(reply.committed, true);
});

test('voice hot swap aborts pending old provider, drops late output and fences revision/generation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-voice-revision-'));
  const posts = [], providers = []; let finish, oldSignal;
  const handle = createWorkerHandler({ post: m => posts.push(structuredClone(m)),
    createSession: () => new BackendSession({ directory: dir, provider: async () => ({ content: '文字' }) }),
    createVoice: ({ key }) => { providers.push(key); return { transcribe: (_input, signal) => key === 'old' ? new Promise(resolve => { finish = resolve; oldSignal = signal; }) : Promise.resolve({ text: key }) }; } });
  t.after(async () => { await handle({ type: 'close' }); await rm(dir, { recursive: true, force: true }); });
  const voiceConfig = { ...DEFAULT_VOICE, enabled: true };
  await handle({ type: 'start', generation: 7, configRevision: 1, voiceConfig, voiceKey: 'old' });
  const scope = { schemaVersion: 1, connectionGeneration: 7, voiceTurnId: 'voice', voiceEpoch: 1, requestId: 'capture' };
  await handle({ type: 'voice-start', generation: 7, scope });
  const audio = scope => ({ type: 'voice-asr', generation: 7, scope, requestId: scope.requestId, wav: pcm16Wav(new Float32Array([1]), 8000) });
  const pending = handle(audio(scope));
  await handle({ type: 'voice-configure', generation: 7, configRevision: 2, voiceConfig, voiceKey: 'new' });
  assert.equal(oldSignal.aborted, true);
  finish({ text: 'late-old' }); await pending;
  assert.equal(posts.some(m => m.type === 'voice-asr-final'), false);
  await handle({ type: 'voice-configure', generation: 6, configRevision: 3, voiceConfig, voiceKey: 'stale-generation' });
  await handle({ type: 'voice-configure', generation: 7, configRevision: 1, voiceConfig, voiceKey: 'stale-revision' });
  const nextScope = { ...scope, voiceEpoch: 2, voiceTurnId: 'new-voice' };
  await handle({ type: 'voice-start', generation: 7, scope: nextScope }); await handle(audio(nextScope));
  assert.equal(posts.at(-1).text, 'new'); assert.deepEqual(providers, ['old', 'new']);
});

test('voice save while worker is not ready commits locally; normal start takes the new config and key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-voice-disconnected-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = await SettingsStore.load(join(dir, 'settings.json'));
  const readiness = new VoiceReadiness(), configurations = [], commands = [];
  const connection = { generation: 4, state: 'disconnected', send: command => { commands.push(command); return false; }, close() { ++this.generation; }, start: config => configurations.push(config) };
  const voice = new VoiceTurnCoordinator({ canAttempt: () => true });
  const media = new VoiceRuntime({ voice, connection, readiness, settings, deliver() {}, status: () => ({ service: 'disconnected' }) });
  const key = async () => 'committed-fixture';
  await media.reconfigure(() => settings.saveVoice({ ...DEFAULT_VOICE, enabled: true, inputDevice: 'saved-input' }), key);
  assert.equal(connection.generation, 4); assert.equal(configurations.length, 0);
  assert.equal((await SettingsStore.load(join(dir, 'settings.json'))).snapshot().voice.inputDevice, 'saved-input');
  const main = readFileSync(new URL('../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const source = main.slice(main.indexOf('async function start()'), main.indexOf('function workbenchUrl'));
  const start = runInNewContext(`let startRevision = 0; ${source}\nstart`, { media, connection, settings, readiness, preview: false, quitting: false, deliver() {}, voiceCredentials: { read: key }, key: async () => 'text-fixture', dataDir: () => dir });
  await start();
  assert.equal(configurations.length, 1); assert.equal(configurations[0].voiceKey, 'committed-fixture');
  assert.equal(configurations[0].voiceConfig.inputDevice, 'saved-input');
  assert.equal(configurations[0].configRevision, readiness.revision);
});

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
