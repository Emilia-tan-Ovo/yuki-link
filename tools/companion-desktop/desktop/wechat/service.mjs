// Channel filtering and claim flow adapted from phoiex/AAAAGENT
// windows/code/desktop-pet/wechat/service.ts at 2752349bcc7f7137b8b9e4ff9cccf34026d77aad.
import { createHash } from 'node:crypto';
import { WeChatApiError, ILINK_ORIGIN, weixinOrigin } from './api.mjs';
import { qrPayload } from './qr.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const valid = (value, limit = 8192) => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');
const eligible = (msg, auth, boundAt) => !!msg && valid(msg.message_id, 256) &&
  msg.from_user_id === auth.userId && msg.to_user_id === auth.botId && !msg.group_id &&
  msg.message_type === 1 && msg.message_state === 2 &&
  Number.isSafeInteger(msg.create_time_ms) && msg.create_time_ms >= boundAt &&
  valid(msg.context_token) && Array.isArray(msg.item_list) && msg.item_list.length === 1 &&
  msg.item_list[0]?.type === 1 && valid(msg.item_list[0]?.text_item?.text, 20000);
const protocolMismatch = msg => !!msg && (!valid(msg.message_id, 256) || !valid(msg.to_user_id, 256) || !Number.isSafeInteger(msg.create_time_ms) || !valid(msg.context_token));

/** One installation, one owner binding; caller drives polling and trusted UI actions. */
export class WeChatService {
  constructor({ store, api, receive, now = Date.now, backendGeneration = () => null, backendReady = () => true, revoke = () => {} }) {
    this.store = store; this.api = api; this.receive = receive; this.now = now; this.backendGeneration = backendGeneration;
    this.backendReady = backendReady;
    this.revoke = revoke;
    this.active = false;
    this.pending = null;
    this.loginAttempt = 0;
    this.polling = false;
    this.state = { revision: 0, status: store.binding() ? 'paused' : 'unbound', detail: '', lastInputAt: store.lastInputAt?.() ?? null, lastDelivery: store.lastDelivery?.() ?? 'none' };
  }
  snapshot() { return structuredClone({ ...this.state, bound: !!this.store.binding(), qr: this.pending?.qr ? { content: this.pending.qr.content, expiresAt: this.pending.qr.expiresAt } : null }); }
  update(status, detail = '') { this.state = { ...this.state, status, detail, revision: this.state.revision + 1 }; return this.snapshot(); }
  async beginLogin(expectedRevision, signal = new AbortController().signal) {
    if (expectedRevision !== this.state.revision) throw Error('WeChat revision conflict');
    this.active = false; this.revoke();
    this.pending = null;
    const attempt = ++this.loginAttempt;
    if (this.store.binding()) await this.store.setPaused(true);
    const qr = qrPayload(await this.api.qr(signal), this.now());
    if (this.loginAttempt !== attempt) throw Error('QR session replaced');
    this.pending = { qr, base: ILINK_ORIGIN, candidate: null, redirects: 0 };
    this.update('waiting_scan');
    return qr;
  }
  async checkLogin(qrcode, signal = new AbortController().signal, code) {
    const pending = this.pending;
    if (!pending || qrcode !== pending.qr.qrcode) throw Error('QR session unavailable');
    if (this.now() >= pending.qr.expiresAt) { this.pending = null; return this.update('qr_expired'); }
    const result = await this.api.qrStatus(pending.base, qrcode, signal, code);
    if (this.pending !== pending || this.now() >= pending.qr.expiresAt) return this.snapshot();
    if (result.status === 'expired' || result.status === 'verify_code_blocked') { this.pending = null; return this.update('qr_expired'); }
    if (result.status === 'scaned_but_redirect') {
      if (!valid(result.redirect_host, 256) || ++pending.redirects > 3) throw new WeChatApiError('invalid_response');
      pending.base = weixinOrigin(`https://${result.redirect_host}`);
      return this.update('scanned');
    }
    if (result.status === 'confirmed') {
      if (![result.bot_token, result.ilink_bot_id, result.ilink_user_id, result.baseurl].every(value => valid(value))) throw new WeChatApiError('invalid_response');
      pending.candidate = { token: result.bot_token, botId: result.ilink_bot_id, userId: result.ilink_user_id, baseUrl: weixinOrigin(result.baseurl) };
      return this.update('awaiting_local_confirmation');
    }
    if (result.status === 'need_verifycode') return this.update('need_verification');
    if (result.status === 'scaned') return this.update('scanned');
    return this.snapshot();
  }
  async confirmBinding(expectedRevision) {
    if (expectedRevision !== this.state.revision || !this.pending?.candidate || this.now() >= this.pending.qr.expiresAt) throw Error('Binding confirmation unavailable');
    const pending = this.pending, attempt = this.loginAttempt;
    this.active = false;
    await this.store.bind(pending.candidate, this.now());
    const boundEpoch = this.store.epoch();
    if (this.pending !== pending || this.loginAttempt !== attempt || expectedRevision !== this.state.revision) {
      await this.store.unbind(boundEpoch);
      throw Error('Binding confirmation superseded');
    }
    this.pending = null;
    this.state.lastDelivery = 'none'; this.state.lastInputAt = null;
    return this.update('paused');
  }
  async pause() {
    this.active = false; this.pending = null; this.loginAttempt++; this.revoke();
    await this.store.setPaused(true);
    return this.update(this.store.binding() ? 'paused' : 'unbound');
  }
  async resume(signal = new AbortController().signal) {
    if (!this.store.binding()) return this.update('unbound');
    if (this.pending) throw Error('Binding attempt in progress');
    if (!this.backendReady()) return this.update('backend_unavailable');
    await this.store.setPaused(false);
    this.active = true;
    return this.pollOnce(signal);
  }
  async unbind() {
    this.active = false;
    this.pending = null;
    this.loginAttempt++;
    this.revoke();
    await this.store.unbind();
    this.state.lastDelivery = 'none'; this.state.lastInputAt = null;
    return this.update('unbound');
  }
  async pollOnce(signal = new AbortController().signal) {
    if (this.polling) return this.snapshot();
    this.polling = true;
    try { return await this.pollBatch(signal); }
    finally { this.polling = false; }
  }
  async pollBatch(signal) {
    const auth = this.store.binding();
    const epoch = this.store.epoch();
    if (!auth) return this.update('unbound');
    if (this.store.paused() || !this.active) return this.update('paused');
    if (!this.backendReady()) { this.active = false; await this.store.setPaused(true, epoch); return this.update('backend_unavailable'); }
    let result;
    try { result = await this.api.updates(auth, this.store.cursor(), signal); }
    catch (error) {
      if (this.store.epoch() !== epoch || this.store.paused()) return this.snapshot();
      if (!this.backendReady()) { this.active = false; await this.store.setPaused(true, epoch); return this.update('backend_unavailable'); }
      if (error instanceof WeChatApiError && error.kind === 'expired') {
        this.active = false;
        this.pending = null;
        this.loginAttempt++;
        this.revoke(); await this.store.unbind();
        return this.update('auth_expired');
      }
      this.active = false; await this.store.setPaused(true, epoch);
      this.revoke(); return this.update('unavailable');
    }
    if (this.store.epoch() !== epoch || this.store.paused()) return this.snapshot();
    if (result?.ret !== 0 || !Array.isArray(result.msgs) || !valid(result.get_updates_buf, 100000)) { this.active = false; await this.store.setPaused(true, epoch); return this.update('protocol_mismatch'); }
    this.update('connected'); // Only an authenticated getupdates response establishes availability.
    for (const msg of result.msgs ?? []) {
      signal.throwIfAborted();
      if (this.store.epoch() !== epoch || this.store.paused()) return this.snapshot();
      if (protocolMismatch(msg) && msg?.from_user_id === auth.userId) { this.active = false; await this.store.setPaused(true, epoch); return this.update('protocol_mismatch'); }
      if (!eligible(msg, auth, this.store.boundAt())) continue;
      const text = msg.item_list[0].text_item.text;
      if (!await this.store.claim(msg.message_id, msg.context_token, { epoch, text, backendGeneration: this.backendGeneration(), at: this.now() })) continue;
      this.state.lastInputAt = new Date(this.now()).toISOString();
      try { const observed = await this.receive({ messageId: msg.message_id, text, contextToken: msg.context_token, bindingEpoch: epoch, inboundKey: digest(msg.message_id) }); if (this.store.epoch() === epoch) this.state.lastDelivery = observed?.delivery ?? 'none'; }
      catch { await this.store.finish(msg.message_id, epoch, { status: 'unknown' }); }
      if (this.store.epoch() !== epoch || this.store.paused()) return this.snapshot();
    }
    const resolved = (result.msgs ?? []).every(msg => !eligible(msg, auth, this.store.boundAt()) ||
      ['handled', 'committed', 'unknown'].includes(this.store.record(msg.message_id, epoch)?.status));
    if (this.store.epoch() === epoch && !this.store.paused() && resolved) await this.store.setCursor(result.get_updates_buf, epoch);
    return this.snapshot();
  }
}
