// Text-only adaptation of AAAAGENT core/dialogue-pipeline.ts at the pinned
// revision. No capture, TTS, playback or engineering route is composed here.
import { randomUUID } from 'node:crypto';
import { composePrompt } from './prompt-composer.mjs';

export class DialoguePipeline {
  constructor({ memory, dialogue }) { this.memory = memory; this.dialogue = dialogue; }
  async run(text, { roleCard, runtime, memory = { schemaVersion: 1, entries: [] }, onProviderFailure = () => {} }) {
    const turnId = randomUUID();
    const composed = composePrompt({ text, roleCard, runtime, memory, history: this.memory.history() });
    let reply;
    try { reply = await this.dialogue({ messages: composed.messages }); }
    catch (error) { onProviderFailure(); throw error; }
    if (typeof reply !== 'string' || !reply.trim()) { onProviderFailure(); throw Error('文字服务没有返回可显示的回复。'); }
    const user = { id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), turnId };
    const assistant = { id: randomUUID(), role: 'assistant', text: reply.trim(), createdAt: new Date().toISOString(), turnId };
    this.memory.appendTurn([user, assistant]);
    return { text: assistant.text, messages: [user, assistant] };
  }
}
