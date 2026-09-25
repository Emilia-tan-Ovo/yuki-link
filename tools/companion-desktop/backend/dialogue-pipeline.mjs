// Text-only adaptation of AAAAGENT core/dialogue-pipeline.ts at the pinned
// revision. No capture, TTS, playback or engineering route is composed here.
import { randomUUID } from 'node:crypto';

const SYSTEM = '你是艾米莉亚（Emilia），Yuki Link 的温柔、坦诚的陪伴角色。用自然的中文回应。不要声称你有未提供的记忆、设备能力或工程执行能力。';

export class DialoguePipeline {
  constructor({ memory, dialogue }) { this.memory = memory; this.dialogue = dialogue; }
  async run(text) {
    const turnId = randomUUID();
    const history = this.memory.history().slice(-20).map(row => ({ role: row.role, content: row.text }));
    const reply = await this.dialogue({ text, history, system: SYSTEM });
    if (typeof reply !== 'string' || !reply.trim()) throw Error('文字服务没有返回可显示的回复。');
    const user = { id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), turnId };
    const assistant = { id: randomUUID(), role: 'assistant', text: reply.trim(), createdAt: new Date().toISOString(), turnId };
    this.memory.appendTurn([user, assistant]);
    return { text: assistant.text, messages: [user, assistant] };
  }
}
