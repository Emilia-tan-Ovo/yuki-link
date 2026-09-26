// Audio-only adaptation of AAAAGENT media/browser-{capture,playback}.ts and
// desktop/playback-controller.ts, pinned 2752349bcc7f7137b8b9e4ff9cccf34026d77aad.
// Yuki owns bounded in-memory data, device selection, deadlines and late cleanup.
import { pcm16Wav, inspectPcmWav, PLAYBACK_LIMITS, CAPTURE_LIMITS } from './wav.mjs';
const erase = buffer => { if (buffer) for (let c = 0; c < buffer.numberOfChannels; c++) buffer.getChannelData(c).fill(0); };
function wait(promise, signal, late = () => {}) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) late(value); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
const safeDeviceError = (error, fallback) => Error(error?.message === 'AUDIO_LIMIT' ? 'AUDIO_LIMIT' : error?.message === 'CANCELLED' ? 'CANCELLED' : error?.name === 'NotAllowedError' ? 'PERMISSION_DENIED' : error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError' ? 'DEVICE_MISSING' : error?.name === 'NotReadableError' ? 'DEVICE_BUSY' : fallback);
export class BrowserCapture {
  constructor({ mediaDevices = globalThis.navigator?.mediaDevices, AudioContext = globalThis.AudioContext, AudioWorkletNode = globalThis.AudioWorkletNode, emit = () => {}, prepareMs = 30000, flushMs = 2000, maxMs = 30000 } = {}) {
    Object.assign(this, { mediaDevices, AudioContext, AudioWorkletNode, emit, prepareMs, flushMs, maxMs }); this.active = null;
  }
  async start({ inputDevice = 'default' } = {}) {
    if (this.active) throw Error('CAPTURE_FAILED');
    const a = { controller: new AbortController(), blocks: [], samples: 0, stopped: false, finishing: false, ready: false }; this.active = a;
    const signal = a.controller.signal;
    const fail = code => { if (a.stopped) return; a.failure = Error(code); this.emit({ type: 'error', code }); this.cleanup(a, a.failure); };
    const prepared = new Promise(resolve => { a.readyResolve = resolve; });
    a.prepareTimer = setTimeout(() => fail('CAPTURE_FAILED'), this.prepareMs);
    try {
      if (!this.mediaDevices?.getUserMedia || !this.AudioContext || !this.AudioWorkletNode) throw Error();
      // Called only by an explicit start command; resume is started in the same turn.
      const pending = this.mediaDevices.getUserMedia({ audio: { ...(inputDevice !== 'default' ? { deviceId: { exact: inputDevice } } : {}), channelCount: 1 }, video: false });
      const owned = Promise.resolve(pending).then(stream => {
        if (a.stopped) { stream.getTracks().forEach(t => t.stop()); throw Error('CANCELLED'); }
        a.stream = stream; return stream;
      });
      void owned.catch(() => {});
      a.context = new this.AudioContext();
      if (!Number.isInteger(a.context.sampleRate) || a.context.sampleRate < 8000 || a.context.sampleRate > 48000) throw Error();
      const resume = a.context.resume(); void resume.catch(() => {});
      await wait(a.context.audioWorklet.addModule(new URL('./recorder-worklet.mjs', import.meta.url).href), signal);
      a.node = new this.AudioWorkletNode(a.context, 'yuki-recorder');
      a.node.onprocessorerror = () => fail('CAPTURE_FAILED');
      a.node.port.onmessage = ({ data }) => {
        if (a.stopped) { data.samples?.fill(0); return; }
        if (data.error) { fail('AUDIO_LIMIT'); return; }
        if (data.samples instanceof Float32Array) {
          a.samples += data.samples.length;
          if (a.samples > CAPTURE_LIMITS.maxSamples || a.samples / a.context.sampleRate > 30 || data.samples.some(x => !Number.isFinite(x))) { data.samples.fill(0); fail('AUDIO_LIMIT'); return; }
          a.blocks.push(data.samples);
          if (!a.ready && a.samples > 0) { a.ready = true; a.readyResolve(); }
        }
        if (data.finished) a.flushResolve?.();
      };
      a.gain = a.context.createGain(); a.gain.gain.value = 0; a.node.connect(a.gain); a.gain.connect(a.context.destination);
      await wait(owned, signal);
      const tracks = a.stream.getAudioTracks(); if (!tracks.length) throw Error();
      a.trackEnded = () => { if (!a.finishing) fail('DEVICE_MISSING'); };
      tracks.forEach(t => t.addEventListener('ended', a.trackEnded));
      a.source = a.context.createMediaStreamSource(a.stream); a.source.connect(a.node);
      a.limitTimer = setTimeout(() => fail('AUDIO_LIMIT'), this.maxMs);
      await wait(resume, signal); await wait(prepared, signal);
      if (a.context.state !== 'running') throw Error();
      clearTimeout(a.prepareTimer); this.emit({ type: 'listening' });
    } catch (error) { const safe = a.failure ?? safeDeviceError(error, 'CAPTURE_FAILED'); this.cleanup(a, safe); throw safe; }
  }
  stopTracks(a) { if (!a.stream) return; a.stream.getTracks().forEach(t => { t.removeEventListener?.('ended', a.trackEnded); t.stop(); }); a.stream = null; }
  async finish() {
    const a = this.active;
    if (!a || a.stopped || a.finishing || !a.ready) throw a?.failure ?? Error('CAPTURE_FAILED');
    a.finishing = true; clearTimeout(a.limitTimer); this.stopTracks(a);
    try {
      const flushed = new Promise(resolve => { a.flushResolve = resolve; });
      a.flushTimer = setTimeout(() => { a.failure = Error('CAPTURE_FAILED'); this.cleanup(a, a.failure); }, this.flushMs);
      a.node.port.postMessage('finish'); await wait(flushed, a.controller.signal);
      const pcm = new Float32Array(a.samples); let at = 0;
      try { for (const block of a.blocks) { pcm.set(block, at); at += block.length; } return pcm16Wav(pcm, a.context.sampleRate); }
      finally { pcm.fill(0); }
    } finally { this.cleanup(a); }
  }
  cleanup(a, reason = Error('CANCELLED')) {
    if (a.stopped) return a.closed;
    a.stopped = true; a.controller.abort(reason); clearTimeout(a.prepareTimer); clearTimeout(a.limitTimer); clearTimeout(a.flushTimer);
    this.stopTracks(a); a.source?.disconnect(); a.gain?.disconnect();
    if (a.node) { a.node.port.onmessage = null; a.node.port.close(); a.node.disconnect(); }
    a.blocks.forEach(b => b.fill(0)); a.blocks.length = 0;
    a.closed = a.context && a.context.state !== 'closed' ? a.context.close() : Promise.resolve();
    void a.closed.catch(() => {}); return a.closed;
  }
  async cancel() { const a = this.active; if (!a) return; await this.cleanup(a); if (this.active === a) this.active = null; }
}
export class BrowserPlayback {
  constructor({ AudioContext = globalThis.AudioContext, emit = () => {}, pollMs = 16, openMs = 30000 } = {}) { Object.assign(this, { AudioContext, emit, pollMs, openMs }); this.active = null; }
  async play({ wav, outputDevice = 'default' }) {
    if (this.active) { wav?.fill(0); throw Error('PLAYBACK_FAILED'); }
    const a = { controller: new AbortController(), stopped: false, started: false }; this.active = a;
    const signal = a.controller.signal;
    try {
      inspectPcmWav(wav, PLAYBACK_LIMITS);
      a.context = new this.AudioContext();
      a.openTimer = setTimeout(() => this.cleanup(a, Error('PLAYBACK_BLOCKED')), this.openMs);
      a.buffer = await wait(a.context.decodeAudioData(wav.slice().buffer), signal, erase); wav.fill(0);
      let firstFrame = a.buffer.length;
      if (!Number.isFinite(a.buffer.duration) || a.buffer.duration <= 0 || a.buffer.duration > 120 || a.buffer.numberOfChannels < 1 || a.buffer.numberOfChannels > 2) throw Error('PLAYBACK_FAILED');
      for (let c = 0; c < a.buffer.numberOfChannels; c++) { const channel = a.buffer.getChannelData(c); for (let i = 0; i < channel.length; i++) { if (!Number.isFinite(channel[i])) throw Error('PLAYBACK_FAILED'); if (channel[i] !== 0 && i < firstFrame) firstFrame = i; } }
      if (firstFrame === a.buffer.length) throw Error('PLAYBACK_FAILED');
      if (outputDevice !== 'default') {
        if (typeof a.context.setSinkId !== 'function') this.emit({ type: 'default-output', reason: 'unsupported' });
        else await wait(a.context.setSinkId(outputDevice), signal);
      }
      await wait(a.context.resume(), signal);
      if (a.context.state !== 'running') throw Error('PLAYBACK_BLOCKED');
      clearTimeout(a.openTimer);
      a.analyser = a.context.createAnalyser(); a.analyser.fftSize = 256;
      a.source = a.context.createBufferSource(); a.source.buffer = a.buffer; a.source.connect(a.analyser); a.analyser.connect(a.context.destination);
      const start = a.context.currentTime, onset = start + firstFrame / a.buffer.sampleRate, end = start + a.buffer.duration; a.level = new Float32Array(a.analyser.fftSize);
      const poll = () => {
        if (a.stopped) return;
        if (a.context.state !== 'running') { this.emit({ type: 'error', code: 'PLAYBACK_FAILED' }); void this.cleanup(a); return; }
        const timestamp = a.context.getOutputTimestamp?.();
        const position = timestamp && Number.isFinite(timestamp.contextTime) && timestamp.performanceTime > 0 ? timestamp.contextTime : a.context.currentTime - (a.context.outputLatency || 0) - (a.context.baseLatency || 0);
        if (!a.started && position > onset) { a.started = true; this.emit({ type: 'started' }); }
        if (a.started) { a.analyser.getFloatTimeDomainData(a.level); const rms = Math.sqrt(a.level.reduce((n, x) => n + x * x, 0) / a.level.length); if (Number.isFinite(rms)) this.emit({ type: 'amplitude', value: Math.min(1, rms) }); }
        if (a.started && position >= end) { this.emit({ type: 'ended' }); void this.cleanup(a); }
      };
      a.source.onended = poll; a.source.start(start); a.timer = setInterval(poll, this.pollMs);
      a.watchdog = setTimeout(() => { this.emit({ type: 'error', code: 'PLAYBACK_FAILED' }); void this.cleanup(a); }, a.buffer.duration * 1000 + 5000);
    } catch (error) { await this.cleanup(a); throw error?.message === 'CANCELLED' ? error : Error(error?.name === 'NotAllowedError' || error?.message === 'PLAYBACK_BLOCKED' ? 'PLAYBACK_BLOCKED' : 'PLAYBACK_FAILED'); }
    finally { wav?.fill(0); }
  }
  cleanup(a, reason = Error('CANCELLED')) {
    if (a.stopped) return a.closed;
    a.stopped = true; a.controller.abort(reason); clearTimeout(a.openTimer); clearTimeout(a.watchdog); clearInterval(a.timer);
    if (a.source) { a.source.onended = null; try { a.source.stop(); } catch {} a.source.disconnect(); a.source.buffer = null; }
    a.analyser?.disconnect(); a.level?.fill(0); erase(a.buffer); a.buffer = null;
    a.closed = a.context && a.context.state !== 'closed' ? a.context.close() : Promise.resolve();
    void a.closed.catch(() => {}); return a.closed;
  }
  async stop() { const a = this.active; if (!a) return; await this.cleanup(a); if (this.active === a) this.active = null; }
}
