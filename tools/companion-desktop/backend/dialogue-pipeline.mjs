// Text-only adaptation of AAAAGENT core/dialogue-pipeline.ts at the pinned
// revision. No capture, TTS, playback or engineering route is composed here.
import { randomUUID } from 'node:crypto';
import { composePrompt } from './prompt-composer.mjs';

export class LocalPersistenceError extends Error {
  constructor() { super('本地对话保存失败，请稍后重试。'); this.name = 'LocalPersistenceError'; }
}

export class DialoguePipeline {
  constructor({ memory, dialogue }) { this.memory = memory; this.dialogue = dialogue; }
  async run(text, { roleCard, thinking, runtime, memory = { schemaVersion: 1, entries: [] }, onProviderFailure = () => {}, onProviderSuccess = () => {} }) {
    const turnId = randomUUID();
    const composed = composePrompt({ text, roleCard, runtime, memory, history: this.memory.history() });
    let reply;
    try {
      reply = await this.dialogue({ messages: composed.messages, thinking });
      if (!reply || typeof reply.content !== 'string' || !reply.content.trim() || (reply.reasoningContent !== null && reply.reasoningContent !== undefined && typeof reply.reasoningContent !== 'string')) throw Error('文字服务没有返回完整的回复。');
    }
    catch (error) { onProviderFailure(); throw error; }
    onProviderSuccess();
    let reasoningContent = reply.reasoningContent?.trim() || null;
    let reasoningTruncated = false;
    if (reasoningContent && Buffer.byteLength(reasoningContent, 'utf8') > 256 * 1024) {
      const encoded = Buffer.from(reasoningContent);
      let end = 256 * 1024;
      if ((encoded[end] & 0xc0) === 0x80) {
        while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
      }
      reasoningContent = encoded.subarray(0, end).toString('utf8');
      reasoningTruncated = true;
    }
    const raw = reply.metadata && typeof reply.metadata === 'object' ? reply.metadata : {};
    const metadata = reply.metadata ? {
      source: raw.source === 'deepseek' ? 'deepseek' : null,
      requestedThinking: ['off', 'low', 'high', 'max'].includes(raw.requestedThinking) ? raw.requestedThinking : thinking?.enabled ? thinking.effort : 'off',
      requestModel: typeof raw.requestModel === 'string' ? raw.requestModel : null,
      responseModel: typeof raw.responseModel === 'string' ? raw.responseModel : null,
      fullResponseMs: Number.isFinite(raw.fullResponseMs) && raw.fullResponseMs >= 0 ? raw.fullResponseMs : null,
      finishReason: raw.finishReason === 'stop' ? 'stop' : null,
      reasoningTruncated
    } : null;
    const user = { id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), turnId, reasoningContent: null, metadata: null };
    const assistant = { id: randomUUID(), role: 'assistant', text: reply.content.trim(), createdAt: new Date().toISOString(), turnId, reasoningContent, metadata };
    try { this.memory.appendTurn([user, assistant]); }
    catch { throw new LocalPersistenceError(); }
    return { text: assistant.text, messages: [user, assistant] };
  }
}
