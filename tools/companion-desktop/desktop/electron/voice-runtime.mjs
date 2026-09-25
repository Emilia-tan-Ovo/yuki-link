import { inspectPcmWav, CAPTURE_LIMITS, PLAYBACK_LIMITS } from '../media/wav.mjs';
import { validRequestId } from '../turn-contract.mjs';
import { MicrophonePermissionIntent } from './voice-readiness.mjs';
export class VoiceRuntime {
  constructor({ voice, connection, deliver, settings, readiness, status, preview = false }) { Object.assign(this, { voice, connection, deliver, settings, readiness, status, preview }); this.cleanupPending = null; this.activeModel = null; this.configurationQueue = Promise.resolve(); this.pendingConfigurations = 0; this.permissionIntent = new MicrophonePermissionIntent(); }
  send(value) { return this.connection.send(value, this.connection.generation); }
  state(extra = {}) { this.deliver({ type: 'voice-state', generation: this.connection.generation, scope: this.voice.current?.scope, state: this.voice.state, ...extra }); }
  publish() { const readiness = this.readiness.snapshot(!this.preview && this.connection.state === 'ready' && !['unconfigured','disconnected'].includes(this.status()?.service), this.status()?.service); this.deliver({ type: 'voice-settings', voice: this.settings.snapshot().voice, credentialConfigured: this.credentialConfigured === true, readiness }); this.send({ type: 'media-readiness', readiness }); return readiness; }
  configure(credentialConfigured) { this.invalidateVoice(); this.credentialConfigured = credentialConfigured; this.readiness.reset(credentialConfigured && this.settings.snapshot().voice.enabled && !this.preview); this.publish(); }
  reconfigure(commit, readKey) {
    ++this.pendingConfigurations;
    this.invalidateVoice();
    const operation = this.configurationQueue.then(async () => {
      await commit();
      const voiceKey = this.preview ? '' : await readKey();
      this.configure(!!voiceKey);
      this.send({ type: 'voice-configure', voiceConfig: this.settings.snapshot().voice, voiceKey, configRevision: this.readiness.revision });
    }).finally(() => { --this.pendingConfigurations; this.publish(); });
    this.configurationQueue = operation.catch(() => {});
    return operation;
  }
  stopResources(scope, all = true) {
    this.permissionIntent.clear(scope);
    if (!scope) return;
    this.send({ type: 'voice-stop', scope });
    this.cleanupPending = scope;
    this.deliver({ type: 'voice-teardown', generation: this.connection.generation, scope, all });
  }
  invalidateVoice() { this.permissionIntent.clear(); this.stopResources(this.voice.current?.scope); this.voice.disconnect(); }
  invalidate() { this.invalidateVoice(); this.activeModel = null; }
  microphonePermission(request) {
    if (this.preview || this.connection.state !== 'ready' || this.pendingConfigurations || this.cleanupPending || this.voice.state !== 'preparing') { this.permissionIntent.clear(); return false; }
    return this.permissionIntent.allow(request, this.connection.generation, this.voice.current?.scope);
  }
  command(value) {
    const v = this.voice;
    if (value.action === 'start') {
      if (this.pendingConfigurations || this.cleanupPending || this.activeModel || !this.publish().voice.canAttempt) { this.deliver({ type: 'notice', text: this.cleanupPending ? '等待本地音频清理确认；尚未启动录音。' : '语音条件尚未齐全或回复仍在处理中，请查看设置。' }); return; }
      const result = v.start(this.connection.generation); this.state(result);
      if (result.outcome === 'accepted') {
        if (!this.send({ type: 'voice-start', scope: result.scope })) { v.cancel(result.scope); this.state(); return; }
        this.permissionIntent.arm(this.connection.generation, result.scope);
        this.deliver({ type: 'voice-capture', generation: this.connection.generation, scope: result.scope, inputDevice: this.settings.snapshot().voice.inputDevice });
      }
      return;
    }
    if (!v.matches(value.scope)) return;
    if (value.action === 'finish' && v.state === 'listening' && !v.current.finishRequested) {
      v.current.finishRequested = true; this.deliver({ type: 'voice-finish', generation: this.connection.generation, scope: value.scope });
    }
    if (value.action === 'stop-output') { if (!['synthesizing','playback-pending','speaking'].includes(v.state)) return; v.stopOutput(value.scope); this.stopResources(value.scope, false); }
    if (value.action === 'cancel-turn') {
      const result = v.cancel(value.scope); this.stopResources(value.scope);
      if (result.requestId && !this.send({ type: 'cancel-model', requestId: result.requestId, origin: 'voice-final', voiceScope: value.scope })) this.deliver({ type: 'cancel-ack', generation: this.connection.generation, requestId: result.requestId, origin: 'voice-final', voiceScope: value.scope, outcome: 'unknown-after-disconnect' });
    }
    this.state();
  }
  event(value) {
    const v = this.voice;
    if (['capture-ready', 'capture-finished', 'device-error', 'cleaned'].includes(value.event)) this.permissionIntent.clear(value.scope);
    if (value.event === 'cleaned' && this.cleanupPending?.voiceTurnId === value.scope?.voiceTurnId && this.cleanupPending.voiceEpoch === value.scope.voiceEpoch && this.cleanupPending.connectionGeneration === value.scope.connectionGeneration) { this.cleanupPending = null; this.state(); return; }
    if (value.event === 'devices-changed') {
      if (v.current) { const result = v.cancel(v.current.scope); this.stopResources(v.current.scope); if (result.requestId) this.send({ type: 'cancel-model', requestId: result.requestId, origin: 'voice-final', voiceScope: v.current.scope }); }
      this.readiness.facts.capture = 'unknown'; this.readiness.facts.playback = 'unknown'; this.readiness.facts.permission = 'unknown'; this.state(); this.publish(); return;
    }
    if (!v.matches(value.scope)) { if (value.wav instanceof Uint8Array) value.wav.fill(0); return; }
    if (value.event === 'capture-ready' && v.captureReady(value.scope)) { this.readiness.facts.permission = 'granted'; this.readiness.facts.capture = 'ready'; }
    if (value.event === 'capture-finished') {
      try {
        if (!v.current.finishRequested || value.requestId !== v.current.scope.requestId || v.state !== 'listening') return;
        inspectPcmWav(value.wav, CAPTURE_LIMITS); if (v.finish(value.scope)) this.send({ type: 'voice-asr', scope: value.scope, requestId: value.requestId, wav: value.wav });
      } catch { this.failure(value.scope, 'capture', 'CAPTURE_FAILED'); }
      finally { if (value.wav instanceof Uint8Array) value.wav.fill(0); }
    }
    if (value.event === 'playback-started' && value.requestId === v.current.requestId && v.playback(value.scope, 'started')) this.readiness.facts.playback = 'ready';
    if (value.event === 'playback-blocked' && value.requestId === v.current.requestId && v.state === 'playback-pending') this.readiness.facts.playback = 'blocked';
    if (value.event === 'playback-ended' && value.requestId === v.current.requestId) v.playback(value.scope, 'ended');
    if (value.event === 'device-error') this.failure(value.scope, ['playback-pending','speaking'].includes(v.state) ? 'playback' : 'capture', ['PERMISSION_DENIED','DEVICE_MISSING','DEVICE_BUSY','AUDIO_LIMIT','CAPTURE_FAILED','PLAYBACK_BLOCKED','PLAYBACK_FAILED'].includes(value.code) ? value.code : 'CAPTURE_FAILED');
    this.state(); this.publish();
  }
  failure(scope, stage, code) {
    if (!this.voice.fail(scope)) return;
    if (stage === 'capture') { this.readiness.facts.capture = code === 'DEVICE_MISSING' ? 'missing' : 'unknown'; if (code === 'PERMISSION_DENIED') this.readiness.facts.permission = 'denied'; }
    else if (stage === 'playback') this.readiness.facts.playback = code === 'PLAYBACK_BLOCKED' ? 'blocked' : 'error';
    else this.readiness.provider(stage, false);
    this.stopResources(scope); this.state({ error: { stage, code } }); this.publish();
  }
  backend(message, generation) {
    if (generation !== this.connection.generation) { message.wav?.fill(0); return true; }
    const v = this.voice;
    if (['reply','error','cancel-ack'].includes(message.type) && message.requestId === this.activeModel && (message.type !== 'cancel-ack' || ['cancelled','alreadyCommitted','notCommitted'].includes(message.outcome))) this.activeModel = null;
    if (message.type === 'reply' && message.origin === 'voice-final' && v.matches(message.voiceScope) && v.committed(message)) { this.state(); this.send({ type: 'voice-tts', scope: v.current.scope, requestId: message.requestId }); }
    if (message.type === 'voice-asr-final') {
      if (v.matches(message.scope) && message.requestId === v.current.scope.requestId) { try { const final = v.final(message.scope, message.text); if (final) { this.readiness.provider('asr', true); this.deliver(final); this.state(); this.publish(); } } catch { this.failure(message.scope, 'asr', 'INVALID_RESPONSE'); } } return true;
    }
    if (message.type === 'voice-audio') {
      try { if (!v.matches(message.scope) || !validRequestId(message.requestId)) return true; inspectPcmWav(message.wav, PLAYBACK_LIMITS);
        if (v.audio(message.scope, message.requestId)) { this.readiness.provider('tts', true); this.state(); this.deliver({ type: 'voice-play', generation, scope: message.scope, requestId: message.requestId, wav: message.wav, outputDevice: this.settings.snapshot().voice.outputDevice }); this.publish(); }
      } catch { this.failure(message.scope, 'tts', 'INVALID_RESPONSE'); } finally { message.wav?.fill(0); } return true;
    }
    if (message.type === 'voice-error') { if (v.matches(message.scope) && message.requestId === (message.stage === 'asr' ? v.current.scope.requestId : v.current.requestId)) this.failure(message.scope, message.stage, message.error.code); return true; }
    return false;
  }
}
