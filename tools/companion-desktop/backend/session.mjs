// Adapted from AAAAGENT BackendSession -> DialoguePipeline text path at
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. See THIRD_PARTY_NOTICES.md.
import { DialoguePipeline } from './dialogue-pipeline.mjs';
import { SqliteMemoryStore } from './sqlite-memory.mjs';
import { DEFAULT_ROLE_CARD } from './prompt-composer.mjs';

const IDENTITY = 'Emilia';

export class BackendSession {
  constructor({ directory, provider, mode = 'real' }) {
    this.memory = new SqliteMemoryStore(directory);
    this.provider = provider;
    this.pipeline = provider ? new DialoguePipeline({ memory: this.memory, dialogue: provider }) : null;
    this.mode = mode;
    this.busy = false;
    this.requestState = 'configured';
  }
  status() {
    const service = this.mode === 'preview' ? 'offline-preview' : this.provider ? this.requestState : 'unconfigured';
    return { identity: IDENTITY, service, capabilities: this.runtimeCapabilities() };
  }
  runtimeCapabilities() {
    return { text: { implemented: true, mode: this.mode, service: this.statusService() }, memoryManagement: false, voice: false, live2d: false, engineeringCards: false };
  }
  statusService() { return this.mode === 'preview' ? 'offline-preview' : this.provider ? this.requestState : 'unconfigured'; }
  history() {
    return this.memory.history();
  }
  displayHistory() { return this.memory.displayHistory(); }
  async submit(value, roleCard = DEFAULT_ROLE_CARD, thinking = { schemaVersion: 1, enabled: false, effort: 'high' }) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > 20000 || text.includes('\0')) throw Error('请输入不超过 20000 字的文字。');
    if (!this.provider) throw Error('DeepSeek 凭据未配置；请在设置中配置后再发送。');
    if (this.busy) throw Error('上一条消息尚未完成。');
    this.busy = true;
    try {
      const runtime = this.runtimeCapabilities();
      const result = await this.pipeline.run(text, { roleCard, thinking, runtime, onProviderFailure: () => { if (this.mode === 'real') this.requestState = 'unknown'; }, onProviderSuccess: () => { if (this.mode === 'real') this.requestState = 'verified'; } });
      return { ...result, status: this.status() };
    } finally { this.busy = false; }
  }
  close() { this.memory.close(); }
}
