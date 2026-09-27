import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineeringCardStore } from '../backend/engineering-card-store.mjs';
import { EngineeringCards } from '../backend/engineering-cards.mjs';

const repo = 'Emilia-tan-Ovo/yuki-link';
const content = () => ({ original: '实现 #130 到 PR', projectKey: 'yuki-link', repository: repo,
  ticket: { id: 1300, repository: repo, number: 130, marker: 'COMPANION-005', title: 'COMPANION-005',
    url: `https://github.com/${repo}/issues/130`, scope: { digest: 'a'.repeat(64), observedAt: new Date().toISOString() } },
  resolution: { status: 'verified_existing' }, desiredPhase: 'implementation', endpoint: 'to-pr',
  extraAuthorization: { merge: false, deploy: false } });
const fixture = t => { const dir = mkdtempSync(join(tmpdir(),'yuki-card-dispatch-')); t.after(() => rmSync(dir,{recursive:true,force:true})); return dir; };

test('one confirmed revision owns one immutable envelope and a single CAS claim', t => {
  const store = new EngineeringCardStore(fixture(t)), card = store.create(content());
  const confirmed = store.confirm(card.cardId,1,'desktop-user-action');
  const envelope = store.envelope(card.cardId,1);
  assert.equal(envelope.card_store_id,store.storeId);
  assert.equal(confirmed.card.dispatchId,envelope.dispatch_id);
  assert.equal(store.confirm(card.cardId,1,'desktop-user-action').card.dispatchId,envelope.dispatch_id);
  const accepted = { request_id:'companion:stable', ticket_id:'ticket-1', launcher_input:{ action:'implementation' } };
  assert.equal(store.claim(card.cardId,1,envelope.dispatch_id,accepted).deduplicated,false);
  assert.equal(store.claim(card.cardId,1,envelope.dispatch_id,accepted).deduplicated,true);
  assert.equal(store.claim(card.cardId,1,envelope.dispatch_id,{...accepted,request_id:'changed'}).conflict,true);
  assert.equal(store.edit(card.cardId,1,content()).conflict,true);
  assert.equal(store.revoke(card.cardId,1).conflict,true);
  assert.equal(store.get(card.cardId).dispatchStatus,'engineering-received');
  store.close();
});

test('revoke or edit before receive rejects stale dispatch; v1 confirmed cards stay untrusted after migration', t => {
  const store = new EngineeringCardStore(fixture(t));
  const first = store.create(content()); store.confirm(first.cardId,1,'desktop-user-action');
  const envelope = store.envelope(first.cardId,1);
  assert.equal(store.revoke(first.cardId,1).card.state,'revoked');
  assert.equal(store.producerAttempt(first.cardId,1,envelope.dispatch_id).conflict,true);
  assert.equal(store.claim(first.cardId,1,envelope.dispatch_id,{request_id:'old'}).conflict,true);
  const second = store.create(content()); store.confirm(second.cardId,1,'desktop-user-action');
  const stale = store.envelope(second.cardId,1);
  assert.equal(store.edit(second.cardId,1,content()).revision,2);
  assert.equal(store.claim(second.cardId,1,stale.dispatch_id,{request_id:'old'}).conflict,true);
  const legacy = store.create({...content(),ticket:{repository:repo,number:130,url:`https://github.com/${repo}/issues/130`}});
  store.confirm(legacy.cardId,1,'desktop-user-action');
  assert.equal(store.envelope(legacy.cardId,1),null);
  store.close();
});

test('producer attempt is durable and does not start two DSH turns', t => {
  const dir = fixture(t); let store = new EngineeringCardStore(dir);
  const card = store.create(content()); store.confirm(card.cardId,1,'desktop-user-action');
  const envelope = store.envelope(card.cardId,1);
  assert.equal(store.producerAttempt(card.cardId,1,envelope.dispatch_id).deduplicated,false);
  store.producerOutcome(card.cardId,1,envelope.dispatch_id,'turn-completed',{exit_code:0,session_id:null,turn_id:null});
  store.close(); store = new EngineeringCardStore(dir);
  assert.equal(store.producerAttempt(card.cardId,1,envelope.dispatch_id).deduplicated,true);
  assert.equal(store.get(card.cardId).dispatchStatus,'turn-completed');
  assert.equal(JSON.parse(store.dispatch(card.cardId,1).producer_receipt).exit_code,0);
  store.close();
});

test('confirmation rechecks canonical Issue scope and CAS rejects a revision changed during await', async t => {
  const store = new EngineeringCardStore(fixture(t));
  const first = store.create(content());
  let release;
  const source = {lookup:async()=>new Promise(resolve=>{release=resolve;})};
  const cards = new EngineeringCards({store,issueSource:source});
  const pending = cards.confirm(first.cardId,1,'desktop-user-action');
  store.edit(first.cardId,1,content());
  release(content().ticket);
  assert.equal((await pending).conflict,true);
  assert.equal(store.envelope(first.cardId,1),null);
  const next = cards.confirm(first.cardId,2,'desktop-user-action');
  release(content().ticket);
  assert.equal((await next).card.dispatchStatus,'not-dispatched');
  assert.ok(store.envelope(first.cardId,2));
  store.close();
});
