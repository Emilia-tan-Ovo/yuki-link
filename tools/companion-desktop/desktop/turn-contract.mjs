import { initialLive2DReadiness } from './live2d-loader.mjs';

export function normalizeUserText(value) {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  if (!text || text.length > 20000 || text.includes('\0')) throw Error('请输入不超过 20000 字的文字。');
  return text;
}

export function validRequestId(value) { return typeof value === 'string' && /^[\w-]{1,128}$/.test(value); }
export function sameVoiceScope(a, b) {
  return !!a && !!b && a.schemaVersion === 1 && b.schemaVersion === 1 &&
    a.connectionGeneration === b.connectionGeneration && a.voiceTurnId === b.voiceTurnId && a.voiceEpoch === b.voiceEpoch;
}

// Reserved media lifecycle contract; none of these states proves device success.
export const VOICE_STATES = Object.freeze(['idle', 'preparing', 'listening', 'transcribing', 'awaiting-submit', 'thinking', 'synthesizing', 'playback-pending', 'speaking', 'cancelling', 'cancelled', 'error']);
export const VOICE_COMMANDS = Object.freeze(['start', 'finish', 'cancel-turn', 'stop-output']);

// Rebuild facts on each status; the optional Live2D SDK is not bundled.
// do not persist verified/permission/device facts or accept them from renderer.
export function initialMediaReadiness() {
  const provider = () => ({ state: 'unconfigured', configRevision: 0, checkedAt: null });
  return { schemaVersion: 1,
    voice: { implemented: false, configured: false, canAttempt: false, ready: false,
      provider: { asr: provider(), tts: provider() },
      device: { permission: 'unknown', capture: 'unavailable' }, playback: { state: 'unknown' },
      missing: ['capture', 'asr', 'tts', 'playback', 'configuration', 'device-verification'] },
    live2d: initialLive2DReadiness()
  };
}
