import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceReadiness, allowMicrophone } from '../desktop/electron/voice-readiness.mjs';
import { VoiceRuntime } from '../desktop/electron/voice-runtime.mjs';
import { VoiceTurnCoordinator } from '../desktop/electron/voice-turn.mjs';
import { DEFAULT_VOICE } from '../desktop/voice-config.mjs';
import { pcm16Wav } from '../desktop/media/wav.mjs';
import { VoiceCredentialStore } from '../desktop/electron/voice-credential.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readiness distinguishes configured, canAttempt and verified; refresh invalidates all observed facts', () => {
  const r = new VoiceReadiness(); assert.equal(r.snapshot(true, 'verified').voice.canAttempt, false);
  r.reset(true); let s = r.snapshot(true, 'verified'); assert.equal(s.voice.implemented, true); assert.equal(s.voice.canAttempt, true); assert.equal(s.voice.ready, false); assert.equal(s.live2d.ready, false);
  r.provider('asr', true); r.provider('tts', true); Object.assign(r.facts, { permission: 'granted', capture: 'ready', playback: 'ready' });
  assert.equal(r.snapshot(true, 'verified').voice.ready, true); assert.equal(r.snapshot(true, 'configured').voice.ready, false);
  const rev = r.revision; r.reset(true); assert.ok(r.revision > rev); assert.equal(r.snapshot(true, 'verified').voice.ready, false); assert.equal(r.facts.permission, 'unknown');
});
test('microphone permissions require current intent, trusted main frame and audio only', () => {
  const wc = { mainFrame: { url: 'yuki://app/index.html' } }, base = { webContents: wc, expected: wc, permission: 'media', intent: true, details: { isMainFrame: true, requestingUrl: 'yuki://app/index.html', mediaTypes: ['audio'] } };
  assert.equal(allowMicrophone(base), true);
  for (const delta of [{ intent: false }, { webContents: {} }, { permission: 'display-capture' }, { details: { ...base.details, mediaTypes: ['audio','video'] } }, { details: { ...base.details, mediaTypes: [] } }, { details: { ...base.details, isMainFrame: false } }]) assert.equal(allowMicrophone({ ...base, ...delta }), false);
  assert.equal(allowMicrophone({ ...base, check: true, origin: 'yuki://app', details: { isMainFrame: true, mediaType: 'audio' } }), true);
  assert.equal(allowMicrophone({ ...base, check: true, origin: 'yuki://app', details: { isMainFrame: true, mediaType: 'unknown' } }), false);
});
test('main routing validates WAV and scope, delivers one final, then only committed voice output', () => {
  const sent = [], delivered = [], readiness = new VoiceReadiness(); readiness.reset(true);
  const voice = new VoiceTurnCoordinator({ canAttempt: () => true });
  const runtime = new VoiceRuntime({ voice, readiness, connection: { generation: 3, state: 'ready', send: x => { sent.push(structuredClone(x)); return true; } }, deliver: x => delivered.push(structuredClone(x)), settings: { snapshot: () => ({ voice: DEFAULT_VOICE }) }, status: () => ({ service: 'verified' }) });
  runtime.command({ action: 'start' }); const scope = voice.current.scope;
  runtime.event({ event: 'capture-ready', scope }); runtime.command({ action: 'finish', scope });
  const audio = () => ({ event: 'capture-finished', scope, requestId: scope.requestId, wav: pcm16Wav(new Float32Array([1]), 8000) });
  runtime.event(audio()); runtime.event(audio()); assert.equal(sent.filter(x => x.type === 'voice-asr').length, 1);
  runtime.backend({ type: 'voice-asr-final', scope, requestId: scope.requestId, text: '问' }, 3);
  runtime.backend({ type: 'voice-asr-final', scope, requestId: scope.requestId, text: '问' }, 3);
  assert.equal(delivered.filter(x => x.type === 'voice-final').length, 1);
  voice.acceptSubmit(scope, 'model', '问'); runtime.backend({ type: 'reply', origin: 'voice-final', voiceScope: scope, requestId: 'model', committed: true }, 3);
  assert.equal(sent.filter(x => x.type === 'voice-tts').length, 1);
  runtime.command({ action: 'stop-output', scope }); runtime.backend({ type: 'voice-audio', scope, requestId: 'model', wav: pcm16Wav(new Float32Array([1]), 8000) }, 3);
  assert.equal(delivered.some(x => x.type === 'voice-play'), false); assert.equal(sent.some(x => /engineering|task-stop/.test(x.type)), false);
  runtime.command({ action: 'start' }); assert.equal(voice.current.scope, scope);
  runtime.event({ event: 'cleaned', scope }); runtime.command({ action: 'start' }); assert.notEqual(voice.current.scope, scope);
});
test('voice credential is a separate encrypted atomic store and fails closed without storage protection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yuki-credential-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'input.txt'); await writeFile(source, 'fixture-voice-secret');
  const protections = [], crypto = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString() };
  const store = new VoiceCredentialStore(dir, crypto, async (_path, action) => { protections.push(action); });
  assert.equal(await store.importFile(source), undefined); assert.equal(await store.read(), 'fixture-voice-secret');
  assert.ok(protections.includes('restrict')); assert.ok(protections.includes('verify')); assert.equal((await readFile(store.file)).includes('fixture-voice-secret'), false);
  store.protect = async () => { throw Error('denied'); }; assert.equal(await store.read(), ''); await assert.rejects(store.importFile(source));
});
