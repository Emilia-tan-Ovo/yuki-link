import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineeringCardStore } from '../../companion-desktop/backend/engineering-card-store.mjs';
import { CompanionDispatchService } from '../src/orchestration/companion-dispatch.mjs';

const repo = 'Emilia-tan-Ovo/yuki-link';
const make = (t: any) => {
  const directory = mkdtempSync(join(tmpdir(),'yuki-companion-yca-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  const cards = new EngineeringCardStore(directory);
  const card = cards.create({ original:'实现 #130',projectKey:'yuki-link',repository:repo,
    ticket:{id:1300,repository:repo,number:130,title:'COMPANION-005',marker:'COMPANION-005',
      url:`https://github.com/${repo}/issues/130`,scope:{digest:'a'.repeat(64)}},
    resolution:{status:'verified_existing'},desiredPhase:'implementation',endpoint:'to-pr',
    extraAuthorization:{merge:false,deploy:false} });
  cards.confirm(card.cardId,1,'desktop-user-action');
  const envelope = cards.envelope(card.cardId,1);
  cards.close();
  const input = {schema_version:1,card_store_id:envelope.card_store_id,card_id:card.cardId,
    revision:1,dispatch_id:envelope.dispatch_id};
  return { directory, input };
};

test('duplicate and lost receipt resolve the original execution without a second launch', async t => {
  const {directory,input} = make(t);
  let launches = 0, operation: any = null;
  const manager: any = { harness: { executionOperations: {
    findByRequest: (_ticket: string, request: string) => operation?.request_id === request ? operation : null,
    reconcile: () => operation,
  }, detail: () => ({ workflow: { current: { phase:'implementation',acceptance:{status:'pending'} } } }) },
  status: () => ({ session:{session_id:'session-1'},
    run:{run_id:'run-1',status:'completed',final_response:'已完成实际修改'}, session_status:'idle' }) };
  const service: any = new CompanionDispatchService({manager,directory,launch: async (claim: any) => {
    launches++;
    operation = {operation_id:'operation-1',ticket_id:claim.ticket_id,request_id:claim.request_id,
      companion_dispatch:claim.provenance,effective_state:'bound',runtime:{session_id:'session-1',run_id:'run-1'},destination:{kind:'main'}};
  }} as any);
  service.preflight = async () => ({ card_id:input.card_id,revision:1,dispatch_id:input.dispatch_id,
    ticket_id:'ticket-1',ticket_key:'COMPANION-005',ticket_ref:`https://github.com/${repo}/issues/130`,
    main_conversation_id:'main-1',review_id:null,request_id:service.requestId(input),
    launcher_input:{action:'implementation'},authorization:{},policy:{},provenance:{},claim_digest:'a'.repeat(64) });
  const accepted = await service.dispatch(input);
  assert.equal(accepted.operation_id,'operation-1');
  assert.equal(accepted.run_id,'run-1');
  assert.deepEqual(accepted.run,{run_id:'run-1',status:'completed',final_response:'已完成实际修改'});
  assert.equal(accepted.acceptance.status,'pending');
  assert.equal(accepted.pr_delivery.state,'unknown');
  service.close();
  const reopened = new CompanionDispatchService({manager,directory,launch: async () => { launches++; }} as any);
  assert.equal((await reopened.dispatch(input)).operation_id,'operation-1');
  assert.equal(reopened.get(input).deduplicated,true);
  assert.equal(launches,1);
  reopened.close();
});

test('claim without operation stays reconciliation-required and cannot restart automatically', async t => {
  const {directory,input} = make(t);
  let launches = 0;
  const manager: any = { harness: {executionOperations:{findByRequest:()=>null},detail:()=>({workflow:{current:null}})} };
  const service: any = new CompanionDispatchService({manager,directory,launch:async()=>{launches++;throw Error('unknown');}} as any);
  service.preflight = async () => ({card_id:input.card_id,revision:1,dispatch_id:input.dispatch_id,
    ticket_id:'ticket-1',ticket_ref:`https://github.com/${repo}/issues/130`,request_id:service.requestId(input),
    launcher_input:{action:'implementation'},claim_digest:'a'.repeat(64)});
  assert.equal((await service.dispatch(input)).reconciliation,true);
  assert.equal((await service.dispatch(input)).operation_id,null);
  assert.equal(launches,1);
  service.close();
});

test('authorization adapter rechecks claimed card and active policy at the launch guard', t => {
  const {directory,input} = make(t);
  const manager: any = {harness:{workflowHistory:{current:new Map([['ticket-1',{workflow_revision:1,assessment:{state:'verified'}}]])}},
    implementationLaunchAuthority:{snapshot:()=>({policy:{policy_id:'p',revision:1,digest:'a'.repeat(64)}})}};
  const service = new CompanionDispatchService({manager,directory});
  const claim = {card_id:input.card_id,revision:1,dispatch_id:input.dispatch_id,
    ticket_id:'ticket-1',ticket_key:'COMPANION-005',action:'ticket-design',authorization_ref:'companion:one',
    github_observed_at:new Date().toISOString(),policy:{policy_id:'p',revision:1,digest:'a'.repeat(64)},
    authorization:{authorization_ref:'companion:one'},provenance:{schema_version:1},claim_digest:'a'.repeat(64),
    launcher_input:{expected:{workflow_revision:1}}};
  manager.workflowAgentAuthority={snapshot:()=>({policy:{policy_id:'p',revision:1,digest:'a'.repeat(64)}})};
  assert.equal(service.store.claim(input.card_id,1,input.dispatch_id,claim).deduplicated,false);
  assert.equal(service.authority(claim).snapshot('COMPANION-005','ticket-design','companion:one').policy.revision,1);
  manager.workflowAgentAuthority.snapshot=()=>({policy:{policy_id:'p',revision:2,digest:'b'.repeat(64)}});
  assert.throws(()=>service.authority(claim).snapshot('COMPANION-005','ticket-design','companion:one'));
  service.close();
});

test('design-only derives only ticket-design from a prepared current phase', async t => {
  const {directory,input} = make(t);
  const store = new EngineeringCardStore(directory);
  const current = store.get(input.card_id);
  const design = store.edit(input.card_id,1,{...current!.content,endpoint:'design-only',desiredPhase:'ticket-design',
    extraAuthorization:{merge:{requested:true,status:'explicit',target:'PR #42'},deploy:false}});
  store.confirm(input.card_id,design.revision,'desktop-user-action');
  const envelope = store.envelope(input.card_id,design.revision);
  const request = {schema_version:1,card_store_id:store.storeId,card_id:input.card_id,
    revision:design.revision,dispatch_id:envelope.dispatch_id};
  const ticketId='00000000-0000-4000-8000-000000000001';
  const issue = {...design.content.ticket,body:'Implementation Notes'};
  const ticket = {id:ticketId,key:'COMPANION-005',reference:issue.url,project_id:'project',
    main_conversation_id:'00000000-0000-4000-8000-000000000002',expected_worktree:directory,
    comparison_baseline:{worktree_root:directory}};
  const workflow = {workflow_revision:1,assessment:{state:'verified'},snapshot:{phase:'ticket-design',
    subject:{subject_id:'subject-1'}}};
  const manager: any = {harness:{tickets:new Map([[ticketId,ticket]]),projects:new Map([['project',{key:'yuki-link'}]]),
    workflowHistory:{current:new Map([[ticketId,workflow]])},changes:{facts:{currentIdentity:()=>({
      scheme:'yuki-git-subject',version:1,scope:{},completeness:'complete',digest:'sha256:'+'a'.repeat(64)})}}},
    workflowAgentAuthority:{snapshot:()=>({policy:{schema_version:1,policy_id:'p',revision:1,
      digest:'b'.repeat(64),project_key:'yuki-link',workflow_phase:'ticket-design',
      permission_selection:'owner-native-default'}})}};
  const service = new CompanionDispatchService({manager,directory,issueSource:{details:async()=>issue},
    contextFactory:()=>({assemble:()=>({action_readiness:{state:'ready'},attention:{unknown_side_effects:[]},
      retrieval:{context_plan:{status:'missing'}}})})} as any);
  const proposed = await service.preflight(request,envelope);
  assert.equal(proposed.action,'ticket-design');
  assert.equal(proposed.launcher_input.action,'ticket-design');
  assert.equal(proposed.launcher_input.confirmed_request,design.content.original);
  assert.equal(JSON.stringify(proposed.authorization).includes('merge'),false);
  workflow.snapshot.phase='implementation';
  await assert.rejects(()=>service.preflight(request,envelope));
  service.close(); store.close();
});
