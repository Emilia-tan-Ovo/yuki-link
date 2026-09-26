import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCapture, BrowserPlayback } from '../desktop/media/devices.mjs';
import { pcm16Wav, inspectPcmWav } from '../desktop/media/wav.mjs';
import { RendererVoice } from '../desktop/voice-ui.mjs';
const turn = () => new Promise(r => setImmediate(r));
function fixture() {
  const facts = { requests: [], contexts: [], nodes: [], stopped: 0, played: 0, sinks: [] };
  const track = { stop() { facts.stopped++; }, addEventListener() {}, removeEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    constructor() { this.sampleRate = 48000; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; facts.contexts.push(this); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    async setSinkId(value) { facts.sinks.push(value); }
    async decodeAudioData() { const data = new Float32Array([1, .5, 0]); const b = { length: 3, sampleRate: 48000, numberOfChannels: 1, duration: 1, getChannelData: () => data }; facts.buffer = b; return b; }
    createAnalyser() { return { fftSize: 256, connect() {}, disconnect() {}, getFloatTimeDomainData: a => a.fill(.5) }; }
    createBufferSource() { const node = { connect() {}, disconnect() {}, stop() {}, start() { facts.played++; } }; facts.source = node; return node; }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: 10 }; }
  }
  class Worklet { constructor() { this.port = { onmessage: null, close() {}, postMessage: () => this.port.onmessage?.({ data: { finished: true } }) }; facts.nodes.push(this); } connect() {} disconnect() {} }
  return { facts, stream, mediaDevices: { getUserMedia: async options => { facts.requests.push(options); return stream; } }, AudioContext: Context, AudioWorkletNode: Worklet };
}
test('capture is explicit audio-only, waits for PCM, finishes with actual rate and cleans all owners', async () => {
  const f = fixture(), events = [], capture = new BrowserCapture({ ...f, emit: e => events.push(e) });
  assert.equal(f.facts.requests.length, 0);
  const opening = capture.start({ inputDevice: 'chosen' }); await turn();
  assert.deepEqual(f.facts.requests[0], { audio: { deviceId: { exact: 'chosen' }, channelCount: 1 }, video: false });
  assert.equal(events.some(e => e.type === 'listening'), false);
  f.facts.nodes[0].port.onmessage({ data: { samples: new Float32Array([0, .5]) } }); await opening;
  assert.equal(events.at(-1).type, 'listening');
  const bytes = await capture.finish(); assert.equal(inspectPcmWav(bytes).sampleRate, 48000);
  assert.equal(f.facts.stopped, 1); assert.equal(f.facts.contexts[0].state, 'closed');
  await assert.rejects(capture.finish());
});
test('cancel during pending permission stops late tracks without a new graph', async () => {
  const f = fixture(); let grant; f.mediaDevices.getUserMedia = () => new Promise(r => { grant = r; });
  const capture = new BrowserCapture(f), opening = capture.start({}); capture.cancel();
  await assert.rejects(opening, /CANCELLED/); grant(f.stream); await turn(); assert.equal(f.facts.stopped, 1); assert.ok(f.facts.contexts.every(c => c.state === 'closed'));
});
test('capture rejects oversized PCM and flush timeout and releases resources', async () => {
  for (const mode of ['limit', 'flush']) {
    const f = fixture(), capture = new BrowserCapture({ ...f, flushMs: 10 }), opening = capture.start({}); await turn();
    f.facts.nodes[0].port.onmessage({ data: { samples: new Float32Array([0]) } }); await opening;
    if (mode === 'limit') f.facts.nodes[0].port.onmessage({ data: { samples: new Float32Array(1440001) } });
    else f.facts.nodes[0].port.postMessage = () => {};
    await assert.rejects(capture.finish(), mode === 'limit' ? /AUDIO_LIMIT/ : /CAPTURE_FAILED/); assert.equal(f.facts.contexts[0].state, 'closed');
  }
});
test('playback requires output progress before started, emits RMS, then cleans on ended', async () => {
  const f = fixture(), events = [], playback = new BrowserPlayback({ ...f, emit: e => events.push(e), pollMs: 2 });
  await playback.play({ wav: pcm16Wav(new Float32Array([1]), 48000), outputDevice: 'speaker' });
  assert.deepEqual(f.facts.sinks, ['speaker']); assert.equal(events.some(e => e.type === 'started'), false);
  f.facts.contexts[0].currentTime = .5; await new Promise(r => setTimeout(r, 8));
  assert.equal(events.filter(e => e.type === 'started').length, 1); assert.equal(events.find(e => e.type === 'amplitude').value, .5);
  f.facts.contexts[0].currentTime = 1.1; await new Promise(r => setTimeout(r, 8));
  assert.equal(events.at(-1).type, 'ended'); assert.equal(f.facts.contexts[0].state, 'closed'); assert.ok(f.facts.buffer.getChannelData(0).every(x => x === 0));
});
test('late decode after stop is erased and never starts output', async () => {
  const f = fixture(); let decode; const original = f.AudioContext.prototype.decodeAudioData;
  f.AudioContext.prototype.decodeAudioData = () => new Promise(r => { decode = r; });
  const playback = new BrowserPlayback(f), pending = playback.play({ wav: pcm16Wav(new Float32Array([1]), 48000) });
  playback.stop(); await assert.rejects(pending, /CANCELLED/); const buffer = await original(); decode(buffer); await turn();
  assert.equal(f.facts.played, 0); assert.ok(buffer.getChannelData(0).every(x => x === 0));
});
test('output selection degrades only when API absent, sink failure never starts, stop prevents late events', async () => {
  const f = fixture(), events = []; delete f.AudioContext.prototype.setSinkId;
  const playback = new BrowserPlayback({ ...f, emit: e => events.push(e), pollMs: 2 });
  await playback.play({ wav: pcm16Wav(new Float32Array([1]), 8000), outputDevice: 'chosen' });
  assert.equal(events[0].type, 'default-output'); await playback.stop(); const count = events.length; await new Promise(r => setTimeout(r, 5)); assert.equal(events.length, count);
  const other = fixture(); other.AudioContext.prototype.setSinkId = async () => { throw Error('private device'); };
  await assert.rejects(new BrowserPlayback(other).play({ wav: pcm16Wav(new Float32Array([1]), 8000), outputDevice: 'missing' }), /PLAYBACK_FAILED/); assert.equal(other.facts.played, 0); assert.equal(other.facts.contexts[0].state, 'closed');
});
test('renderer rejects duplicate/stale playback and reconnect discards late device results', async () => {
  const f = fixture(), sent = [], elements = new Map(); const element = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  let generation = 1;
  const ui = new RendererVoice({ host: { send: (...args) => sent.push(args) }, element, getGeneration: () => generation, notice() {}, ...f });
  const scope = { schemaVersion: 1, connectionGeneration: 1, voiceTurnId: 's', voiceEpoch: 1, requestId: 'capture' };
  await ui.receive({ type: 'voice-state', generation, scope, state: 'playback-pending' });
  const audio = () => ({ type: 'voice-play', generation: 1, scope, requestId: 'model', wav: pcm16Wav(new Float32Array([1]), 8000) });
  await ui.receive(audio()); await ui.receive(audio()); assert.equal(f.facts.played, 1);
  generation = 2; await ui.receive({ type: 'connection', generation }); const stale = audio(); await ui.receive(stale);
  assert.equal(f.facts.played, 1); assert.ok(stale.wav.every(x => x === 0)); assert.equal(f.facts.contexts[0].state, 'closed');
});
test('silent decoded speech is a playback failure, never a started claim', async () => {
  const f = fixture(), events = [];
  f.AudioContext.prototype.decodeAudioData = async () => ({ numberOfChannels: 1, length: 2, duration: .01, getChannelData: () => new Float32Array(2) });
  await assert.rejects(new BrowserPlayback({ ...f, emit: e => events.push(e) }).play({ wav: pcm16Wav(new Float32Array([0]), 8000) }), /PLAYBACK_FAILED/);
  assert.equal(f.facts.played, 0); assert.equal(events.some(e => e.type === 'started'), false);
});
test('explicit playback after autoplay block reuses bounded audio without a second provider request', async () => {
  const f = fixture(), sent = [], nodes = new Map(); let blocked = true;
  f.AudioContext.prototype.resume = async function () { if (blocked) { const error = Error('blocked'); error.name = 'NotAllowedError'; throw error; } this.state = 'running'; };
  const ui = new RendererVoice({ host: { send: (...args) => sent.push(args) }, element: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); }, getGeneration: () => 1, notice() {}, ...f });
  const scope = { schemaVersion: 1, connectionGeneration: 1, voiceTurnId: 's', voiceEpoch: 1, requestId: 'capture' };
  await ui.receive({ type: 'voice-state', generation: 1, scope, state: 'playback-pending' });
  await ui.receive({ type: 'voice-play', generation: 1, scope, requestId: 'model', wav: pcm16Wav(new Float32Array([1]), 8000) });
  assert.equal(nodes.get('voice-play').disabled, false); assert.equal(f.facts.played, 0); assert.equal(sent.at(-1)[1].event, 'playback-blocked');
  blocked = false; await ui.resumePlayback(); assert.equal(f.facts.played, 1); assert.equal(sent.some(([name]) => name === 'voice-command' || name === 'submit'), false); await ui.dispose();
});
