import { randomUUID } from 'node:crypto';
import { digestCardContent } from './engineering-card-store.mjs';

export const entrySchema = `
CREATE TABLE card_entry_previews (preview_id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE card_entry_actions (operation_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE card_confirmation_origins (card_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(card_id,revision));
CREATE TABLE card_result_subscriptions (card_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(card_id,revision));
CREATE TABLE card_result_events (event_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL);
CREATE TABLE card_result_deliveries (event_id TEXT NOT NULL, destination TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(event_id,destination));
CREATE TABLE card_preparation_consumptions (card_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(card_id,revision));`;
const read = (db, sql, ...args) => {
  const row = db.prepare(sql).get(...args);
  return row ? JSON.parse(row.record) : null;
};
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const validOrigin = value => value?.source === 'wechat-user-action' && typeof value.epoch === 'string'
  && fingerprint(value.recipientFingerprint) && typeof value.operationId === 'string'
  && fingerprint(value.payloadDigest) && typeof value.previewId === 'string';

// These methods are internal domain seams. Authority guards are synchronous main-process closures.
export class EngineeringEntryStore {
  preview(id) { return read(this.db,'SELECT record FROM card_entry_previews WHERE preview_id=?',id); }
  savePreview(record) {
    this.db.prepare('INSERT INTO card_entry_previews VALUES (?,?)').run(record.previewId,JSON.stringify(record));
    return record;
  }
  activatePreview(id, evidence, guard) {
    return this.transaction(() => {
      const preview = this.preview(id), card = preview && this.get(preview.cardId);
      if (!preview || !card || card.revision !== preview.revision || digestCardContent(card.content) !== preview.contentDigest
        || evidence?.delivery !== 'accepted_by_transport' || evidence.parts?.length !== preview.partCount
        || !evidence.parts.every(part => part.status === 'accepted_by_transport')) return false;
      preview.accepted = true; preview.deliveryRef = evidence.deliveryRef;
      this.db.prepare('UPDATE card_entry_previews SET record=? WHERE preview_id=?').run(JSON.stringify(preview),id);
      return true;
    },guard);
  }
  actionReceipt(operationId, payloadDigest) {
    const row = this.db.prepare('SELECT * FROM card_entry_actions WHERE operation_id=?').get(operationId);
    if (row && row.payload_digest !== payloadDigest) throw Error('工程动作身份冲突。');
    return row ? JSON.parse(row.record) : null;
  }
  entryAction(context, fn) {
    if (!validOrigin(context) || typeof context.guard !== 'function') throw Error('工程动作可信来源缺失。');
    return this.transaction(() => {
      const prior = this.actionReceipt(context.operationId,context.payloadDigest);
      if (prior) return { ...prior, deduplicated:true };
      const result = fn();
      if (result?.then) throw Error('工程动作事务不能跨异步操作。');
      const record = { ...result, operationId:context.operationId, payloadDigest:context.payloadDigest,
        origin:{source:context.source,epoch:context.epoch,recipientFingerprint:context.recipientFingerprint,
          generation:context.generation,previewId:context.previewId} };
      this.db.prepare('INSERT INTO card_entry_actions VALUES (?,?,?)').run(context.operationId,context.payloadDigest,JSON.stringify(record));
      return record;
    },context.guard);
  }
  validateEntryPreview(card, context, { confirmation = false } = {}) {
    if (!validOrigin(context) || typeof context.guard !== 'function') throw Error('工程动作可信来源缺失。');
    const preview = this.preview(context.previewId);
    if (!preview || preview.cardStoreId !== this.storeId || preview.cardId !== card.cardId || preview.revision !== card.revision
      || preview.contentDigest !== digestCardContent(card.content) || preview.epoch !== context.epoch
      || preview.recipientFingerprint !== context.recipientFingerprint || preview.generation !== context.generation
      || preview.authorityRevision!==context.authorityRevision || preview.authorityId!==context.authorityId
      || preview.expiresAt <= Date.now() || confirmation && (!preview.accepted || preview.consumed)) throw Error('工程选择码已失效，请重新查看。');
    return preview;
  }
  saveConfirmationOrigin(card, context) {
    const preview = this.validateEntryPreview(card,context,{confirmation:true});
    const origin = { source:context.source, cardStoreId:this.storeId, cardId:card.cardId, revision:card.revision,
      epoch:context.epoch, recipientFingerprint:context.recipientFingerprint, generation:context.generation,
      operationId:context.operationId, payloadDigest:context.payloadDigest, previewId:preview.previewId,
      previewDigest:preview.previewDigest, contentDigest:preview.contentDigest, deliveryRef:preview.deliveryRef };
    this.db.prepare('INSERT INTO card_confirmation_origins VALUES (?,?,?)').run(card.cardId,card.revision,JSON.stringify(origin));
    preview.consumed = true;
    this.db.prepare('UPDATE card_entry_previews SET record=? WHERE preview_id=?').run(JSON.stringify(preview),preview.previewId);
  }
  confirmationOrigin(cardId,revision) { return read(this.db,'SELECT record FROM card_confirmation_origins WHERE card_id=? AND revision=?',cardId,revision); }
  trustedWorkStop(stop) {
    if (stop?.action_source==='desktop-user-action') return true;
    if (stop?.action_source!=='wechat-user-action') return false;
    const row=this.db.prepare('SELECT record FROM card_entry_actions WHERE operation_id=?').get(stop.control_id);
    const receipt=row && JSON.parse(row.record), origin=receipt?.origin, preview=origin && this.preview(origin.previewId);
    return !!(receipt?.stop?.control_id===stop.control_id && receipt.stop.confirmation_digest===stop.confirmation_digest
      && origin.source==='wechat-user-action' && preview?.cardId===stop.card_id && preview.revision===stop.revision
      && preview.epoch===origin.epoch && preview.recipientFingerprint===origin.recipientFingerprint);
  }
  trustedConfirmation(card) {
    if (!card?.confirmation || card.confirmation.revision !== card.revision
      || digestCardContent(card.content) !== digestCardContent(card.confirmation.content)) return false;
    if (card.confirmation.actionSource === 'desktop-user-action') return true;
    if (card.confirmation.actionSource !== 'wechat-user-action') return false;
    const origin = this.confirmationOrigin(card.cardId,card.revision), preview = origin && this.preview(origin.previewId);
    const receipt = origin && this.actionReceipt(origin.operationId,origin.payloadDigest);
    return !!(validOrigin(origin) && origin.cardStoreId === this.storeId && origin.cardId === card.cardId
      && origin.revision === card.revision && origin.contentDigest === digestCardContent(card.content)
      && preview?.accepted && preview.consumed && preview.previewDigest === origin.previewDigest
      && preview.deliveryRef === origin.deliveryRef && preview.epoch === origin.epoch
      && preview.recipientFingerprint === origin.recipientFingerprint && receipt?.card?.cardId === card.cardId
      && receipt.card.revision === card.revision && !receipt.conflict && !receipt.invalid);
  }
  subscribeResults(card, destination) {
    if (!destination || destination.desktop !== true) throw Error('结果入口缺失。');
    const wechat = destination.wechat;
    if (wechat && (typeof wechat.epoch !== 'string' || !fingerprint(wechat.recipientFingerprint))) throw Error('结果目的地无效。');
    this.db.prepare('INSERT OR IGNORE INTO card_result_subscriptions VALUES (?,?,?)').run(card.cardId,card.revision,JSON.stringify({
      cardId:card.cardId,revision:card.revision,confirmationAt:card.confirmation.confirmedAt,desktop:true,
      wechat:wechat ?? null,wechatUnavailable:wechat ? null:'unbound' }));
    if (card.preparationStatus==='authorized') this.db.prepare('INSERT OR IGNORE INTO card_preparation_consumptions VALUES (?,?,?)')
      .run(card.cardId,card.revision,JSON.stringify({state:'reserved',contentDigest:digestCardContent(card.content)}));
  }
  preparationConsumption(cardId,revision) { return read(this.db,'SELECT record FROM card_preparation_consumptions WHERE card_id=? AND revision=?',cardId,revision); }
  claimPreparationConsumption(card) { return this.transaction(()=>{
    const current=this.get(card.cardId);
    if (current?.revision!==card.revision || current.state!=='confirmed' || !this.trustedConfirmation(current)
      || current.preparationStatus!=='authorized' || this.workStop(card.cardId,card.revision)) return false;
    const prior=this.preparationConsumption(card.cardId,card.revision);
    if (prior && (prior.state!=='reserved' || prior.contentDigest!==digestCardContent(current.content))) return false;
    const record={state:'attempted',contentDigest:digestCardContent(current.content)};
    this.db.prepare('INSERT INTO card_preparation_consumptions VALUES (?,?,?) ON CONFLICT(card_id,revision) DO UPDATE SET record=excluded.record')
      .run(card.cardId,card.revision,JSON.stringify(record));
    return true;
  }); }
  finishPreparationConsumption(card,receipt) { return this.transaction(()=>{
    const record=this.preparationConsumption(card.cardId,card.revision);
    if (record?.state!=='attempted') return false;
    record.state='observed'; record.receipt=receipt;
    this.db.prepare('UPDATE card_preparation_consumptions SET record=? WHERE card_id=? AND revision=?').run(JSON.stringify(record),card.cardId,card.revision);
    return true;
  }); }
  resultSubscriptions() { return this.db.prepare('SELECT record FROM card_result_subscriptions').all().map(row=>JSON.parse(row.record)); }
  resultEvents(cardId,revision) { return this.db.prepare('SELECT record FROM card_result_events WHERE card_id=? AND revision=?').all(cardId,revision).map(row=>JSON.parse(row.record)); }
  saveResult(event,subscription) { return this.transaction(() => {
    this.db.prepare('INSERT OR IGNORE INTO card_result_events VALUES (?,?,?,?)').run(event.eventId,event.cardId,event.revision,JSON.stringify(event));
    for (const destination of ['desktop','wechat']) this.db.prepare('INSERT OR IGNORE INTO card_result_deliveries VALUES (?,?,?)').run(event.eventId,destination,JSON.stringify({
      eventId:event.eventId,destination,state:destination==='wechat' && !subscription.wechat ? 'unavailable':'reserved',
      reason:destination==='wechat' && !subscription.wechat ? 'unbound':null,receipt:null }));
    return event;
  }); }
  resultDelivery(eventId,destination) { return read(this.db,'SELECT record FROM card_result_deliveries WHERE event_id=? AND destination=?',eventId,destination); }
  recordResultPresentation(eventId) { return this.transaction(()=>{
    const record=this.resultDelivery(eventId,'desktop');
    if (!record) return false;
    record.rendererPresentedAt=new Date().toISOString();
    this.db.prepare('UPDATE card_result_deliveries SET record=? WHERE event_id=? AND destination=?').run(JSON.stringify(record),eventId,'desktop');
    return true;
  }); }
  claimResultDelivery(eventId,destination) { return this.transaction(() => {
    const record = this.resultDelivery(eventId,destination);
    if (record?.state !== 'reserved') return null;
    record.state = 'attempted'; record.attemptId = randomUUID();
    this.db.prepare('UPDATE card_result_deliveries SET record=? WHERE event_id=? AND destination=?').run(JSON.stringify(record),eventId,destination);
    return record;
  }); }
  finishResultDelivery(eventId,destination,attemptId,receipt) { return this.transaction(() => {
    const record = this.resultDelivery(eventId,destination);
    if (!record || record.attemptId !== attemptId) return false;
    record.state = receipt.state; record.receipt = receipt;
    this.db.prepare('UPDATE card_result_deliveries SET record=? WHERE event_id=? AND destination=?').run(JSON.stringify(record),eventId,destination);
    return true;
  }); }
}
