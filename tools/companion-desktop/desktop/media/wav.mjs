// PCM encoding/join adapted from phoiex/AAAAGENT media/wav.ts at
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad; strict limits/RIFF validation added.
export const CAPTURE_LIMITS = Object.freeze({ maxBytes: 3 * 1024 * 1024, maxDurationMs: 30000, maxSamples: 1440000, maxChannels: 1 });
export const PLAYBACK_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxDurationMs: 120000, maxSamples: 5760000, maxChannels: 2 });
const invalid = () => { throw Error('INVALID_RESPONSE'); };
const limit = () => { throw Error('AUDIO_LIMIT'); };
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
function header(dataLength, rate, channels = 1) {
  const bytes = new Uint8Array(44 + dataLength), v = new DataView(bytes.buffer);
  const tag = (at, text) => bytes.set(new TextEncoder().encode(text), at);
  tag(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, dataLength, true);
  return bytes;
}
export function pcm16Wav(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || !samples.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) invalid();
  if (samples.length > CAPTURE_LIMITS.maxSamples || samples.length / sampleRate > 30 || samples.length * 2 + 44 > CAPTURE_LIMITS.maxBytes) limit();
  const bytes = header(samples.length * 2, sampleRate), v = new DataView(bytes.buffer);
  try { samples.forEach((sample, i) => { if (!Number.isFinite(sample)) invalid(); const value = Math.max(-1, Math.min(1, sample)); v.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }); }
  catch (error) { bytes.fill(0); throw error; }
  return bytes;
}
export function pcm16BytesWav(pcm, sampleRate, channels = 1, limits = PLAYBACK_LIMITS) {
  if (!(pcm instanceof Uint8Array) || !pcm.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || !Number.isInteger(channels) || channels < 1 || channels > limits.maxChannels || pcm.length % (channels * 2)) invalid();
  const samples = pcm.length / (channels * 2), durationMs = samples / sampleRate * 1000;
  if (samples > limits.maxSamples || durationMs > limits.maxDurationMs || pcm.length + 44 > limits.maxBytes) limit();
  const bytes = header(pcm.length, sampleRate, channels);
  bytes.set(pcm, 44);
  return bytes;
}
export function inspectPcmWav(bytes, limits = CAPTURE_LIMITS) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) invalid();
  if (bytes.length > limits.maxBytes) limit();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE' || v.getUint32(4, true) !== bytes.length - 8) invalid();
  let sampleRate = 0, channels = 0, data, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const length = v.getUint32(offset + 4, true), start = offset + 8, end = start + length;
    if (end + length % 2 > bytes.length) invalid();
    const name = ascii(bytes, offset, 4);
    if (name === 'fmt ') {
      if (sampleRate || length < 16 || v.getUint16(start, true) !== 1) invalid();
      channels = v.getUint16(start + 2, true); sampleRate = v.getUint32(start + 4, true);
      if (channels < 1 || channels > limits.maxChannels || sampleRate < 8000 || sampleRate > 48000 || v.getUint16(start + 14, true) !== 16 || v.getUint16(start + 12, true) !== channels * 2 || v.getUint32(start + 8, true) !== sampleRate * channels * 2) invalid();
    } else if (name === 'data') { if (data) invalid(); data = bytes.subarray(start, end); }
    offset = end + length % 2;
  }
  if (!sampleRate || !data?.length || data.length % (channels * 2)) invalid();
  const samples = data.length / (channels * 2), durationMs = samples / sampleRate * 1000;
  if (samples > limits.maxSamples || durationMs > limits.maxDurationMs) limit();
  return { sampleRate, channels, bits: 16, data, durationMs };
}
export function joinPcmWav(clips) {
  if (!clips.length) invalid();
  const parsed = clips.map(b => inspectPcmWav(b, PLAYBACK_LIMITS)), first = parsed[0];
  if (parsed.some(p => p.sampleRate !== first.sampleRate || p.channels !== first.channels)) invalid();
  const length = parsed.reduce((n, p) => n + p.data.length, 0);
  if (length + 44 > PLAYBACK_LIMITS.maxBytes || parsed.reduce((n, p) => n + p.durationMs, 0) > 120000) limit();
  const result = header(length, first.sampleRate, first.channels);
  let at = 44; for (const p of parsed) { result.set(p.data, at); at += p.data.length; }
  return result;
}
