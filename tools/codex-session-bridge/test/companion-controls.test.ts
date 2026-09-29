import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EngineeringCardStore} from '../../companion-desktop/backend/engineering-card-store.mjs';
import {CompanionWorkControlService} from '../src/orchestration/companion-controls.mjs';

test('persisted Desktop stop targets only the bound run and never repeats a lost control receipt', async t => {
  const dir=mkdtempSync(join(tmpdir(),'companion-control-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new EngineeringCardStore(dir),repo='Emilia-tan-Ovo/yuki-link';
  const created=store.create({original:'实现 #133',projectKey:'yuki-link',repository:repo,
    ticket:{id:133,number:133,url:`https://github.com/${repo}/issues/133`,scope:{digest:'a'.repeat(64)}},
    resolution:{status:'verified_existing'},desiredPhase:'implementation',endpoint:'to-pr',
    extraAuthorization:{merge:false,deploy:false}});
  const card=store.confirm(created.cardId,1,'desktop-user-action').card;
  assert.equal(store.claim(card.cardId,1,card.dispatchId,{ticket_id:'ticket',request_id:'original'}).conflict,undefined);
  let status='running',stops=0;
  const manager={harness:{
    executionOperations:{findByRequest:(_ticket,request)=>request==='original'?{operation_id:'operation'}:null,
      reconcile:()=>({effective_state:'started',runtime:{session_id:'session',run_id:'original-run'}})},
    source:{runs:()=>[{id:'original-run',status},{id:'unrelated-run',status:'running'}]},
    bindings:new Map([['binding',{id:'binding',ticket_id:'ticket',session_id:'session',scope:'session'}]]),
    workflowHistory:{summary:()=>({acceptance:{accepted:false}})},
    controls:{stopRun:(_ticket,runId,bindingId)=>{assert.equal(runId,'original-run');
      assert.equal(bindingId,'binding');stops++;return {outcome:'requested'};}}}};
  const service=new CompanionWorkControlService({manager,directory:dir,store});
  const controlId='11111111-1111-4111-8111-111111111111';
  store.requestWorkStop(card.cardId,1,controlId);
  const input={schema_version:1,card_store_id:store.storeId,card_id:card.cardId,revision:1,control_id:controlId};
  const first=await service.requestStop(input);
  assert.equal(first.control.targets.length,1);
  assert.equal(stops,1);
  await service.requestStop(input);
  assert.equal(stops,1);
  status='completed';
  const ended=await service.get(input);
  assert.equal(ended.operations[0].run.status,'completed');
  assert.equal(stops,1);
  store.close();
});
