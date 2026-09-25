// Adapted Qwen request/splitSpeech seams from phoiex/AAAAGENT providers/qwen-{asr,tts}.ts
// at 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. No MediaStore, emotion, cloning or retry.
import { inspectPcmWav, joinPcmWav, CAPTURE_LIMITS, PLAYBACK_LIMITS } from '../desktop/media/wav.mjs';
import { normalizeVoice } from '../desktop/voice-config.mjs';
import { normalizeCredential } from '../desktop/electron/credential.mjs';
export class VoiceError extends Error {
  constructor(stage, code, httpStatus) { super(code); this.stage = stage; this.code = code; this.retryable = ['NETWORK', 'TIMEOUT', 'RATE_LIMIT'].includes(code); if (httpStatus) this.httpStatus = httpStatus; }
  safe() { return { stage: this.stage, code: this.code, retryable: this.retryable, ...(this.httpStatus ? { httpStatus: this.httpStatus } : {}) }; }
}
export function splitSpeech(text, maxCharacters = 600) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new VoiceError('tts', 'INVALID_RESPONSE');
  const chars = Array.from(text), result = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(chars.length, start + maxCharacters);
    if (end < chars.length) for (let i = end - 1; i > start + maxCharacters / 2; i--) if (/[。！？.!?\n]/u.test(chars[i])) { end = i + 1; break; }
    result.push(chars.slice(start, end).join('')); start = end;
  }
  return result;
}
const profiles = {
  cn: { host: 'dashscope.aliyuncs.com', audio: ['dashscope-result-bj.oss-cn-beijing.aliyuncs.com'] },
  sg: { host: 'dashscope-intl.aliyuncs.com', audio: ['dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com'] }
};
export function audioDownloadUrl(raw, region) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\\#]/u.test(raw)) throw new VoiceError('tts', 'INVALID_RESPONSE');
  let url; try { url = new URL(raw); } catch { throw new VoiceError('tts', 'INVALID_RESPONSE'); }
  const match = /^(https?):\/\/([^/]+)(\/.*)$/u.exec(raw);
  if (!match || !profiles[region]?.audio.includes(url.hostname) || url.username || url.password || url.port || !['http:', 'https:'].includes(url.protocol) || match[2] !== url.hostname) throw new VoiceError('tts', 'INVALID_RESPONSE');
  // Only exact reviewed OSS authorities; preserve signed path/query bytes.
  return url.protocol === 'http:' ? 'https://' + match[2] + match[3] : raw;
}
function wait(promise, signal, late = () => {}) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) late(value); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function bounded(response, max, signal, stage) {
  if (!response.body?.getReader) throw new VoiceError(stage, 'INVALID_RESPONSE');
  const reader = response.body.getReader(), parts = []; let size = 0, complete = false;
  try {
    if (Number(response.headers.get('content-length')) > max) throw new VoiceError(stage, 'AUDIO_LIMIT');
    for (;;) {
      const { done, value } = await wait(reader.read(), signal, r => r.value?.fill(0));
      if (done) break;
      size += value.length;
      if (size > max) { value.fill(0); throw new VoiceError(stage, 'AUDIO_LIMIT'); }
      parts.push(value);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== size)) throw new VoiceError(stage, 'INVALID_RESPONSE');
    const bytes = new Uint8Array(size); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; } complete = true; return bytes;
  } finally { parts.forEach(p => p.fill(0)); if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createVoiceProvider({ config, key, fetcher = fetch, timeoutMs = 45000, totalTimeoutMs = 120000 }) {
  let settings, secret;
  try { settings = normalizeVoice(config); secret = normalizeCredential(key); if (!settings.enabled) throw Error(); }
  catch { throw new VoiceError('configuration', 'UNCONFIGURED'); }
  const profile = profiles[settings.region];
  async function deadline(stage, caller, ms, run) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new VoiceError(stage, 'TIMEOUT')), ms);
    const cancel = () => controller.abort(new VoiceError(stage, 'CANCELLED'));
    if (caller?.aborted) cancel(); else caller?.addEventListener('abort', cancel, { once: true });
    try { controller.signal.throwIfAborted(); return await wait(run(controller.signal), controller.signal, result => result?.wav?.fill(0)); }
    catch (error) { if (controller.signal.aborted) throw controller.signal.reason; if (error instanceof VoiceError) throw error; throw new VoiceError(stage, ['AUDIO_LIMIT', 'INVALID_RESPONSE'].includes(error?.message) ? error.message : 'NETWORK'); }
    finally { clearTimeout(timer); caller?.removeEventListener('abort', cancel); }
  }
  async function request(url, options, signal, stage, max) {
    const response = await wait(fetcher(url, { ...options, redirect: 'error', signal }), signal, r => { void r.body?.cancel().catch(() => {}); });
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); throw new VoiceError(stage, response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_FAILED', response.status); }
    return bounded(response, max, signal, stage);
  }
  async function post(path, body, signal, stage) {
    const bytes = await request('https://' + profile.host + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }, signal, stage, 1024 * 1024);
    try { let raw; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new VoiceError(stage, 'INVALID_RESPONSE'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new VoiceError(stage, 'INVALID_RESPONSE');
      if (raw.code || raw.status_code !== undefined && raw.status_code !== 200) throw new VoiceError(stage, 'PROVIDER_FAILED'); return raw;
    } finally { bytes.fill(0); }
  }
  return {
    async transcribe({ wav }, signal) {
      return deadline('asr', signal, timeoutMs, async combined => {
        let body;
        try { inspectPcmWav(wav, CAPTURE_LIMITS); body = { model: settings.asrModel, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + Buffer.from(wav).toString('base64') } }] }], stream: false, asr_options: { enable_itn: false } }; }
        finally { wav?.fill(0); }
        const raw = await post('/compatible-mode/v1/chat/completions', body, combined, 'asr'); body = null;
        const choice = raw.choices?.[0], message = choice?.message;
        if (raw.choices?.length !== 1 || choice.finish_reason !== 'stop' || typeof message?.content !== 'string' || message.tool_calls || message.function_call || message.refusal || message.content.length > 20000 || message.content.includes('\0')) throw new VoiceError('asr', 'INVALID_RESPONSE');
        if (!message.content.trim()) throw new VoiceError('asr', 'NO_SPEECH');
        return { text: message.content.trim(), safeUsage: null };
      }).finally(() => wav?.fill(0));
    },
    async synthesize({ finalText }, signal) {
      return deadline('tts', signal, totalTimeoutMs, async combined => {
        if (typeof finalText !== 'string' || !finalText.trim() || finalText.includes('\0')) throw new VoiceError('tts', 'INVALID_RESPONSE');
        const segments = splitSpeech(finalText);
        if (Array.from(finalText).length > 6000 || segments.length > 10) throw new VoiceError('tts', 'AUDIO_LIMIT');
        const clips = []; let bytesTotal = 0, duration = 0;
        try {
          for (const text of segments) {
            const clip = await deadline('tts', combined, timeoutMs, async partSignal => {
              const raw = await post('/api/v1/services/aigc/multimodal-generation/generation', { model: settings.ttsModel, input: { text, voice: settings.voice, language_type: 'Auto', instructions: '用自然、中性的语气清晰朗读。', optimize_instructions: false } }, partSignal, 'tts');
              if (raw.output?.finish_reason !== 'stop') throw new VoiceError('tts', 'INVALID_RESPONSE');
              const bytes = await request(audioDownloadUrl(raw.output?.audio?.url, settings.region), { method: 'GET' }, partSignal, 'tts', PLAYBACK_LIMITS.maxBytes - bytesTotal);
              try { inspectPcmWav(bytes, PLAYBACK_LIMITS); partSignal.throwIfAborted(); return { wav: bytes }; } catch (error) { bytes.fill(0); throw error; }
            });
            clips.push(clip.wav); bytesTotal += clip.wav.length; duration += inspectPcmWav(clip.wav, PLAYBACK_LIMITS).durationMs;
            if (duration > 120000 || bytesTotal > PLAYBACK_LIMITS.maxBytes) throw new VoiceError('tts', 'AUDIO_LIMIT');
          }
          combined.throwIfAborted(); const wav = joinPcmWav(clips); return { wav, durationMs: inspectPcmWav(wav, PLAYBACK_LIMITS).durationMs, safeUsage: null };
        } finally { clips.forEach(c => c.fill(0)); }
      });
    }
  };
}
