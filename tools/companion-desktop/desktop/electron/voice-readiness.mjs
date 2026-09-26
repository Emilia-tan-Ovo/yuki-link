import { initialMediaReadiness, sameVoiceScope } from '../turn-contract.mjs';
export class VoiceReadiness {
  constructor() { this.revision = 0; this.reset(false); }
  reset(configured) {
    ++this.revision; this.configured = configured;
    this.facts = { permission: 'unknown', capture: 'unknown', playback: 'unknown', asr: configured ? 'configured' : 'unconfigured', tts: configured ? 'configured' : 'unconfigured' };
    this.checked = { asr: null, tts: null };
  }
  provider(stage, success) { if (!['asr', 'tts'].includes(stage)) return; this.facts[stage] = success ? 'verified' : 'unknown'; this.checked[stage] = Date.now(); }
  snapshot(connected, textService) {
    const result = initialMediaReadiness(), f = this.facts;
    if (this.live2d) result.live2d = this.live2d();
    const missing = [];
    if (!this.configured) missing.push('configuration'); if (!connected) missing.push('connection');
    if (f.permission !== 'granted') missing.push('microphone-permission'); if (f.capture !== 'ready') missing.push('capture-verification'); if (f.playback !== 'ready') missing.push('playback-verification');
    for (const key of ['asr', 'tts']) if (f[key] !== 'verified') missing.push(key + '-verification');
    if (textService !== 'verified') missing.push('text-verification');
    result.voice = { implemented: true, configured: this.configured, configRevision: this.revision, canAttempt: this.configured && connected && !['denied'].includes(f.permission) && !['missing', 'unavailable'].includes(f.capture), ready: missing.length === 0,
      provider: Object.fromEntries(['asr','tts'].map(key => [key, { state: f[key], configRevision: this.revision, checkedAt: this.checked[key] }])), device: { permission: f.permission, capture: f.capture }, playback: { state: f.playback }, missing };
    return result;
  }
}
export function allowMicrophone({ webContents, expected, permission, details, intent, origin, check = false }) {
  if (!intent || !expected || webContents !== expected || expected.mainFrame?.url !== 'yuki://app/index.html' || permission !== 'media' || details?.isMainFrame !== true) return false;
  if (check) return details.mediaType === 'audio' && (origin === 'yuki://app' || origin === 'yuki://app/') && (!details.requestingUrl || details.requestingUrl === 'yuki://app/index.html');
  return details.requestingUrl === 'yuki://app/index.html' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
}

// Main owns one permission intent per accepted capture; checks never consume it.
export class MicrophonePermissionIntent {
  constructor({ now = Date.now } = {}) { this.now = now; this.current = null; this.timer = null; }
  arm(generation, scope) {
    this.clear();
    if (!scope || scope.connectionGeneration !== generation) return;
    this.current = { generation, scope: { ...scope }, deadline: this.now() + 30000 };
    this.timer = setTimeout(() => this.clear(), 30000); this.timer.unref?.();
  }
  clear(scope) {
    if (scope && !sameVoiceScope(scope, this.current?.scope)) return;
    clearTimeout(this.timer); this.timer = null; this.current = null;
  }
  allow(request, generation, scope) {
    const intent = this.current;
    if (!intent || this.now() >= intent.deadline || intent.generation !== generation || !sameVoiceScope(intent.scope, scope)) { this.clear(); return false; }
    const allowed = allowMicrophone({ ...request, intent: true });
    if (!request.check) this.clear();
    return allowed;
  }
}
