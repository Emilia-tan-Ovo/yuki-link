import test from 'node:test';
import assert from 'node:assert/strict';
import { pcm16Wav, inspectPcmWav, CAPTURE_LIMITS } from '../desktop/media/wav.mjs';
import { createVoiceProvider, audioDownloadUrl, splitSpeech } from '../backend/voice-provider.mjs';

const config = { schemaVersion: 1, enabled: true, provider: 'qwen', region: 'cn', asrModel: 'qwen-audio-3.0-asr-flash', ttsModel: 'qwen-audio-3.0-tts-flash', voice: 'longanfengyue', inputDevice: 'default', outputDevice: 'default' };
const wav = () => pcm16Wav(new Float32Array([0, 1, -1, .5]), 48000);
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('PCM16 preserves actual rate and validates RIFF, mono, duration and bounds independently', () => {
  const bytes = wav(); const info = inspectPcmWav(bytes, CAPTURE_LIMITS);
  assert.equal(info.sampleRate, 48000); assert.equal(info.data.length, 8);
  assert.deepEqual([...info.data], [0, 0, 255, 127, 0, 128, 0, 64]);
  for (const [offset, value] of [[4, 1], [22, 2], [24, 96000], [34, 8], [40, 999]]) {
    const bad = bytes.slice(); new DataView(bad.buffer).setUint32(offset, value, true);
    assert.throws(() => inspectPcmWav(bad, CAPTURE_LIMITS));
  }
  assert.throws(() => pcm16Wav(new Float32Array(8000 * 30 + 1), 8000), /AUDIO_LIMIT/);
  assert.throws(() => pcm16Wav(new Float32Array([NaN]), 16000));
});
test('ASR sends only bounded audio and exact pinned request, releases bytes, returns final transcript', async () => {
  const bytes = wav(), encoded = Buffer.from(bytes).toString('base64'), calls = [];
  const provider = createVoiceProvider({ config, key: 'fixture-key', fetcher: async (url, options) => { calls.push({ url, options }); return json({ output: { text: '  你好  ', sentence: { sentence_end: true } }, usage: { duration: 1 } }); } });
  assert.deepEqual(await provider.transcribe({ wav: bytes }), { text: '你好', safeUsage: null });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: config.asrModel, input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + encoded } }] }] }, parameters: { format: 'wav', sample_rate: '48000' } });
  assert.equal(calls[0].options.headers['x-dashscope-sse'], 'disable');
  assert.ok(bytes.every(x => x === 0));
});
test('TTS uses only committed text projection, exact request, signed HTTPS download without auth', async () => {
  const calls = [], url = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a%2Fb.wav?Signature=x%2By%3D';
  const provider = createVoiceProvider({ config, key: 'fixture-key', fetcher: async (target, options) => { calls.push({ target, options }); return calls.length === 1 ? json({ output: { finish_reason: 'stop', audio: { url } } }) : new Response(wav()); } });
  const result = await provider.synthesize({ finalText: '完整正文', reasoningContent: '不得进入媒体' });
  assert.equal(calls.length, 2); assert.equal(calls[0].target, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: config.ttsModel, input: { text: '完整正文', voice: 'longanfengyue', format: 'wav', sample_rate: 24000, instruction: '用自然、中性的语气清晰朗读。' } });
  assert.equal(calls[1].target, url.replace('http:', 'https:')); assert.equal(calls[1].options.headers, undefined); assert.equal(calls[1].options.redirect, 'error');
  assert.equal(inspectPcmWav(result.wav).sampleRate, 48000);
  const text = '中文🌸'.repeat(450); assert.equal(splitSpeech(text).join(''), text); assert.ok(splitSpeech(text).every(s => Array.from(s).length <= 600));
});
test('ASR rejects non-final/empty/bad response and classifies HTTP errors without raw data or retry', async () => {
  for (const [response, code] of [[json({ output: {} }), 'INVALID_RESPONSE'], [json({ output: { text: 'x', sentence: { sentence_end: false } } }), 'INVALID_RESPONSE'], [json({ output: { text: ' ', sentence: { sentence_end: true } } }), 'NO_SPEECH'], [new Response('private body'), 'INVALID_RESPONSE'], [new Response('private body', { status: 401 }), 'AUTH'], [new Response('private body', { status: 429 }), 'RATE_LIMIT'], [json({ code: 'private' }), 'PROVIDER_FAILED']]) {
    let calls = 0; const p = createVoiceProvider({ config, key: 'fixture-key', fetcher: async () => { calls++; return response; } });
    await assert.rejects(p.transcribe({ wav: wav() }), e => e.code === code && !JSON.stringify(e).includes('private')); assert.equal(calls, 1);
  }
});
test('caller abort and deadline bound even ignored fetch/body abort; never retry', async () => {
  for (const mode of ['fetch', 'body']) {
    let calls = 0, received;
    const p = createVoiceProvider({ config, key: 'fixture-key', timeoutMs: 15, fetcher: (_url, options) => { calls++; received = options.signal; return mode === 'fetch' ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream({ start() {} }))); } });
    await assert.rejects(p.transcribe({ wav: wav() }), { code: 'TIMEOUT' }); assert.equal(calls, 1); assert.equal(received.aborted, true);
  }
  const abort = new AbortController(); let received;
  const p = createVoiceProvider({ config, key: 'fixture-key', fetcher: (_u, o) => { received = o.signal; return new Promise(() => {}); } });
  const pending = p.transcribe({ wav: wav() }, abort.signal); abort.abort(); await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(received.aborted, true);
});
test('untrusted downloads, redirect, excessive stream, broken WAV and oversized text fail closed', async () => {
  for (const url of ['https://127.0.0.1/a', 'https://evil.test/a', 'https://user@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a', 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:444/a', 'http://evil.test/a']) assert.throws(() => audioDownloadUrl(url, 'cn'));
  for (const download of [new Response('not wav'), new Response(null, { status: 302 }), new Response(new Uint8Array(16 * 1024 * 1024 + 1))]) {
    let calls = 0; const p = createVoiceProvider({ config, key: 'fixture-key', fetcher: async () => ++calls === 1 ? json({ output: { finish_reason: 'stop', audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a' } } }) : download });
    await assert.rejects(p.synthesize({ finalText: '正文' })); assert.equal(calls, 2);
  }
  let calls = 0; const p = createVoiceProvider({ config, key: 'fixture-key', fetcher: () => { calls++; throw Error(); } });
  await assert.rejects(p.synthesize({ finalText: '字'.repeat(6001) }), { code: 'AUDIO_LIMIT' }); assert.equal(calls, 0);
});
