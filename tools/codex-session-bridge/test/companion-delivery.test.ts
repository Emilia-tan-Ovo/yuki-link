import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineeringCardStore } from '../../companion-desktop/backend/engineering-card-store.mjs';
import { CompanionDeliveryAdapter } from '../src/orchestration/companion-delivery.mjs';

const repo='Emilia-tan-Ovo/yuki-link';
function fixture(t: any) {
  const dir=mkdtempSync(join(tmpdir(),'companion-delivery-'));
  const store=new EngineeringCardStore(dir);
  const open=[store];
  t.after(()=>{for (const item of open) item.close(); rmSync(dir,{recursive:true,force:true});});
  const card=store.create({original:'请做到 PR',summary:'做 PR',projectKey:'yuki-link',repository:repo,
    ticket:{id:132,repository:repo,number:132,title:'COMPANION-007',marker:'COMPANION-007',
      url:`https://github.com/${repo}/issues/132`,scope:{digest:'a'.repeat(64)}},
    resolution:{status:'verified_existing'},desiredPhase:'implementation',endpoint:'to-pr',
    extraAuthorization:{merge:false,deploy:false}});
  store.confirm(card.cardId,1,'desktop-user-action');
  const envelope=store.envelope(card.cardId,1);
  store.claim(card.cardId,1,envelope.dispatch_id,{ticket_id:'ticket-132'});
  assert.equal(store.registerContinuation(card.cardId,1,'dispatch',envelope.dispatch_id,'ticket-132').conflict,undefined);
  const locator={card_id:card.cardId,revision:1};
  const payload={repository:repo,head_repo:repo,base_repo:repo,head_ref:'refs/heads/codex/ticket-132',
    base_ref:'refs/heads/main',head_oid:'a'.repeat(40),base_oid:'b'.repeat(40),
    ticket_ref:`https://github.com/${repo}/issues/132`,subject_identity:'c'.repeat(64),
    acceptance_ref:'workflow:accepted:3',title:'COMPANION-007',body:`Fixes https://github.com/${repo}/issues/132`};
  return {store,locator,payload,dir,open};
}
function transport() {
  const state:any={items:[],creates:0,mode:'normal'};
  const result:any={state,actor:async()=> 'owner',ref:async(_repo:string,ref:string)=>
    ref.endsWith('/main') ? 'b'.repeat(40) : 'a'.repeat(40),
    list:async()=> state.mode==='incomplete' ? Promise.reject(Error('incomplete')) : state.items,
    read:async(_repo:string,number:number)=>state.items.find((item:any)=>item.number===number),
    create:async(_repo:string,input:any)=>{
      state.creates++;
      const item={id:42,number:8,html_url:`https://github.com/${repo}/pull/8`,state:'open',
        title:input.title,body:input.body,draft:true,user:{login:'owner'},
        head:{repo:{full_name:repo},ref:'codex/ticket-132',sha:'a'.repeat(40)},
        base:{repo:{full_name:repo},ref:'main',sha:'b'.repeat(40)}};
      state.items.push(item);
      if (state.mode==='response-lost') throw Error('response lost');
      return item;
    }};
  return result;
}
test('unknown PR create adopts exactly one immutable matching object and never creates twice',async t=>{
  const {store,locator,payload,dir,open}=fixture(t);
  const external=transport(); external.state.mode='response-lost';
  const adapter=new CompanionDeliveryAdapter({store,transport:external,observeAuthority:async()=>{}});
  assert.equal((await adapter.deliver(locator,payload)).state,'delivered');
  assert.equal(external.state.creates,1);
  const reopened=new EngineeringCardStore(dir);
  open.push(reopened);
  const next=new CompanionDeliveryAdapter({store:reopened,transport:external,observeAuthority:async()=>{}});
  assert.equal((await next.deliver(locator,payload)).number,8);
  assert.equal(external.state.creates,1);
  await assert.rejects(next.deliver(locator,{...payload,title:'changed'}),{code:'COMPANION_PR_INTENT_CONFLICT'});
});
test('zero, multiple and incomplete candidate queries stay unknown after attempted create',async t=>{
  for (const mode of ['zero','multiple','incomplete']) {
    const {store,locator,payload}=fixture(t),external=transport();
    const marker=`<!-- yuki-companion-delivery:${locator.card_id}:${locator.revision} -->`;
    const intent={...payload,body:`${payload.body}\n\n${marker}`,marker,
      body_digest:'ignored',actor:'owner'};
    store.claimContinuationAction(locator.card_id,locator.revision,'pr-delivery',intent);
    store.updateContinuationAction(locator.card_id,locator.revision,'pr-delivery','reserved','attempted');
    if (mode==='multiple') {
      external.state.mode='normal';
      await external.create(repo,intent); await external.create(repo,intent);
    } else external.state.mode=mode==='incomplete' ? 'incomplete':'normal';
    const adapter=new CompanionDeliveryAdapter({store,transport:external,observeAuthority:async()=>{}});
    assert.equal((await adapter.reconcile(locator)).state,'unknown',mode);
    assert.equal(store.continuationAction(locator.card_id,locator.revision,'pr-delivery').attempt_state,'attempted');
  }
});

test('read-only PR reconciliation observes a matching remote object without recording a receipt',async t=>{
  const {store,locator,payload}=fixture(t),external=transport();
  const marker=`<!-- yuki-companion-delivery:${locator.card_id}:${locator.revision} -->`;
  const intent={...payload,body:`${payload.body}\n\n${marker}`,marker,
    body_digest:'ignored',actor:'owner'};
  store.claimContinuationAction(locator.card_id,locator.revision,'pr-delivery',intent);
  store.updateContinuationAction(locator.card_id,locator.revision,'pr-delivery','reserved','attempted');
  await external.create(repo,intent);
  const adapter=new CompanionDeliveryAdapter({store,transport:external,observeAuthority:async()=>{}});
  assert.deepEqual(await adapter.reconcile(locator,{persist:false}),{
    state:'unknown',reason:'COMPANION_PR_RECEIPT_NOT_RECORDED',
    reference:`https://github.com/${repo}/pull/8`,id:42,number:8});
  assert.equal(store.continuationAction(locator.card_id,locator.revision,'pr-delivery').attempt_state,'attempted');
  assert.equal((await adapter.reconcile(locator)).state,'delivered');
  assert.equal(store.continuationAction(locator.card_id,locator.revision,'pr-delivery').attempt_state,'verified');
  assert.equal(external.state.creates,1);
});
