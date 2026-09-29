import { join } from 'node:path';
import QRCode from 'qrcode';
import { ChannelStore } from './channel-store.mjs';
import { WeChatApi } from './api.mjs';
import { WeChatService } from './service.mjs';
import { WeChatConversation } from './conversation.mjs';
import { WeChatWorkerPort } from './worker-port.mjs';

export class WeChatRuntime {
  constructor({ directory, safeStorage, connection, settings, deliver, enabled = true }) {
    this.directory = directory; this.safeStorage = safeStorage; this.connection = connection;
    this.settings = settings; this.deliver = deliver; this.enabled = enabled;
  }
  async start() {
    if (!this.enabled || !this.safeStorage.isEncryptionAvailable()) { this.initError = this.enabled ? '本机加密存储不可用。' : '离线预览不连接真实微信。'; this.publish(); return; }
    const crypto = {
      seal: value => this.safeStorage.encryptString(value).toString('base64'),
      open: value => this.safeStorage.decryptString(Buffer.from(value, 'base64')),
    };
    this.store = await ChannelStore.load(join(this.directory, 'wechat-channel.bin'), crypto);
    this.port = new WeChatWorkerPort(this.connection, this.settings);
    this.api = new WeChatApi();
    this.conversation = new WeChatConversation({ store: this.store, backend: this.port, api: this.api, isAuthorized: () => this.service?.active === true });
    this.service = new WeChatService({ store: this.store, api: this.api,
      backendGeneration: () => this.port.generation(),
      backendReady: () => this.connection.state === 'ready',
      receive: input => this.conversation.receive(input),
      revoke: () => { this.conversation.selection = null; this.port.revoke(); } });
    this.timer = setInterval(() => { void this.tick(); }, 2500);
    this.publish();
  }
  async tick() {
    if (!this.service || this.ticking) return;
    this.ticking = true;
    try {
      if (['waiting_scan','scanned','need_verification'].includes(this.service.state.status) && this.service.pending) {
        await this.service.checkLogin(this.service.pending.qr.qrcode);
      } else if (!this.store.paused() && this.store.binding()) {
        await this.service.pollOnce();
      }
    } catch { this.service.update('unavailable'); }
    finally { this.ticking = false; }
    void this.publish();
  }
  onWorkerMessage(message, generation) {
    const consumed = this.port?.onMessage(message, generation) ?? false;
    if (message?.type === 'disconnected' && this.service?.active) void this.service.pause().then(() => this.publish()).catch(() => this.publish());
    return consumed;
  }
  async action(action, value = {}) {
    if (!this.service) return;
    if (action === 'begin') await this.service.beginLogin(this.service.state.revision);
    else if (action === 'confirm') await this.service.confirmBinding(value.revision);
    else if (action === 'pause') await this.service.pause();
    else if (action === 'resume') await this.service.resume();
    else if (action === 'unbind') await this.service.unbind();
    else if (action === 'refresh') await this.tick();
    else return;
    this.publish();
  }
  async publish() {
    const publication = this.publication = (this.publication ?? 0) + 1;
    if (!this.service) { this.deliver({ type: 'wechat-state', status: 'unavailable', detail: this.initError || '微信资料无法读取。' }); return; }
    const snapshot = this.service.snapshot();
    const qrImage = snapshot.qr ? await QRCode.toDataURL(snapshot.qr.content, { errorCorrectionLevel: 'M', margin: 2, width: 240 }).catch(() => null) : null;
    const current = this.service.snapshot();
    if (publication !== this.publication || current.revision !== snapshot.revision || current.qr?.content !== snapshot.qr?.content) return;
    this.deliver({ type: 'wechat-state', status: snapshot.status, detail: snapshot.detail, revision: snapshot.revision,
      bound: snapshot.bound, qrImage, qrExpiresAt: snapshot.qr?.expiresAt, lastInputAt: snapshot.lastInputAt, lastDelivery: snapshot.lastDelivery });
  }
  async reconcile() {
    if (!this.conversation || this.connection.state !== 'ready') return;
    for (const claim of this.store.unresolvedClaims()) await this.conversation.reconcile(claim.id, claim.epoch).catch(() => {});
  }
  close() { if (this.timer) clearInterval(this.timer); this.port?.revoke(); }
}
