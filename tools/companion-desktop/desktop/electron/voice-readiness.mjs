import { initialMediaReadiness } from '../turn-contract.mjs';
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
