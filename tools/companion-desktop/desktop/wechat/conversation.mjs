import { createHash, randomUUID } from 'node:crypto';
import { backendPort } from './backend-port.mjs';
import { WeChatApiError } from './api.mjs';

const textLimit = 1500;
const hash = value => createHash('sha256').update(value).digest('hex');
const split = text => {
  const chars = Array.from(text), parts = [];
  for (let i = 0; i < chars.length; i += textLimit) parts.push(chars.slice(i, i + textLimit).join(''));
  return parts;
};

/** The channel owns claims and delivery evidence, never a second chat or memory store. */
export class WeChatConversation {
  constructor({ store, backend, api, now = Date.now, isAuthorized = () => true }) {
    this.store = store; this.backend = backendPort(backend); this.api = api; this.now = now;
    this.isAuthorized = isAuthorized;
    this.selection = null;
  }
  current(epoch, generation) {
    return this.isAuthorized() && !!this.store.binding() && !this.store.paused() && this.store.epoch() === epoch &&
      (generation == null || this.backend.generation() === generation);
  }
  /** Read-only recovery seam; an absent receipt never authorizes re-execution. */
  async reconcile(messageId, epoch = this.store.epoch()) {
    const claim = this.store.record(messageId, epoch);
    if (!claim || !['pending', 'processing', 'unknown'].includes(claim.status)) return null;
    const receipt = await this.backend.lookup({ operationId: claim.operationId, payloadDigest: claim.payloadDigest });
    if (receipt?.operationId === claim.operationId && receipt.payloadDigest === claim.payloadDigest) {
      await this.store.finish(messageId, epoch, { status: 'committed', turnId: receipt.turnId ?? null, messageId: receipt.resultId ?? null });
      return { status: 'committed' };
    }
    await this.store.finish(messageId, epoch, { status: 'unknown' });
    return { status: 'unknown' };
  }
  async receive({ messageId, text, contextToken, bindingEpoch }, signal = new AbortController().signal) {
    const epoch = bindingEpoch ?? this.store.epoch();
    const prior = this.store.record(messageId, epoch);
    if (!prior) throw Error('Inbound claim required');
    if (prior.status !== 'pending') return { duplicate: true, delivery: prior.delivery, processing: prior.status };
    if (prior.contextToken !== contextToken || prior.payloadDigest !== hash(JSON.stringify({ text, contextToken })) || prior.epoch !== epoch) throw Error('Inbound claim conflict');
    const generation = prior.backendGeneration;
    if (!this.current(epoch, generation)) { await this.reconcile(messageId, epoch); return { delivery: 'none', processing: 'binding_changed' }; }
    if (!await this.store.finish(messageId, epoch, { status: 'processing' })) return { delivery: 'none', processing: 'binding_changed' };
    if (!this.current(epoch, generation)) return { delivery: 'none', processing: 'binding_changed' };

    const input = { operationId: prior.operationId, payloadDigest: prior.payloadDigest, bindingEpoch: epoch };
    let finalText, turnId = null, assistantId = null, status = 'handled', memoryRevision;
    try {
      const command = this.command(text);
      if (command?.action === 'invalid') {
        // Guidance is local only; it must not be mistaken for a committed backend reply.
        finalText = '请使用 /记住 <事实>、/记忆、/更正 <选择码> <新事实> 或 /遗忘 <选择码>。';
      }
      else if (command?.action === 'list') {
        if (!this.current(epoch, generation)) return { delivery: 'none', processing: 'binding_changed' };
        const result = await this.backend.list(input);
        if (!this.current(epoch, generation)) { await this.reconcile(messageId, epoch); return { delivery: 'none', processing: 'binding_changed' }; }
        if (result?.outcome !== 'committed' || !Array.isArray(result.entries) || typeof result.listVersion !== 'string') throw Error('Memory list unconfirmed');
        memoryRevision = result.memoryRevision;
        const entries = result.entries.filter(row => typeof row.id === 'string' && typeof row.text === 'string').slice(0, 20);
        const codes = entries.map(() => randomUUID());
        this.selection = { epoch, listVersion: result.listVersion, codes: Object.fromEntries(entries.map((row, i) => [codes[i], row.id])), expiresAt: this.now() + 5 * 60_000 };
        finalText = entries.length ? entries.map((row, i) => `${codes[i]}  ${row.text}`).join('\n') : '当前没有可列出的陪伴记忆。';
      } else if (command) {
        let targetId;
        if (command.action === 'correct' || command.action === 'forget') {
          const selection = this.selection;
          if (!selection || selection.epoch !== epoch || selection.expiresAt <= this.now() || !selection.codes[command.code]) {
            finalText = '选择码已失效，请先发送 /记忆 重新列出。';
            status = 'handled';
          } else {
            if (!this.current(epoch, generation)) return { delivery: 'none', processing: 'binding_changed' };
            const active = await this.backend.list(input);
            if (!this.current(epoch, generation)) { await this.reconcile(messageId, epoch); return { delivery: 'none', processing: 'binding_changed' }; }
            targetId = selection.codes[command.code];
            if (active?.outcome !== 'committed' || active.listVersion !== selection.listVersion || !active.entries?.some(row => row.id === targetId)) {
              this.selection = null;
              finalText = '选择码已失效，请先发送 /记忆 重新列出。';
              status = 'handled';
            }
          }
        }
        if (finalText) { /* deterministic local guidance does not mutate memory */ }
        else {
        if (!this.current(epoch, generation)) return { delivery: 'none', processing: 'binding_changed' };
        const result = await this.backend[command.action]({ ...input, ...(targetId ? { targetId } : {}), ...(command.text ? { text: command.text } : {}), ...(command.action === 'remember' ? { sourceRef: `wechat:${hash(messageId)}` } : {}) });
        if (!this.current(epoch, generation)) { await this.reconcile(messageId, epoch); return { delivery: 'none', processing: 'binding_changed' }; }
        if (result?.outcome === 'rejected' || result?.outcome === 'cancelled') { status = 'handled'; finalText = result.reason === 'busy' ? '上一条消息尚未完成，请稍后再试。' : '记忆操作未受理，请检查输入并重新列出。'; }
        else if (result?.outcome !== 'committed' || typeof result.finalText !== 'string') throw Error('Memory operation unconfirmed');
        this.selection = null;
        if (!finalText) { finalText = result.finalText; status = 'committed'; memoryRevision = result.memoryRevision; }
        }
      } else {
        if (!this.current(epoch, generation)) return { delivery: 'none', processing: 'binding_changed' };
        const result = await this.backend.submit({ ...input, text });
        if (!this.current(epoch, generation)) { await this.reconcile(messageId, epoch); return { delivery: 'none', processing: 'binding_changed' }; }
        if (result?.outcome === 'rejected' || result?.outcome === 'cancelled') { status = 'handled'; finalText = result.reason === 'busy' ? '上一条消息尚未完成，请稍后再试。' : '文字服务当前无法受理，请检查配置。'; }
        else if (result?.outcome !== 'committed' || typeof result.finalText !== 'string' || !result.finalText.trim() || !result.turnId || !result.messageId) throw Error('Backend result unconfirmed');
        else { status = 'committed'; turnId = result.turnId; assistantId = result.messageId; finalText = result.finalText; memoryRevision = result.memoryRevision; }
      }
    } catch {
      if (this.current(epoch, generation)) await this.store.finish(messageId, epoch, { status: 'unknown' });
      return { delivery: 'none', processing: 'unknown' };
    }
    if (!this.current(epoch, generation)) { await this.reconcile(messageId, epoch); return { delivery: 'none', processing: 'binding_changed' }; }
    if (!await this.store.finish(messageId, epoch, { status, turnId, messageId: assistantId, memoryRevision })) return { delivery: 'none', processing: 'binding_changed' };
    if (!this.current(epoch, generation)) return { delivery: 'none', processing: 'binding_changed' };
    if (!finalText || !contextToken) return { delivery: 'none', processing: status };
    const parts = split(finalText), deliveryId = randomUUID();
    // Per-part intent is durable before each network call. An interrupted attempt is unknown.
    for (let index = 0; index < parts.length; index++) {
      if (!this.current(epoch, generation)) return { delivery: 'unknown', processing: 'binding_changed' };
      if (Number.isSafeInteger(memoryRevision)) {
        const current = await this.backend.list(input);
        if (!this.current(epoch, generation)) return { delivery: 'unknown', processing: 'binding_changed' };
        if (current.outcome !== 'committed' || current.memoryRevision !== memoryRevision) {
          await this.store.finish(messageId, epoch, { delivery: 'stale_memory' });
          return { delivery: 'stale_memory', processing: status };
        }
      }
      const clientId = randomUUID();
      const part = { deliveryId, index, count: parts.length, clientId, status: 'unknown', attemptedAt: this.now(), observedAt: null };
      if (!await this.store.finish(messageId, epoch, { parts: [...this.store.record(messageId, epoch).parts, part] })) return { delivery: 'unknown', processing: 'binding_changed' };
      const auth = this.store.binding();
      if (!this.current(epoch, generation) || auth?.userId !== prior.recipient) return { delivery: 'unknown', processing: 'binding_changed' };
      let outcome;
      try {
        const result = await this.api.send(auth, prior.contextToken, parts[index], clientId, signal);
        outcome = result?.ret === 0 && (result.errcode === undefined || result.errcode === 0) ? 'accepted_by_transport' : 'unknown';
      } catch (error) { outcome = error instanceof WeChatApiError && error.kind === 'rejected' ? 'failed' : 'unknown'; }
      if (!this.current(epoch, generation)) return { delivery: 'unknown', processing: 'binding_changed' };
      const saved = this.store.record(messageId, epoch).parts;
      saved[index] = { ...saved[index], status: outcome, observedAt: this.now() };
      await this.store.finish(messageId, epoch, { parts: saved });
      if (outcome !== 'accepted_by_transport') break;
    }
    const outcomes = this.store.record(messageId, epoch).parts.map(part => part.status);
    const delivery = outcomes.length === parts.length && outcomes.every(value => value === 'accepted_by_transport') ? 'accepted_by_transport' : outcomes.includes('unknown') ? 'unknown' : outcomes.includes('accepted_by_transport') ? 'partial' : 'failed';
    await this.store.finish(messageId, epoch, { delivery, deliveryObservedAt: this.now() });
    return { delivery };
  }
  command(text) {
    const trimmed = text.trim();
    if (trimmed === '/记忆') return { action: 'list' };
    const remember = /^\/记住\s+(.+)$/s.exec(trimmed);
    if (remember) return { action: 'remember', text: remember[1].trim() };
    const correct = /^\/更正\s+([a-f0-9-]{36})\s+(.+)$/s.exec(trimmed);
    if (correct) return { action: 'correct', code: correct[1], text: correct[2].trim() };
    const forget = /^\/遗忘\s+([a-f0-9-]{36})$/s.exec(trimmed);
    if (forget) return { action: 'forget', code: forget[1] };
    if (/^\/(记忆|记住|更正|遗忘)(?:\s|$)/.test(trimmed)) return { action: 'invalid' };
    return null;
  }
}
