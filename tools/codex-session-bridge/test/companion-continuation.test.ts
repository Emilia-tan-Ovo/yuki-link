import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {EngineeringCardStore} from '../../companion-desktop/backend/engineering-card-store.mjs';
import {CompanionContinuationService} from '../src/orchestration/companion-continuation.mjs';
import {CompanionEvidenceAdapter,companionResultIdentity} from '../src/orchestration/companion-evidence.mjs';
import {CompanionMechanicalAdapter} from '../src/orchestration/companion-mechanical.mjs';
import {WorkflowSource} from '../src/harness/workflow-source.ts';

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const issueCriteria=[
  '确认目标与终点后常规阶段连续推进；只设计样例不实现，授权到 PR 样例交付真实 PR，不擅自合并/部署。',
  '沿用 006 的准备及授权交接，不退回 ChatGPT 人工预制工程状态；每一步根据既有事实选择对应能力，不另存一套竞争工程 phase。',
  'fresh 实现/Review 及必要修复遵守既有协作规则，原 Harness Main/Review 分离、运行归属、diff 与结果继续可查。',
  '产品/范围实质变化或无法确认的状态才说明具体阻碍；常规准备和核对不制造新的逐阶段 Owner 批准点。',
  '一条受控代表性任务从确认到终点可复核，正确区分 run 完成、验收完成和 PR 交付。修复路径用必要确定性样例覆盖，不为凑流程特意制造一次真实 finding。',
];

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

test('Acceptance rejects a complete plan that downgrades #132 external and session obligations',async()=>{
  const service=Object.create(CompanionContinuationService.prototype) as any;
  const ticket={id:'ticket-132',expected_worktree:'unused',
    reference:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/132'};
  const card={cardId:'card-1',revision:1,content:{repository:'Emilia-tan-Ovo/yuki-link',
    ticket:{number:132,id:132}}};
  const context={card,ticket,link:{binding_kind:'dispatch'},binding:null};
  const snapshot={phase:'acceptance',subject:{head:'b'.repeat(40),subject_id:'subject-1'},
    reviews:[{mode:'full',status:'passed',applicability:'verified',review_id:'review-1'}],
    findings:[],artifacts:[],runtime_refs:[]};
  service.manager={harness:{workflowHistory:{current:{get:()=>({snapshot})},
    source:{assess:()=>({state:'verified',artifacts:[]})}}}};
  service.issueSource={details:async()=>({id:132,body:'## Acceptance criteria\n'
    +issueCriteria.map(value=>`- [ ] ${value}`).join('\n')+'\n\n## Notes\nOther'})};
  service.store={continuationActions:()=>[]};
  service.mechanical={suiteReceipt:()=>({state:'passed',head:'a'.repeat(40),task_id:'task-1'}),
    reconcileCommit:()=>({state:'committed',parent:'a'.repeat(40),oid:'b'.repeat(40)})};
  service.actionEvidence=()=>({state:'completed',operation_id:'operation-1',run_id:'run-1'});
  let recorded=0;
  service.movePhase=()=>{recorded++;};
  service.designResult=()=>({state:'completed',sha256:'c'.repeat(64),value:{acceptance_plan:
    ['external-observation','harness-run','agent-session','external-observation','external-observation']
      .map((source_kind,index)=>({criteria_ref:`AC${index+1}`,source_kind}))}});
  const locator={card_id:'card-1',revision:1};
  const observed=await service.collectAcceptance(locator,context,{schema_version:1});
  assert.equal(observed.next_action.reason,'COMPANION_ACCEPTANCE_EVIDENCE_PENDING');
  assert.deepEqual(observed.acceptance_evidence.criteria.map((item:any)=>item.status),
    ['not-verified','pass','not-verified','not-verified','not-verified']);
  assert.equal(recorded,0);
  service.designResult=()=>({state:'completed',sha256:'c'.repeat(64),value:{acceptance_plan:
    issueCriteria.map((_,index)=>({criteria_ref:`AC${index+1}`,source_kind:'repository-test'}))}});
  const downgraded=await service.collectAcceptance(locator,context,{schema_version:1});
  assert.equal(downgraded.next_action.reason,'COMPANION_ACCEPTANCE_PLAN_SCOPE_CONFLICT');
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
  service.designResult=()=>({state:'completed',sha256:'d'.repeat(64),
    value:{product_decision_required:false,product_decisions:[]}});
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

test('real WorkflowSource permits only the bound implementation delta through CAS handoff',t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-controlled-handoff-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const run=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  run('init','-b','main'); run('config','user.email','fixture@example.invalid');
  run('config','user.name','Fixture');
  mkdirSync(join(dir,'docs','implementation-notes'),{recursive:true});
  writeFileSync(join(dir,'.gitignore'),'.local/\n','utf8');
  writeFileSync(join(dir,'feature.txt'),'before\n','utf8');
  const notes=join(dir,'docs','implementation-notes','COMPANION-007.md');
  writeFileSync(notes,'before\n','utf8');
  run('add','--','.gitignore','feature.txt','docs/implementation-notes/COMPANION-007.md');
  run('commit','-m','baseline');
  const head=run('rev-parse','HEAD');
  const checkpoint=join(dir,'.local','workflow-state','COMPANION-007.md');
  mkdirSync(join(dir,'.local','workflow-state'),{recursive:true});
  writeFileSync(checkpoint,`---\nschema_version: 1\nticket: "COMPANION-007 / https://github.com/Emilia-tan-Ovo/yuki-link/issues/132"\nphase: implementation\nworktree: "${dir.replaceAll('\\','/')}"\nbranch: main\nfixed_point: "${head}"\nhead: "${head}"\n---\n`,'utf8');
  const ticket:any={id:'ticket-132',key:'COMPANION-007',expected_worktree:dir,
    reference:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/132'};
  const source=new WorkflowSource({runs:()=>[]} as any);
  const subjectIdentity=digest(JSON.stringify({head,staged:[],unstaged:[],untracked:[]}));
  const snapshot:any={phase:'implementation',checkpoint:{artifact_id:'checkpoint',ticket_key:'COMPANION-007',
    worktree:dir,branch:'main',fixed_point:head,head,phase:'implementation',schema_version:1},
    subject:{subject_id:'subject-before',fixed_point:head,head,scope:[],staged:[],unstaged:[],
      untracked:[],ticket_ref:ticket.reference,spec_ref:ticket.reference,standards:[],tests:[]},
    artifacts:[{artifact_id:'checkpoint',role:'checkpoint',kind:'file',location:checkpoint,
      revision:digest(readFileSync(checkpoint)),source:'fixture'},
      {artifact_id:'notes',role:'implementation-notes',kind:'file',location:notes,
        revision:digest(readFileSync(notes)),source:'fixture'}],reviews:[],findings:[],runtime_refs:[]};
  let current:any={workflow_revision:1,snapshot};
  const action:any={slot:'implementation',attempt_state:'attempted',intent:{workflow_revision:1,
    result_identity:{subject_ref:'subject-before',subject_identity:subjectIdentity}}};
  const store:any={continuationActions:()=>[action],continuationAction:(_id:string,_rev:number,slot:string)=>
    slot==='commit:implementation' ? commitAction:null,
    claimContinuationAction:(_id:string,_rev:number,_slot:string,intent:any)=>
      ({action:{intent,attempt_state:'reserved'}}),updateContinuationAction:()=>({conflict:false})};
  let commitAction:any=null;
  const mechanical=new CompanionMechanicalAdapter({store,computer:null}) as any;
  mechanical.reconcileCommit=()=>commitAction ? {state:'committed',parent:head,oid:run('rev-parse','HEAD')}
    : {state:'not-started'};
  const harness:any={workflowHistory:{current:{get:()=>current},requests:{get:()=>null},source},
    recordWorkflow:({expected_revision,snapshot:next}:any)=>{
      assert.equal(expected_revision,current.workflow_revision);
      const assessed=source.assess(ticket,next);
      assert.equal(assessed.state,'verified',JSON.stringify(assessed.reasons));
      current={workflow_revision:2,snapshot:next};
      return {workflow_revision:2,applicability:{state:'verified'}};
    }};
  const service=Object.create(CompanionContinuationService.prototype) as any;
  service.manager={harness}; service.store=store; service.mechanical=mechanical;
  service.actionEvidence=()=>({state:'completed',sha256:'d'.repeat(64),value:{files:['feature.txt']}});
  const context:any={ticket,card:{cardId:'card-1',revision:1}};
  assert.equal(source.assess(ticket,snapshot).state,'verified');
  writeFileSync(join(dir,'feature.txt'),'after\n','utf8');
  writeFileSync(notes,'after\n','utf8');
  assert.equal(source.assess(ticket,snapshot).state,'stale');
  const before=service.controlledImplementation(context,[action],current);
  assert.ok(before,JSON.stringify({assessment:source.assess(ticket,snapshot),
    changed:mechanical.changed(dir),subjectIdentity}));
  assert.deepEqual(before?.expected,['docs/implementation-notes/COMPANION-007.md','feature.txt']);
  run('add','--','feature.txt','docs/implementation-notes/COMPANION-007.md');
  run('commit','-m','bound change');
  commitAction={intent:{files:before.expected}};
  const after=service.controlledImplementation(context,[action],current);
  assert.equal(after?.committed,true);
  service.movePhase(context,'review','implementation-to-review',{run_id:'run-1'},null,after);
  assert.equal(current.workflow_revision,2);
  assert.equal(source.assess(ticket,current.snapshot).state,'verified');
});

test('result identity isolates confirmations and rejects an old run or subject',t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-result-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=companionResultIdentity(dir,'card-1',1,'primary-review','request-1',2,
    'subject-1','a'.repeat(64));
  const second=companionResultIdentity(dir,'card-2',1,'primary-review','request-2',2,
    'subject-1','a'.repeat(64));
  assert.notEqual(first.result_path,second.result_path);
  mkdirSync(dirname(first.result_path),{recursive:true});
  const report=join(dirname(first.result_path),'review.md');
  writeFileSync(report,'review\n','utf8');
  const result:any={schema_version:1,action:'review',status:'completed',
    report_ref:relative(dir,report).replaceAll('\\','/'),blockers:[],
    axes:{standards:'passed',spec:'passed'},findings:[],
    request_id:first.request_id,operation_id:'operation-1',run_id:'run-1',
    subject_ref:first.subject_ref,subject_identity:first.subject_identity};
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  const operation:any={operation_id:'operation-1',request_id:'request-1',
    protected_intent:{subject_ref:'subject-1',expected_workflow_revision:2,
      review:{}},destination:{kind:'child',relation:{kind:'review'}}};
  const manager:any={harness:{executionOperations:{findByRequest:()=>operation,
    reconcile:()=>({effective_state:'completed',runtime:{session_id:'session-1',run_id:'run-1'}})},
    source:{runs:()=>[{id:'run-1',status:'completed'}]}}};
  const evidence=new CompanionEvidenceAdapter({manager});
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).state,'completed');
  assert.equal(evidence.readResult(dir,'primary-review','review',second).state,'unknown');
  result.run_id='old-run'; writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).reason,
    'COMPANION_RESULT_IDENTITY_CONFLICT');
  result.run_id='run-1'; result.operation_id='old-operation';
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).reason,
    'COMPANION_RESULT_IDENTITY_CONFLICT');
  result.operation_id='operation-1';
  result.run_id='run-1'; result.subject_ref='old-subject';
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).reason,
    'COMPANION_RESULT_IDENTITY_CONFLICT');
});
