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
import * as credentialModule from '../desktop/electron/voice-credential.mjs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';

test('packaged credential helper resolves to the installed physical unpacked resource', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.asarUnpack?.includes('desktop/electron/private-voice-directory.ps1'));
  assert.equal(credentialModule.voiceAclHelperPath({ isPackaged: true, resourcesPath: join('installed', 'resources') }),
    join('installed', 'resources', 'app.asar.unpacked', 'desktop', 'electron', 'private-voice-directory.ps1'));
  assert.equal(credentialModule.voiceAclHelperPath().includes('app.asar'), false);
});

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

test('main capture intent is one-shot; checks do not consume; cancel/reconnect/timeout deny', () => {
  const wc = { mainFrame: { url: 'yuki://app/index.html' } };
  const request = { webContents: wc, expected: wc, permission: 'media', details: { isMainFrame: true, requestingUrl: 'yuki://app/index.html', mediaTypes: ['audio'] } };
  const make = () => {
    let now = 0;
    const voice = new VoiceTurnCoordinator({ canAttempt: () => true }), readiness = new VoiceReadiness(); readiness.reset(true);
    const runtime = new VoiceRuntime({ voice, readiness, connection: { generation: 3, state: 'ready', send: () => true }, deliver() {}, settings: { snapshot: () => ({ voice: DEFAULT_VOICE }) }, status: () => ({ service: 'verified' }) });
    // Only the deadline clock is synthetic; permission is exercised at the main runtime seam.
    runtime.permissionIntent.now = () => now;
    runtime.command({ action: 'start' });
    return { runtime, scope: voice.current.scope, expire: () => { now = 30001; } };
  };
  const first = make();
  assert.equal(first.runtime.microphonePermission({ ...request, check: true, origin: 'yuki://app', details: { isMainFrame: true, mediaType: 'audio' } }), true);
  assert.equal(first.runtime.microphonePermission(request), true);
  assert.equal(first.runtime.voice.state, 'preparing');
  assert.equal(first.runtime.microphonePermission(request), false);
  for (const action of ['cancel', 'reconnect', 'timeout', 'ready', 'error', 'config', 'generation', 'scope', 'cleaned']) {
    const h = make();
    if (action === 'cancel') h.runtime.command({ action: 'cancel-turn', scope: h.scope });
    if (action === 'reconnect') h.runtime.invalidate();
    if (action === 'timeout') h.expire();
    if (action === 'ready') h.runtime.event({ event: 'capture-ready', scope: h.scope });
    if (action === 'error') h.runtime.event({ event: 'device-error', scope: h.scope, code: 'CAPTURE_FAILED' });
    if (action === 'config') h.runtime.configure(true);
    if (action === 'generation') ++h.runtime.connection.generation;
    if (action === 'scope') { h.runtime.voice.disconnect(); h.runtime.voice.start(3); }
    if (action === 'cleaned') h.runtime.event({ event: 'cleaned', scope: h.scope });
    assert.equal(h.runtime.microphonePermission(request), false, action);
  }
});
test('renderer gone releases impossible cleanup but fences old events and preserves live cleanup acknowledgements', async t => {
  const main = await readFile(new URL('../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const gone = main.split('\n').find(line => line.includes("win.webContents.on('render-process-gone'"));
  const events = main.slice(main.indexOf("ipcMain.on('yuki:voice-event'"), main.indexOf("ipcMain.on('yuki:voice-load'"));
  for (const state of ['preparing', 'listening']) await t.test(state, async () => {
    const sent = [], delivered = [], handlers = new Map(), readiness = new VoiceReadiness();
    const wc = new EventEmitter(); wc.mainFrame = { url: 'yuki://app/index.html' };
    const request = { webContents: wc, expected: wc, permission: 'media', details: { isMainFrame: true, requestingUrl: 'yuki://app/index.html', mediaTypes: ['audio'] } };
    const voice = new VoiceTurnCoordinator({ canAttempt: () => true });
    const connection = { generation: 3, state: 'ready', send: value => { sent.push(value); return true; }, close() { ++this.generation; this.state = 'disconnected'; } };
    const media = new VoiceRuntime({ voice, readiness, connection, deliver: value => delivered.push(value), settings: { snapshot: () => ({ voice: { ...DEFAULT_VOICE, enabled: true } }) }, status: () => ({ service: 'configured' }) });
    runInNewContext(`let rendererReady = true; ${gone}\n${events}`, { win: { webContents: wc }, media, connection, trusted: () => true, ipcMain: { on: (name, fn) => handlers.set(name, fn) } });
    const event = (event, scope, generation = scope.connectionGeneration, extra = {}) => handlers.get('yuki:voice-event')({}, { schemaVersion: 1, event, scope, generation, ...extra });
    media.configure(true); media.command({ action: 'start' });
    const oldScope = voice.current.scope;
    if (state === 'listening') event('capture-ready', oldScope);
    assert.equal(voice.state, state);
    wc.emit('render-process-gone');
    assert.equal(voice.current, null);
    assert.equal(media.microphonePermission(request), false);
    assert.ok(sent.some(value => value.type === 'voice-stop' && value.scope === oldScope));
    ++connection.generation; connection.state = 'ready'; media.configure(true);
    media.command({ action: 'start' });
    assert.ok(voice.current, 'replacement renderer must be allowed to start without a dead owner cleaned acknowledgement');
    const scope = voice.current.scope;
    assert.equal(delivered.findLast(value => value.type === 'voice-state').outcome, 'accepted');
    assert.notEqual(scope.voiceEpoch, oldScope.voiceEpoch);
    const before = structuredClone(readiness.facts);
    for (const generation of [oldScope.connectionGeneration, connection.generation]) {
      for (const name of ['cleaned', 'devices-changed', 'device-error', 'capture-ready', 'capture-finished']) event(name, oldScope, generation, { code: 'PERMISSION_DENIED' });
    }
    assert.equal(voice.current.scope, scope); assert.equal(voice.state, 'preparing');
    assert.deepEqual(readiness.facts, before);
    assert.equal(media.microphonePermission(request), true, 'late old events must not clear the new permission intent');
    event('capture-ready', scope);
    media.command({ action: 'cancel-turn', scope });
    media.command({ action: 'start' }); assert.equal(voice.current.scope, scope);
    event('cleaned', oldScope);
    media.command({ action: 'start' }); assert.equal(voice.current.scope, scope);
    event('cleaned', scope);
    media.command({ action: 'start' });
    const liveScope = voice.current.scope; assert.notEqual(liveScope, scope);
    await media.reconfigure(async () => {}, async () => 'fixture');
    media.command({ action: 'start' }); assert.equal(voice.current, null, 'live reconfiguration must still wait for cleaned');
    event('cleaned', scope);
    media.command({ action: 'start' }); assert.equal(voice.current, null);
    event('cleaned', liveScope);
    media.command({ action: 'start' }); assert.ok(voice.current);
    media.invalidate();
  });
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
