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
  const workItem={work_item_id:'item',delivery_item_id:'ticket',generation:1,
    generations:[{generation:1,session_id:'session',state:'usable'}]};
  const manager={harness:{
    executionOperations:{findByRequest:(_ticket,request)=>request==='original'?{operation_id:'operation'}:null,
      reconcile:()=>({effective_state:'started',runtime:{session_id:'session',run_id:'original-run'},
        work_item:workItem}),workItems:{get:()=>workItem}},
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
  assert.equal(ended.control.targets[0].request.state,'requested');
  assert.equal(stops,1);
  store.close();
});

test('in-flight preparation keeps stop unknown without a registered ticket',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-prep-stop-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new EngineeringCardStore(dir);
  const created=store.create({original:'新需求',summary:'新需求',projectKey:'yuki-link',
    repository:'Emilia-tan-Ovo/yuki-link',ticket:null,resolution:{status:'explicit_new_requirement'},
    desiredPhase:'ticket-design',endpoint:'design-only',
    preparationAuthorization:{schemaVersion:1,issue:true,worktree:true,
      forbidden:['implementation','pr','merge','deploy']},extraAuthorization:{merge:false,deploy:false}});
  const card=store.confirm(created.cardId,1,'desktop-user-action').card;
  const prep=store.beginPreparation(card.cardId,1,'yuki-preparation:11111111-1111-4111-8111-111111111111');
  store.updatePreparation(prep.preparationId,prep.version,value=>({...value,
    unknownSideEffects:['github-issue-create']}));
  const controlId='22222222-2222-4222-8222-222222222222';
  store.requestWorkStop(card.cardId,1,controlId);
  const service=new CompanionWorkControlService({manager:{harness:{}},directory:dir,store});
  const result=await service.get({schema_version:1,card_store_id:store.storeId,
    card_id:card.cardId,revision:1,control_id:controlId});
  assert.equal(result.ticket_id,null);
  assert.equal(result.control.state,'unknown');
  assert.equal(result.observation.state,'unknown');
  assert.deepEqual(result.card.preparation_unknown_side_effects,['github-issue-create']);
  store.close();
});

test('owned full-suite task is observed without an operation lookup',async()=>{
  const card={cardId:'card',revision:1,state:'confirmed',confirmation:{revision:1},dispatchStatus:'engineering-received'};
  const action={slot:'full-suite:implementation',intent:{request_id:'task-request'},
    receipt:{task_id:'task',service_epoch:'epoch'}};
  const store={continuation:()=>({ticket_id:'ticket'}),dispatch:()=>null,preparation:()=>null,
    continuationActions:()=>[action],workStop:()=>null};
  const manager={harness:{executionOperations:{findByRequest:()=>{throw Error('full suite has no operation');}},
    taskHistory:{target:()=>({binding:{request_id:'task-request',service_epoch:'epoch'}})},
    workflowHistory:{summary:()=>({})}}};
  const service=new CompanionWorkControlService({manager,directory:'unused',store:store as any,
    computer:{tasks:{status:()=>({status:'running'})}}});
  service.locator=()=>card as any;
  const result=await service.get({} as any);
  assert.equal(result.operations.length,0);
  assert.equal(result.tasks[0].manageable,true);
  assert.equal(result.observation.state,'current');
  action.receipt={task_id:'task'};
  service.computer.tasks.status=()=>({status:'completed',service_epoch:'epoch'});
  const completed=await service.get({} as any);
  assert.equal(completed.tasks[0].observation.state,'current');
});

test('run control requires matching managed work item generation',()=>{
  const receipt={operation_id:'operation',effective_state:'started',destination:{conversation_id:'conversation'},
    runtime:{session_id:'session',run_id:'run'},work_item:{work_item_id:'item',delivery_item_id:'ticket',
      generation:2,generations:[{generation:2,session_id:'other-session',state:'usable'}]}};
  const manager={harness:{executionOperations:{findByRequest:()=>({operation_id:'operation'}),
    reconcile:()=>receipt,workItems:{get:()=>({work_item_id:'item',delivery_item_id:'ticket',
      generation:2,generations:[{generation:2,session_id:'session',state:'usable'}]})}},
    source:{runs:()=>[{id:'run',status:'running'}]},
    bindings:new Map([['binding',{id:'binding',ticket_id:'ticket',session_id:'session',
      conversation_id:'conversation',scope:'session'}]])}};
  const service=new CompanionWorkControlService({manager,directory:'unused',store:{} as any});
  const result=service.operation('ticket','request');
  assert.equal(result.run.manageable,false);
  assert.equal(result.observation.state,'unknown');
});

test('control request exposes failed result and journal gap separately',()=>{
  const target={target:{kind:'run',ticket_id:'ticket',binding_id:'binding',session_id:'session',run_id:'run'}};
  const manager={harness:{journal:{records:[{data:{kind:'control_action',control:{control_id:'control',
    ticket_id:'ticket',action:'run.stop',stage:'result',outcome:'request_failed',
    occurred_at:'2026-09-29T00:00:01Z',
    target:{binding_id:'binding',session_id:'session',run_id:'run'}}}}]}}};
  const service=new CompanionWorkControlService({manager,directory:'unused',store:{} as any});
  const failed=service.targetStatus({...target,attempt:{state:'request_failed',receipt:{control_id:'control',
    outcome:'request_failed'}}});
  assert.equal(failed.request.state,'request_failed');
  const gap=service.targetStatus({...target,attempt:{state:'requested',receipt:{control_id:'control',
    outcome:'requested',evidence_gap:{state:'recording-failed'}}}});
  assert.equal(gap.request.state,'unknown');
  assert.equal(gap.request.detail,'CONTROL_JOURNAL_GAP');
  const lost=service.targetStatus({...target,attempt:{state:'unknown',
    started_at:'2026-09-29T00:00:00Z'}});
  assert.equal(lost.request.state,'request_failed');
});
