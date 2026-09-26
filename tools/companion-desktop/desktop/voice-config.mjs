export const ASR_MODEL = 'qwen-audio-3.0-asr-flash';
export const TTS_MODEL = 'qwen-audio-3.0-tts-flash';
export const SYSTEM_VOICES = Object.freeze(['longanfengyue', 'longanyuanfei', 'longanlingxi']);
const LEGACY = Object.freeze({ asrModel: 'qwen3-asr-flash-2026-02-10', ttsModel: 'qwen3-tts-instruct-flash-2026-01-26', voice: 'Cherry' });

export const DEFAULT_VOICE = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  provider: 'qwen',
  region: 'cn',
  asrModel: ASR_MODEL,
  ttsModel: TTS_MODEL,
  voice: 'longanfengyue',
  inputDevice: 'default',
  outputDevice: 'default'
});

function validDevice(value) {
  return typeof value === 'string' && !!value && value.length <= 256 && !/[\s\x00-\x1f]/u.test(value);
}

export function normalizeVoice(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || value.provider !== 'qwen' || value.region !== 'cn' || value.asrModel !== ASR_MODEL || value.ttsModel !== TTS_MODEL || !SYSTEM_VOICES.includes(value.voice)) throw Error('语音设置无效。');
  for (const key of ['inputDevice', 'outputDevice']) if (!validDevice(value[key])) throw Error('语音设备设置无效。');
  return Object.fromEntries(Object.keys(DEFAULT_VOICE).map(k => [k, value[k]]));
}

export function migrateSavedVoice(value) {
  try { return normalizeVoice(value); } catch {}
  const legacy = value && value.schemaVersion === 1 && typeof value.enabled === 'boolean' && value.provider === 'qwen' && value.region === 'cn' && value.asrModel === LEGACY.asrModel && value.ttsModel === LEGACY.ttsModel && value.voice === LEGACY.voice;
  if (!legacy || !validDevice(value.inputDevice) || !validDevice(value.outputDevice)) throw Error('语音设置无效。');
  return { ...DEFAULT_VOICE, enabled: value.enabled, inputDevice: value.inputDevice, outputDevice: value.outputDevice };
}
