export const ASR_MODEL = 'qwen3-asr-flash-2026-02-10';
export const TTS_MODEL = 'qwen3-tts-instruct-flash-2026-01-26';
export const DEFAULT_VOICE = Object.freeze({ schemaVersion: 1, enabled: false, provider: 'qwen', region: 'cn', asrModel: ASR_MODEL, ttsModel: TTS_MODEL, voice: 'Cherry', inputDevice: 'default', outputDevice: 'default' });
export function normalizeVoice(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || value.provider !== 'qwen' || !['cn', 'sg'].includes(value.region) || value.asrModel !== ASR_MODEL || value.ttsModel !== TTS_MODEL || value.voice !== 'Cherry') throw Error('语音设置无效。');
  for (const key of ['inputDevice', 'outputDevice']) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || /[\s\x00-\x1f]/u.test(value[key])) throw Error('语音设备设置无效。');
  return Object.fromEntries(Object.keys(DEFAULT_VOICE).map(k => [k, value[k]]));
}
