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
const writePlan=(dir:string,key:string,ref:string,texts:string[],kinds:string[])=>{
  const criteria=texts.map((text,index)=>({criteria_ref:`AC${index+1}`,text}));
  const plan={schema_version:1,issue_ref:ref,criteria_sha256:digest(JSON.stringify(criteria)),
    criteria:criteria.map((item,index)=>({...item,source_kind:kinds[index]}))};
  const filename=join(dir,'docs','implementation-notes',`${key}.md`);
  mkdirSync(dirname(filename),{recursive:true});
  writeFileSync(filename,`## Acceptance Evidence Plan\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\n`, 'utf8');
  return filename;
};

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
  const dir=mkdtempSync(join(tmpdir(),'companion-acceptance-'));
  try {
  const service=Object.create(CompanionContinuationService.prototype) as any;
  const ticket={id:'ticket-132',key:'COMPANION-007',expected_worktree:dir,
    reference:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/132'};
  writePlan(dir,ticket.key,ticket.reference,issueCriteria,
    ['external-observation','harness-run','agent-session','external-observation','external-observation']);
  service.notesAtSubject=()=>readFileSync(join(dir,'docs','implementation-notes',`${ticket.key}.md`),'utf8');
  const card={cardId:'card-1',revision:1,content:{repository:'Emilia-tan-Ovo/yuki-link',
    ticket:{number:132,id:132}}};
  const context={card,ticket,link:{binding_kind:'dispatch'},binding:null};
  const snapshot={phase:'acceptance',subject:{head:'b'.repeat(40),subject_id:'subject-1'},
    reviews:[{mode:'full',status:'passed',applicability:'verified',review_id:'review-1'}],
    findings:[],artifacts:[],runtime_refs:[]};
  service.manager={harness:{workflowHistory:{current:{get:()=>({snapshot})},
    source:{assess:()=>({state:'verified',artifacts:[]})}}}};
  service.issueSource={details:async()=>({id:132,url:ticket.reference,body:'## Acceptance criteria\n'
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
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('a new Issue uses its own Notes obligations and blocks checklist or Notes drift',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-new-issue-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const ref='https://github.com/Emilia-tan-Ovo/yuki-link/issues/901';
  const texts=['Repository tests pass','Reviewed change is current','Commit matches the reviewed subject'];
  const kinds=['repository-test','review','git-subject'];
  const notes=writePlan(dir,'SAMPLE-901',ref,texts,kinds);
  const committedNotes=readFileSync(notes,'utf8');
  const ticket={id:'ticket-901',key:'SAMPLE-901',reference:ref,expected_worktree:dir};
  const card={cardId:'card-901',revision:1,content:{repository:'Emilia-tan-Ovo/yuki-link',
    ticket:{id:901,number:901}}};
  const context={card,ticket,link:{binding_kind:'dispatch'},binding:null};
  let issueTexts=[...texts];
  const service=Object.create(CompanionContinuationService.prototype) as any;
  service.issueSource={details:async()=>({id:901,url:ref,body:'## Acceptance criteria\n'
    +issueTexts.map(value=>`- [ ] ${value}`).join('\n')+'\n'})};
  service.notesAtSubject=()=>committedNotes;
  service.manager={harness:{workflowHistory:{current:{get:()=>({snapshot:{phase:'acceptance',
    subject:{head:'b'.repeat(40),subject_id:'subject-901'},reviews:[{mode:'full',status:'passed',
      applicability:'verified',review_id:'review-901'}],findings:[],artifacts:[],runtime_refs:[]}})},
    source:{assess:()=>({state:'verified',artifacts:[]})}}}};
  service.store={continuationActions:()=>[]};
  service.mechanical={suiteReceipt:()=>({state:'pending',head:'a'.repeat(40),task_id:'task-901'}),
    reconcileCommit:()=>({state:'committed',parent:'a'.repeat(40),oid:'b'.repeat(40)})};
  service.actionEvidence=()=>({state:'completed',run_id:'run-901'});
  service.designResult=()=>({state:'completed',sha256:'c'.repeat(64),value:{acceptance_plan:
    kinds.map((source_kind,index)=>({criteria_ref:`AC${index+1}`,source_kind}))}});
  service.movePhase=()=>{throw Error('fixture must stop before recording Acceptance');};
  const locator={card_id:'card-901',revision:1};
  const receipt={schema_version:1};
  const collected=await service.collectAcceptance(locator,context,receipt);
  assert.equal(collected.next_action.reason,'COMPANION_ACCEPTANCE_EVIDENCE_PENDING');
  assert.deepEqual(collected.acceptance_evidence.criteria.map((item:any)=>item.criteria_ref),
    ['AC1','AC2','AC3']);
  const authority=await service.acceptanceAuthority(context,committedNotes);
  service.store.continuationAction=()=>({attempt_state:'verified',intent:{predecessor:{
    obligation_version:1,obligation_sha256:service.obligationDigest(ticket,authority)}}});
  assert.equal(await service.acceptanceBindingCurrent(context,'b'.repeat(40)),true);
  writeFileSync(notes,committedNotes+'\n## Implementation Handoff\nchanged\n','utf8');
  assert.equal(await service.acceptanceBindingCurrent(context,'b'.repeat(40)),false);
  assert.equal((await service.collectAcceptance(locator,context,receipt)).next_action.reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  writeFileSync(notes,committedNotes,'utf8');
  issueTexts=[texts[1],texts[0],texts[2]];
  assert.equal((await service.collectAcceptance(locator,context,receipt)).next_action.reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  issueTexts=[...texts]; issueTexts[0]+=' changed';
  assert.equal((await service.collectAcceptance(locator,context,receipt)).next_action.reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  issueTexts=[...texts]; issueTexts[0]+=' ';
  assert.equal((await service.collectAcceptance(locator,context,receipt)).next_action.reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  issueTexts=[...texts];
  writeFileSync(notes,'## Test Plan\nmissing plan\n','utf8');
  assert.equal((await service.designEvidence({},context,{state:'completed'})).reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  writeFileSync(notes,'## Acceptance Evidence Plan\n```json\n{broken}\n```\n','utf8');
  assert.equal((await service.designEvidence({},context,{state:'completed'})).reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  writePlan(dir,'SAMPLE-901',ref,[texts[0],texts[2],texts[1]],kinds);
  assert.equal((await service.designEvidence({},context,{state:'completed'})).reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  writePlan(dir,'SAMPLE-901',ref,texts,kinds);
  writeFileSync(notes,committedNotes+'\n## Acceptance Evidence Plan\nmissing fence\n','utf8');
  assert.equal((await service.designEvidence({},context,{state:'completed'})).reason,
    'COMPANION_ACCEPTANCE_AUTHORITY_CONFLICT');
  writeFileSync(notes,committedNotes,'utf8');
  service.designResult=()=>({state:'completed',sha256:'c'.repeat(64),value:{acceptance_plan:
    ['repository-test','repository-test','git-subject'].map((source_kind,index)=>
      ({criteria_ref:`AC${index+1}`,source_kind}))}});
  assert.equal((await service.collectAcceptance(locator,context,receipt)).next_action.reason,
    'COMPANION_ACCEPTANCE_PLAN_SCOPE_CONFLICT');
  service.designResult=()=>({state:'completed',sha256:'c'.repeat(64),value:{acceptance_plan:
    ['external-observation','review','git-subject'].map((source_kind,index)=>
      ({criteria_ref:`AC${index+1}`,source_kind}))}});
  assert.equal((await service.collectAcceptance(locator,context,receipt)).next_action.reason,
    'COMPANION_ACCEPTANCE_EVIDENCE_PENDING');
});

test('preparation-bound Acceptance reuses the authenticated preparation Issue source',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-preparation-issue-source-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const ref='https://github.com/Emilia-tan-Ovo/yuki-link/issues/901';
  const texts=['A','B','C'],kinds=['review','git-subject','review'];
  const notes=writePlan(dir,'ISSUE-901',ref,texts,kinds);
  const content=readFileSync(notes,'utf8');
  let authenticatedReads=0,publicReads=0;
  const issue={repository:'Emilia-tan-Ovo/yuki-link',id:901001,number:901,url:ref,title:'fixture',
    body:'## Acceptance criteria\n'+texts.map(value=>'- [ ] '+value).join('\n')};
  const service=Object.create(CompanionContinuationService.prototype) as any;
  service.preparation={issues:{details:async()=>{authenticatedReads++;return issue;}}};
  service.issueSource={details:async()=>{publicReads++;throw Error('public source unavailable');}};
  const context={link:{binding_kind:'preparation'},binding:{bindings:{issue}},
    card:{content:{repository:'Emilia-tan-Ovo/yuki-link'}},
    ticket:{reference:ref,key:'ISSUE-901',expected_worktree:dir}};
  const authority=await service.acceptanceAuthority(context,content);
  assert.equal(authority.state,'completed');
  assert.equal(authenticatedReads,1);
  assert.equal(publicReads,0);
});
test('checked restart distinguishes a provably absent implementation attempt',()=>{
  const action:any={slot:'implementation',attempt_state:'unknown',
    created_at:'2026-09-28T09:00:00.000Z',updated_at:'2026-09-28T09:00:01.000Z',
    intent:{action:'implementation',request_id:'request-implementation',
      policy:{model:'gpt-6-sol',reasoning:'high'}}};
  const updates:any[]=[];
  const service=Object.create(CompanionContinuationService.prototype) as any;
  service.startedAt='2026-09-28T09:00:02.000Z';
  service.store={continuationActions:()=>[action],
    updateContinuationAction:(...args:any[])=>{updates.push(args);return {conflict:false};}};
  service.manager={store:{state:{runs:{},sessions:{}}},harness:{executionOperations:{
    findByRequest:()=>null}}};
  const context:any={card:{cardId:'card-1',revision:1},
    ticket:{id:'ticket-1',expected_worktree:'C:/fixture/repo'}};
  service.reconcileModelActions(context);
  assert.equal(updates.length,1);
  assert.equal(updates[0][4],'definitely-not-applied');
  assert.equal(updates[0][5].reason,'checked-restart-no-operation-or-runtime');

  updates.length=0;
  action.updated_at='2026-09-28T09:00:03.000Z';
  service.reconcileModelActions(context);
  assert.equal(updates.length,0,'same-service absence is not proof that no side effect occurred');

  action.updated_at='2026-09-28T09:00:01.000Z';
  service.manager.store.state.sessions={session1:{cwd:'C:/fixture/repo'}};
  service.manager.store.state.runs={run1:{session_id:'session1',
    created_at:'2026-09-28T09:00:01.500Z',model:'gpt-6-sol',reasoning:'high'}};
  service.reconcileModelActions(context);
  assert.equal(updates.length,0,'a matching durable runtime keeps the attempt unknown');
});

test('known model launch rejection is distinct from recording-outcome unknown',()=>{
  const updates:any[]=[];
  const action:any={slot:'implementation',attempt_state:'attempted',
    intent:{request_id:'request-implementation'}};
  const service=Object.create(CompanionContinuationService.prototype) as any;
  service.store={continuationAction:()=>action,
    updateContinuationAction:(...args:any[])=>{updates.push(args);return {conflict:false};}};
  const context:any={card:{cardId:'card-1',revision:1},ticket:{id:'ticket-1'}};
  service.manager={harness:{executionOperations:{findByRequest:()=>null}}};
  service.recordModelLaunchFailure(context,'implementation',{code:'IMPLEMENTATION_ENVIRONMENT_CONFLICT'});
  assert.equal(updates.at(-1)[4],'definitely-not-applied');
  assert.equal(updates.at(-1)[5].code,'IMPLEMENTATION_ENVIRONMENT_CONFLICT');
  service.recordModelLaunchFailure(context,'implementation',{code:'RECORDING_OUTCOME_UNKNOWN'});
  assert.equal(updates.at(-1)[4],'unknown');

  service.manager.harness.executionOperations={findByRequest:()=>({operation_id:'operation-1'}),
    reconcile:()=>({effective_state:'failed',runtime:{run_id:null}})};
  service.recordModelLaunchFailure(context,'implementation',{code:'IMPLEMENTATION_LAUNCH_REJECTED'});
  assert.equal(updates.at(-1)[4],'definitely-not-applied');
  assert.equal(updates.at(-1)[5].operation_id,'operation-1');
});

test('definitely-not-applied implementation is retry-ready without replacing its intent',async()=>{
  const action:any={slot:'implementation',attempt_state:'definitely-not-applied',
    intent:{action:'implementation',request_id:'frozen-request'}};
  const workflow:any={workflow_revision:3,snapshot:{phase:'implementation',findings:[],
    subject:{subject_id:'subject-1',head:'a'.repeat(40),staged:[],unstaged:[],untracked:[]}}};
  const summary:any={assessment:{state:'verified'},acceptance:{accepted:false}};
  const context:any={card:{cardId:'card-1',revision:1,content:{endpoint:'to-pr'}},
    link:{binding_kind:'dispatch',binding_id:'dispatch-1'},binding:{},
    ticket:{id:'ticket-1',reference:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/901'}};
  const service=Object.create(CompanionContinuationService.prototype) as any;
  service.locator=()=>context;
  service.manager={harness:{workflowHistory:{current:{get:()=>workflow},summary:()=>summary}}};
  service.initialOperation=()=>({state:'completed',receipt:null,run:{status:'completed'}});
  service.designEvidence=async()=>({state:'completed',notes:{path:'notes',sha256:'a'.repeat(64)}});
  service.store={continuationActions:()=>[action]};
  service.controlledImplementation=()=>null;
  service.delivery={reconcile:async()=>({state:'not-started'})};
  const receipt=await service.get({card_store_id:'store',card_id:'card-1',revision:1});
  assert.equal(receipt.next_action.action,'implementation');
  assert.equal(receipt.next_action.state,'ready');
  assert.equal(receipt.next_action.reason,'COMPANION_ACTION_RETRY_READY');

  let retried=0;
  service.store.continuationAction=()=>action;
  service.manager.harness.workflowHistory.source={assess:()=>({state:'verified'})};
  service.retryImplementation=async(_raw:any,_context:any,existing:any,current:any)=>{
    retried++; assert.equal(existing,action); assert.equal(current,workflow);
    assert.equal(existing.intent.request_id,'frozen-request'); return {retried:true};
  };
  const result=await service.startModel({},context,'implementation','implementation',
    {notes:{path:'unused',sha256:'b'.repeat(64)}});
  assert.deepEqual(result,{retried:true});
  assert.equal(retried,1);
});
test('recorded design handoff survives a later Notes handoff update',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-design-handoff-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const notes=join(dir,'docs','implementation-notes','COMPANION-007.md');
  mkdirSync(join(dir,'docs','implementation-notes'),{recursive:true});
  writeFileSync(notes,'### Context Plan\n\n## Implementation Handoff\nUpdated\n','utf8');
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
    value:{product_decision_required:false,product_decisions:[],acceptance_plan:[]}});
  service.acceptanceAuthority=async()=>({state:'completed',plan:{criteria:[]}});
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
  service.initialOperation=()=>({receipt:{runtime:{session_id:'session-1',run_id:'run-1'}}});
  service.manager.status=()=>({run:{id:'run-1',session_id:'session-1',
    created_at:'2026-09-28T01:00:00Z',
    status:'completed',model:'gpt-6-sol',reasoning:'medium',usage:{input_tokens:42,
      cached_input_tokens:12,output_tokens:3}}});
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
  assert.match(readFileSync(checkpoint,'utf8'),/model_usage:\n  runs: 1\n  input_tokens: 42/u);
  service.requireUsageCheckpoint(context);
  assert.equal(source.assess(ticket,current.snapshot).state,'verified');
});

test('ticket-design evidence uses the public ExecutionOperations receipt contract',t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-design-receipt-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const requestId='companion-prep:prep-design:ticket-design';
  const expected=companionResultIdentity(dir,'card-design',2,'ticket-design',requestId,1,
    'design-subject',null);
  mkdirSync(dirname(expected.result_path),{recursive:true});
  const report=join(dirname(expected.result_path),'report.md');
  writeFileSync(report,'design report\n','utf8');
  writeFileSync(expected.result_path,JSON.stringify({schema_version:1,action:'ticket-design',
    status:'completed',request_id:requestId,subject_ref:'design-subject',
    subject_identity:null,report_ref:relative(dir,report).replaceAll('\\','/'),blockers:[],
    product_decision_required:false,product_decisions:[],acceptance_plan:[]}), 'utf8');
  const operation:any={operation_id:'operation-design',request_id:requestId,
    action:'ticket-design',policy:{action:'ticket-design'},
    preflight:{workflow_revision:1,subject_ref:'design-subject',subject_identity:null},
    destination:{kind:'main'}};
  const manager:any={harness:{executionOperations:{findByRequest:()=>operation,
    reconcile:()=>({effective_state:'completed',
      runtime:{session_id:'session-design',run_id:'run-design'}})},
    source:{runs:()=>[{id:'run-design',status:'completed'}]}}};
  const evidence=new CompanionEvidenceAdapter({manager});
  const observed=evidence.operation('ticket-design',requestId,'ticket-design',
    'ticket-design',dir,expected);
  assert.equal(observed.state,'completed');
  assert.equal(observed.operation_id,'operation-design');
  assert.equal(observed.run_id,'run-design');
  const service=Object.create(CompanionContinuationService.prototype) as any;
  service.manager=manager; service.evidence=evidence;
  const viaService=service.designResult({link:{binding_kind:'preparation'},
    binding:{preparationId:'prep-design'},ticket:{id:'ticket-design',expected_worktree:dir},
    card:{cardId:'card-design',revision:2}});
  assert.equal(viaService.state,'completed');
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
    policy:{action:'ticket-review'},preflight:{workflow_revision:2,subject_ref:'subject-1',
      subject_identity:'a'.repeat(64)},destination:{kind:'child',relation:{kind:'review',
        review_id:'review-1'}}};
  const child:any={relation:{kind:'review',review_id:'review-1',participant:'coordinator'},
    isolation:{state:'verified'},bindings:[{session_id:'session-1',run_id:'run-1',
      isolation:{state:'verified'},isolation_provenance:{event_id:'event-1'}}]};
  const manager:any={harness:{executionOperations:{findByRequest:()=>operation,
    reconcile:()=>({effective_state:'completed',runtime:{session_id:'session-1',run_id:'run-1'}})},
    conversations:{summary:()=>[child]},
    source:{runs:()=>[{id:'run-1',status:'completed'}]}}};
  const evidence=new CompanionEvidenceAdapter({manager});
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).state,'completed');
  child.isolation={state:'unknown'};
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).reason,
    'COMPANION_REVIEW_ISOLATION_UNKNOWN');
  child.isolation={state:'verified'};
  child.bindings[0].isolation_provenance=null;
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).reason,
    'COMPANION_REVIEW_ISOLATION_UNKNOWN');
  child.bindings[0].isolation_provenance={event_id:'event-1'};
  assert.equal(evidence.readResult(dir,'primary-review','review',second).state,'unknown');
  delete result.operation_id; delete result.run_id;
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  const injected=evidence.operation('ticket-1','request-1','review','primary-review',dir,first);
  assert.equal(injected.state,'completed');
  assert.equal(injected.value.operation_id,'operation-1');
  assert.equal(injected.value.run_id,'run-1');
  result.status='incomplete'; result.blockers=['无法核实 operation_id 与 run_id'];
  result.operation_id=null; result.run_id=null;
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  const legacy=evidence.operation('ticket-1','request-1','review','primary-review',dir,first);
  assert.equal(legacy.state,'completed');
  assert.equal(legacy.value.status,'incomplete');
  assert.equal(legacy.value.operation_id,'operation-1');
  assert.equal(legacy.value.run_id,'run-1');
  assert.equal(legacy.legacy_runtime_identity_reconciled,true);
  result.blockers=['other evidence unavailable'];
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).state,
    'incomplete');
  result.status='completed'; result.blockers=[];
  result.operation_id='operation-1'; result.run_id='run-1';
  result.request_id='old-request';
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).reason,
    'COMPANION_RESULT_IDENTITY_CONFLICT');
  result.request_id='request-1'; result.subject_identity='old-subject';
  writeFileSync(first.result_path,JSON.stringify(result),'utf8');
  assert.equal(evidence.operation('ticket-1','request-1','review','primary-review',dir,first).reason,
    'COMPANION_RESULT_IDENTITY_CONFLICT');
  result.subject_identity=first.subject_identity;
  assert.equal(evidence.readResult(dir,'primary-review','review',
    {...first,result_path:second.result_path}).reason,'COMPANION_RESULT_PATH_CONFLICT');
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

test('mechanical commit rejects stale suite bytes and resumes the one reserved intent',t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-mechanical-commit-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  git('init','-b','main'); git('config','user.email','fixture@example.invalid');
  git('config','user.name','Fixture');
  writeFileSync(join(dir,'feature.txt'),'before\n','utf8');
  git('add','--','feature.txt'); git('commit','-m','baseline');
  writeFileSync(join(dir,'feature.txt'),'after\n','utf8');
  const head=git('rev-parse','HEAD'),content=[{path:'feature.txt',sha256:digest('after\n')}];
  const suite:any={attempt_state:'verified',intent:{head,content},receipt:{
    task_id:'task-1',head,content_digest:digest(JSON.stringify(content)),exit_code:0}};
  const actions=new Map<string,any>([['full-suite:implementation',suite]]);
  let claims=0;
  const store:any={continuationAction:(_card:string,_revision:number,slot:string)=>actions.get(slot),
    claimContinuationAction:(_card:string,_revision:number,slot:string,intent:any)=>{
      claims++; const action={attempt_state:'reserved',intent}; actions.set(slot,action);
      return {action,conflict:false};
    },updateContinuationAction:(_card:string,_revision:number,slot:string,_from:string,
      to:string,receipt:any)=>{const action=actions.get(slot); action.attempt_state=to;
      action.receipt=receipt; return {conflict:false};}};
  const mechanical=new CompanionMechanicalAdapter({store,computer:null});
  const locator={card_id:'card-1',revision:1},ticket:any={expected_worktree:dir,key:'T-1'};
  const tests={state:'passed',...suite.receipt};
  writeFileSync(join(dir,'feature.txt'),'changed after suite\n','utf8');
  assert.throws(()=>mechanical.commit(locator,ticket,'implementation',['feature.txt'],tests),
    {code:'COMPANION_TEST_SUBJECT_CHANGED'});
  assert.equal(claims,0);
  writeFileSync(join(dir,'feature.txt'),'after\n','utf8');
  writeFileSync(join(dir,'extra.txt'),'extra\n','utf8');
  assert.throws(()=>mechanical.commit(locator,ticket,'implementation',['feature.txt'],tests),
    {code:'COMPANION_COMMIT_SCOPE_CONFLICT'});
  rmSync(join(dir,'extra.txt'));
  assert.throws(()=>mechanical.commit(locator,ticket,'implementation',['feature.txt'],
    {...tests,task_id:'old-task'}),{code:'COMPANION_TEST_RECEIPT_CONFLICT'});
  const frozen={schema_version:1,parent:head,content,files:['feature.txt'],
    tests:{task_id:'task-1',content_digest:suite.receipt.content_digest}};
  actions.set('commit:implementation',{attempt_state:'reserved',intent:frozen});
  writeFileSync(join(dir,'feature.txt'),'changed during reserved\n','utf8');
  assert.equal(mechanical.reconcileCommit(locator,ticket,'implementation').state,'unknown');
  assert.equal(git('rev-parse','HEAD'),head);
  writeFileSync(join(dir,'feature.txt'),'after\n','utf8');
  writeFileSync(join(dir,'feature.txt'),'different staged bytes\n','utf8');
  git('add','--','feature.txt');
  writeFileSync(join(dir,'feature.txt'),'after\n','utf8');
  const rejected=mechanical.reconcileCommit(locator,ticket,'implementation');
  assert.deepEqual(rejected,{state:'unknown',reason:'COMPANION_COMMIT_INDEX_CONFLICT'});
  assert.equal(git('show',':feature.txt'),'different staged bytes',
    'recovery must not overwrite a drifted index before rejecting it');
  assert.equal(git('rev-parse','HEAD'),head);
  git('add','--','feature.txt');
  assert.equal(mechanical.reconcileCommit(locator,ticket,'implementation').state,'committed');
  assert.equal(claims,0,'recovery reuses the frozen intent');
  assert.equal(git('rev-parse','HEAD^'),head);
  assert.equal(git('show','HEAD:feature.txt'),'after');
});

test('model usage checkpoint uses durable terminal run status and blocks stale launch',t=>{
  const dir=mkdtempSync(join(tmpdir(),'companion-model-usage-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=join(dir,'checkpoint.md');
  const service=Object.create(CompanionContinuationService.prototype) as any;
  const context:any={card:{cardId:'card-1',revision:1},ticket:{id:'ticket-1'}};
  const run:any={id:'run-1',session_id:'session-1',created_at:'2026-09-28T01:00:00Z',status:'completed',
    model:'gpt-6-sol',reasoning:'medium',usage:{input_tokens:120,cached_input_tokens:20,
      output_tokens:10}};
  let observedRun:any=run;
  service.initialOperation=()=>({receipt:{runtime:{session_id:'session-1',run_id:'run-1'}}});
  service.store={continuationActions:()=>[]};
  service.manager={status:()=>({run:observedRun}),harness:{workflowHistory:{current:{get:()=>({
    snapshot:{checkpoint:{artifact_id:'checkpoint'},artifacts:[{artifact_id:'checkpoint',
      location:filename,revision:digest(readFileSync(filename))}]}})}}}};
  writeFileSync(filename,'---\nphase: review\n---\n','utf8');
  const usage=service.modelUsage(context);
  assert.deepEqual(usage,{observation:'complete',runs:1,input_tokens:120,
    cached_input_tokens:20,output_tokens:10,
    current_model:'gpt-6-sol',current_reasoning:'medium',anomaly:false});
  assert.throws(()=>service.requireUsageCheckpoint(context),
    {code:'COMPANION_MODEL_USAGE_CHECKPOINT_UNKNOWN'});
  writeFileSync(filename,service.usageBytes(readFileSync(filename,'utf8'),usage),'utf8');
  service.requireUsageCheckpoint(context);
  delete run.usage.cached_input_tokens;
  assert.throws(()=>service.requireUsageCheckpoint(context),
    {code:'COMPANION_MODEL_USAGE_CHECKPOINT_UNKNOWN'});
  const unknown=service.modelUsage(context);
  assert.equal(unknown.observation,'complete');
  assert.equal(unknown.cached_input_tokens,null);
  assert.equal(unknown.runs,1);
  writeFileSync(filename,service.usageBytes(readFileSync(filename,'utf8'),unknown),'utf8');
  service.requireUsageCheckpoint(context);
  for (const missing of [null,{...run,status:'running'},{...run,id:'other-run'},
    {...run,session_id:'other-session'}]) {
    observedRun=missing;
    const incomplete=service.modelUsage(context);
    assert.equal(incomplete.observation,'incomplete');
    assert.equal(incomplete.runs,1);
    assert.equal(incomplete.input_tokens,null);
    writeFileSync(filename,service.usageBytes(readFileSync(filename,'utf8'),incomplete),'utf8');
    assert.throws(()=>service.requireUsageCheckpoint(context),
      {code:'COMPANION_MODEL_USAGE_CHECKPOINT_UNKNOWN'});
  }
  service.manager.status=()=>{throw Error('runtime unavailable');};
  assert.equal(service.modelUsage(context).observation,'incomplete');
  assert.throws(()=>service.requireUsageCheckpoint(context),
    {code:'COMPANION_MODEL_USAGE_CHECKPOINT_UNKNOWN'});
});
