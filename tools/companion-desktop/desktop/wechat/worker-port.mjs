import { randomUUID } from 'node:crypto';

/** Only the WeChat text and Companion Memory verbs cross this port. */
export class WeChatWorkerPort {
  constructor(connection, settings) { this.connection = connection; this.settings = settings; this.pending = new Map(); }
  generation() { return this.connection.generation; }
  onMessage(message, generation) {
    if (message?.type === 'disconnected') {
      for (const [id, item] of this.pending) { clearTimeout(item.timer); item.resolve({ outcome: 'unknown', reason: 'disconnected' }); this.pending.delete(id); }
      return false;
    }
    if (message?.type !== 'wechat-result') return false;
    const item = this.pending.get(message.id);
    if (!item || item.generation !== generation) return true;
    clearTimeout(item.timer); this.pending.delete(message.id); item.resolve(message);
    return true;
  }
  request(action, input = {}) {
    const id = randomUUID(), generation = this.generation();
    const settings = this.settings();
    const payload = { type: 'wechat', action, id, ...input, requestId: input.operationId ?? input.requestId,
      ...(action === 'submit' ? { roleCard: settings.roleCard, thinking: settings.thinking } : {}) };
    return new Promise(resolve => {
      if (this.connection.state !== 'ready' || !this.connection.send(payload, generation)) { resolve({ outcome: 'rejected', reason: 'backend_unavailable' }); return; }
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ outcome: 'unknown', reason: 'timeout' }); }, 120000);
      this.pending.set(id, { resolve, timer, generation, operationId: input.operationId, action });
    });
  }
  submit(input) { return this.request('submit', input); }
  list(input) { return this.request('list', input); }
  remember(input) { return this.request('remember', input); }
  correct(input) { return this.request('correct', input); }
  forget(input) { return this.request('forget', input); }
  lookup(input) { return this.request('lookup', input); }
  cancel(input) { return this.request('cancel', input); }
  revoke() {
    for (const item of this.pending.values()) if (item.action === 'submit' && item.operationId) {
      this.connection.send({ type: 'wechat', action: 'cancel', id: randomUUID(), operationId: item.operationId, requestId: item.operationId }, item.generation);
    }
  }
}
