import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EngineeringCardStore} from '../../companion-desktop/backend/engineering-card-store.mjs';
import {CompanionContinuationService} from '../src/orchestration/companion-continuation.mjs';

test('registered confirmation stops at design-only and exposes implementation only for to-pr',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-continuation-'));
  const cards=new EngineeringCardStore(dir);
  const repo='Emilia-tan-Ovo/yuki-link';
  const ticketRef=`https://github.com/${repo}/issues/132`;
  const ticket={id:'ticket-132',reference:ticketRef,expected_worktree:dir};
  const workflow={workflow_revision:2,snapshot:{phase:'ticket-design',subject:{
    subject_id:'design-subject',head:'a'.repeat(40),staged:[],unstaged:[],untracked:[]}}};
  const harness:any={tickets:{get:()=>ticket},workflowHistory:{current:{get:()=>workflow},
    summary:()=>({assessment:{state:'verified'},acceptance:{accepted:false}})}};
  const manager:any={harness};
  const service=new CompanionContinuationService({manager,directory:dir,issueSource:{} as any});
  t.after(()=>{service.close();cards.close();rmSync(dir,{recursive:true,force:true});});
  service.initialOperation=(()=>({state:'completed',run:{status:'completed'}})) as any;
  service.designEvidence=(async()=>({state:'completed',notes:{path:'docs/implementation-notes/COMPANION-007.md',
    sha256:'b'.repeat(64)}})) as any;
  for (const endpoint of ['design-only','to-pr'] as const) {
    const card=cards.create({original:'完成票据',summary:'完成票据',projectKey:'yuki-link',
      repository:repo,ticket:{id:132,repository:repo,number:132,title:'COMPANION-007',
        marker:'COMPANION-007',url:ticketRef,scope:{digest:'c'.repeat(64)}},
      resolution:{status:'verified_existing'},desiredPhase:'ticket-design',endpoint,
      extraAuthorization:{merge:false,deploy:false}});
    cards.confirm(card.cardId,1,'desktop-user-action');
    const envelope=cards.envelope(card.cardId,1);
    cards.claim(card.cardId,1,envelope.dispatch_id,{ticket_id:ticket.id});
    assert.equal(cards.registerContinuation(card.cardId,1,'dispatch',envelope.dispatch_id,ticket.id).conflict,undefined);
    const locator={schema_version:1,card_store_id:cards.storeId,card_id:card.cardId,revision:1};
    const receipt=await service.get(locator);
    assert.equal(receipt.next_action.action,endpoint==='design-only' ? 'endpoint-reached':'implementation');
    assert.equal(receipt.acceptance.accepted,false);
    if (endpoint==='design-only') assert.equal((await service.advance(locator)).next_action.action,'endpoint-reached');
  }
});

test('Acceptance requires every Issue criterion and does not record an incomplete pass',async()=>{
  const service=Object.create(CompanionContinuationService.prototype) as any;
  const ticket={id:'ticket-132',expected_worktree:'unused'};
  const card={cardId:'card-1',revision:1,content:{repository:'Emilia-tan-Ovo/yuki-link',
    ticket:{number:132,id:132}}};
  const context={card,ticket,link:{binding_kind:'dispatch'},binding:null};
  const snapshot={phase:'acceptance',subject:{head:'b'.repeat(40),subject_id:'subject-1'},
    reviews:[{mode:'full',status:'passed',applicability:'verified',review_id:'review-1'}],
    findings:[],artifacts:[]};
  service.manager={harness:{workflowHistory:{current:{get:()=>({snapshot})},
    source:{assess:()=>({state:'verified',artifacts:[]})}}}};
  service.issueSource={details:async()=>({id:132,body:'## Acceptance Criteria\n- [ ] First\n\n- [ ] Second\n\n## Notes\nOther'})};
  service.store={continuationActions:()=>[]};
  service.mechanical={suiteReceipt:()=>({state:'passed',head:'a'.repeat(40),task_id:'task-1'}),
    reconcileCommit:()=>({state:'committed',parent:'a'.repeat(40),oid:'b'.repeat(40)})};
  service.actionEvidence=()=>({state:'completed',operation_id:'operation-1',run_id:'run-1'});
  let recorded=0;
  service.movePhase=()=>{recorded++;};
  service.evidence={readResult:()=>({state:'completed',sha256:'c'.repeat(64),value:{acceptance_plan:[
    {criteria_ref:'AC1',source_kind:'repository-test'},
    {criteria_ref:'AC2',source_kind:'external-observation'}]}})};
  const locator={card_id:'card-1',revision:1};
  const observed=await service.collectAcceptance(locator,context,{schema_version:1});
  assert.equal(observed.next_action.reason,'COMPANION_ACCEPTANCE_EVIDENCE_PENDING');
  assert.deepEqual(observed.acceptance_evidence.criteria.map((item:any)=>item.status),['pass','not-verified']);
  assert.equal(recorded,0);
  service.evidence.readResult=()=>({state:'completed',sha256:'c'.repeat(64),value:{acceptance_plan:[
    {criteria_ref:'AC1',source_kind:'repository-test'}]}});
  const missing=await service.collectAcceptance(locator,context,{schema_version:1});
  assert.equal(missing.next_action.reason,'COMPANION_ACCEPTANCE_PLAN_SCOPE_CONFLICT');
  assert.equal(recorded,0);
});

test('recorded design handoff survives a later Notes handoff update',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-design-handoff-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const notes=join(dir,'docs','implementation-notes','COMPANION-007.md');
  mkdirSync(join(dir,'docs','implementation-notes'),{recursive:true});
  writeFileSync(notes,'PRODUCT_DECISION_REQUIRED: none\n\n### Context Plan\n\n## Implementation Handoff\nUpdated\n','utf8');
  const service=Object.create(CompanionContinuationService.prototype) as any;
  const predecessor={run_id:'design-run',result_sha256:'d'.repeat(64),
    notes:{path:'docs/implementation-notes/COMPANION-007.md',sha256:'a'.repeat(64)}};
  service.manager={harness:{workflowHistory:{current:{get:()=>({workflow_revision:4,
    snapshot:{phase:'review'}})},requests:{get:()=>({workflow_revision:3})}}}};
  service.store={continuationAction:()=>({attempt_state:'verified',
    intent:{request_id:'boundary-1',predecessor}})};
  service.evidence={operation:()=>({state:'completed',sha256:'d'.repeat(64),
    value:{product_decision_required:false,product_decisions:[]}})};
  const context={link:{binding_kind:'preparation'},binding:{preparationId:'prep-1'},
    ticket:{id:'ticket-1',key:'COMPANION-007',expected_worktree:dir},
    card:{cardId:'card-1',revision:1}};
  const result=await service.designEvidence({},context,{state:'completed',run:{id:'design-run'}});
  assert.equal(result.state,'completed');
  assert.deepEqual(result.design_notes,predecessor.notes);
});

test('lost boundary receipt adopts the original Workflow request without recording it again',()=>{
  const service=Object.create(CompanionContinuationService.prototype) as any;
  const updates:any[]=[];
  service.store={continuationActions:()=>[{slot:'boundary:implementation-to-review',
    attempt_state:'attempted',intent:{request_id:'fixed-boundary-request'}}],
    updateContinuationAction:(...args:any[])=>{updates.push(args);return {conflict:false};}};
  service.manager={harness:{workflowHistory:{requests:{get:(key:string)=>
    key==='ticket-1:fixed-boundary-request' ? {workflow_revision:7}:null}},
    recordWorkflow:()=>{throw Error('existing request must not be recorded twice');}}};
  service.reconcileBoundaries({card:{cardId:'card-1',revision:1},ticket:{id:'ticket-1'}});
  assert.deepEqual(updates,[['card-1',1,'boundary:implementation-to-review',
    'attempted','verified',{workflow_revision:7}]]);
});
