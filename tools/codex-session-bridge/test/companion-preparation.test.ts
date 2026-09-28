import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubPreparationIssues, CompanionPreparationService } from '../src/orchestration/companion-preparation.mjs';
import { CompanionContinuationService } from '../src/orchestration/companion-continuation.mjs';
import { GitPreparationWorktree } from '../src/orchestration/companion-preparation.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EngineeringCardStore } from '../../companion-desktop/backend/engineering-card-store.mjs';
import { Harness } from '../src/harness/harness.ts';
import { digestWorkflowAgentPolicy } from '../src/orchestration/workflow-agent-launcher.ts';
import { createHash, randomUUID } from 'node:crypto';

test('an unknown Issue creation is adopted only by unique immutable identity and exact marker', async () => {
  const repository = 'Emilia-tan-Ovo/yuki-link';
  const marker = 'yuki-preparation:11111111-1111-4111-8111-111111111111';
  const payloadDigest = 'a'.repeat(64);
  const body = `需求内容\n<!-- ${marker}:${payloadDigest} -->`;
  const issue = { repository, id: 81, number: 42, url:`https://github.com/${repository}/issues/42`,
    title:'需求内容', body, creator:'owner' };
  const source = new GitHubPreparationIssues({
    async create() { throw Error('receipt lost'); },
    async findByMarker() { return [issue]; },
    async read() { return issue; },
    async authenticatedActor() { return 'owner'; },
  });
  await assert.rejects(source.create({repository,marker,payloadDigest,title:'需求内容',body:'需求内容'}));
  assert.equal((await source.reconcile({repository,marker,payloadDigest}))?.id,81);
  const ambiguous = new GitHubPreparationIssues({
    async findByMarker() { return [issue,{...issue,id:82,number:43,url:`https://github.com/${repository}/issues/43`}]; },
    async read(_repo: string, number: number) { return number === 42 ? issue : {...issue,id:82,number:43,url:`https://github.com/${repository}/issues/43`}; },
    async authenticatedActor() { return 'owner'; },
  });
  assert.equal(await ambiguous.reconcile({repository,marker,payloadDigest}),null);
});

test('worktree recovery keeps the frozen base OID after base branch advances', t => {
  const root = mkdtempSync(path.join(tmpdir(),'companion-prep-git-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const repo = path.join(root,'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
  git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  git('remote','add','origin','https://github.com/Emilia-tan-Ovo/yuki-link.git');
  writeFileSync(path.join(repo,'readme.md'),'one\n'); git('add','readme.md'); git('commit','-m','one');
  const worktrees = new GitPreparationWorktree({projectKey:'yuki-link',repository:'Emilia-tan-Ovo/yuki-link',
    repositoryRoot:repo,baseRef:'refs/heads/main',worktreeRoot:path.join(repo,'.local','worktrees')});
  const frozen = worktrees.freeze('11111111-1111-4111-8111-111111111111');
  git('branch',frozen.branch,frozen.oid);
  assert.equal(worktrees.ensure(frozen).head,frozen.oid);
  writeFileSync(path.join(repo,'readme.md'),'two\n'); git('add','readme.md'); git('commit','-m','two');
  assert.notEqual(git('rev-parse','HEAD'),frozen.oid);
  assert.equal(worktrees.ensure(frozen).head,frozen.oid);
});

test('worktree recovery rejects a replacement repository with the same branch and commit', t => {
  const root = mkdtempSync(path.join(tmpdir(),'companion-prep-replaced-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const repo = path.join(root,'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
  git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  git('remote','add','origin','https://github.com/Emilia-tan-Ovo/yuki-link.git');
  writeFileSync(path.join(repo,'readme.md'),'one\n'); git('add','readme.md'); git('commit','-m','one');
  const worktrees = new GitPreparationWorktree({projectKey:'yuki-link',repository:'Emilia-tan-Ovo/yuki-link',
    repositoryRoot:repo,baseRef:'refs/heads/main',worktreeRoot:path.join(repo,'.local','worktrees')});
  const frozen = worktrees.freeze('11111111-1111-4111-8111-111111111111');
  worktrees.ensure(frozen);
  rmSync(frozen.path,{recursive:true,force:true});
  git('clone','--shared','--branch',frozen.branch,repo,frozen.path);
  assert.equal(worktrees.inspect(frozen),null);
  assert.throws(() => worktrees.ensure(frozen),/PREPARATION_WORKTREE_CONFLICT/);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:frozen.path,encoding:'utf8'}).trim(),frozen.oid);
});

test('preparation entry reports missing authorization without creating an Issue', async t => {
  const root = mkdtempSync(path.join(tmpdir(),'companion-prep-card-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const store = new EngineeringCardStore(root);
  const card = store.create({ original:'新需求', summary:'新需求', projectKey:'yuki-link',
    repository:'Emilia-tan-Ovo/yuki-link', ticket:null, resolution:{status:'explicit_new_requirement'},
    desiredPhase:'ticket-design', endpoint:'design-only', extraAuthorization:{merge:false,deploy:false} });
  store.confirm(card.cardId,card.revision,'desktop-user-action'); const storeId = store.storeId; store.close();
  const service = new CompanionPreparationService({directory:root,manager:{harness:{}},projects:[],
    issues:{ create() { throw Error('must not run'); } }});
  const receipt = await service.get({card_store_id:storeId,
    card_id:card.cardId,revision:card.revision});
  assert.equal(receipt.preparation_for_ticket_design.state,'blocked');
  assert.ok(receipt.preparation_for_ticket_design.blockers.includes('PREPARATION_AUTHORIZATION_MISSING'));
  service.close();
});

test('unknown Issue outcome is reconciled after service reopen without another create', async t => {
  const root = mkdtempSync(path.join(tmpdir(),'companion-prep-reopen-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const store = new EngineeringCardStore(root);
  const card = store.create({original:'新需求',summary:'新需求',projectKey:'yuki-link',
    repository:'Emilia-tan-Ovo/yuki-link',ticket:null,resolution:{status:'explicit_new_requirement'},
    desiredPhase:'ticket-design',endpoint:'design-only',extraAuthorization:{merge:false,deploy:false},
    preparationAuthorization:{schemaVersion:1,issue:true,worktree:true,
      forbidden:['implementation','pr','merge','deploy']}});
  store.confirm(card.cardId,1,'desktop-user-action'); const storeId = store.storeId; store.close();
  let creates = 0, searchVisible = false, remote: any;
  const issues = new GitHubPreparationIssues({async authenticatedActor() {return 'owner';},
    async create(repository: string,title: string,body: string) {
      creates++; remote={repository,id:33,number:7,url:`https://github.com/${repository}/issues/7`,
        title,body,creator:'owner'}; throw Error('lost receipt'); },
    async findByMarker() {return searchVisible ? [remote] : [];},
    async read() {return remote;}});
  const manager = {harness:{executionGate:() => {},source:{activeRuns:() => []}},
    workflowAgentAuthority:{snapshot:() => ({policy:{project_key:'yuki-link',
      workflow_phase:'ticket-design',permission_selection:'owner-native-default'}})}};
  const options = {directory:root,manager,issues,projects:[{projectKey:'yuki-link',
    repository:'Emilia-tan-Ovo/yuki-link'}],gitFactory:() => ({preflight:() => {},
      freeze:() => {throw Error('stop after issue reconciliation');}})};
  let service = new CompanionPreparationService(options);
  const input = {card_store_id:storeId,card_id:card.cardId,revision:1};
  assert.deepEqual((await service.prepare(input)).unknown_side_effects,['github-issue-create']);
  service.close(); searchVisible = true;
  service = new CompanionPreparationService(options);
  await assert.rejects(service.prepare(input),/stop after issue reconciliation/);
  assert.equal(creates,1);
  assert.equal(service.store.preparation(card.cardId,1)?.bindings.issue.id,33);
  service.close();
});

test('confirmed no-ticket card bootstraps real Harness Workflow and ExecutionOperations', async t => {
  const root = mkdtempSync(path.join(tmpdir(),'companion-prep-e2e-'));
  const repo = path.join(root,'repo'), cards = path.join(root,'cards');
  mkdirSync(repo); mkdirSync(cards);
  const git = (...args: string[]) => execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
  git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  git('remote','add','origin','https://github.com/Emilia-tan-Ovo/yuki-link.git');
  writeFileSync(path.join(repo,'readme.md'),'baseline\n'); git('add','readme.md'); git('commit','-m','baseline');
  const cardStore = new EngineeringCardStore(cards);
  const card = cardStore.create({original:'为 yuki-link 设计新需求',summary:'新需求设计',
    projectKey:'yuki-link',repository:'Emilia-tan-Ovo/yuki-link',ticket:null,
    resolution:{status:'explicit_new_requirement',source:'owner-explicit'},
    desiredPhase:'ticket-design',endpoint:'design-only',extraAuthorization:{merge:false,deploy:false},
    preparationAuthorization:{schemaVersion:1,issue:true,worktree:true,
      forbidden:['implementation','pr','merge','deploy']}});
  cardStore.confirm(card.cardId,1,'desktop-user-action'); const cardStoreId = cardStore.storeId; cardStore.close();
  let created = 0, spawned = 0, mirrorWrites = 0, remote: any = null;
  const issues = new GitHubPreparationIssues({
    async authenticatedActor() { return 'owner'; },
    async create(repository: string,title: string,body: string) { created++; remote = {repository,id:501,number:42,
      url:`https://github.com/${repository}/issues/42`,title,body,creator:'owner'}; return remote; },
    async read() { return remote; }, async findByMarker() { return remote ? [remote] : []; },
    async update(_repository: string,_number: number,body: string) {
      mirrorWrites++; remote = {...remote,body};
      if (mirrorWrites === 1) throw Error('update receipt lost');
      return remote;
    },
  });
  const sessions = new Map<string,any>(), runs = new Map<string,any>(), requests = new Map<string,any>();
  const source = {session:(id: string) => sessions.get(id),runs:(id: string) => [...runs.values()].filter(r => r.session_id === id),
    events:() => [],attribution:() => ({state:'unknown'}),lookupRequest:(id: string) => requests.get(id) ?? null,
    activeRuns:() => [...runs.values()].filter(r => r.status === 'running')};
  const harness = new Harness(path.join(root,'runtime'),source);
  const policyBase = {schema_version:1,policy_id:'design-policy',revision:1,project_key:'yuki-link',
    action:'ticket-design',workflow_phase:'ticket-design',model:'gpt-6-sol',reasoning:'medium',
    permission_selection:'owner-native-default',preflight:{require_recording:true,model_line:'single',
      required_paths:[],required_executables:[],dependency_packages:[]}};
  const policy = {...policyBase,digest:digestWorkflowAgentPolicy(policyBase)};
  const manager = {harness,allowedCwds:[repo],workflowAgentAuthority:{snapshot:() => ({policy})},
    async startGuarded(value: any,guard: (dispatch: any) => unknown) {
      spawned++;
      const promptSha = createHash('sha256').update(value.prompt).digest('hex');
      guard({request_id:value.request_id,fingerprint:createHash('sha256').update(value.request_id).digest('hex'),
        cwd:value.cwd,config:{model:value.model,reasoning:value.reasoning},
        permissions:{sandbox_mode:'danger-full-access',approval_policy:'on-request'},
        launch:{prompt_sha256:promptSha,prompt_utf8_bytes:Buffer.byteLength(value.prompt),sender:value.sender,
          model:value.model,reasoning:value.reasoning,timeout_ms:null,permission_selection:null}});
      const session_id = randomUUID(), run_id = randomUUID();
      sessions.set(session_id,{id:session_id,cwd:value.cwd,codex_thread_id:randomUUID()});
      runs.set(run_id,{id:run_id,session_id,status:'running'});
      requests.set(value.request_id,{request_id:value.request_id,fingerprint:createHash('sha256').update(value.request_id).digest('hex'),
        session_id,run_id,status:'running'});
    }};
  const service = new CompanionPreparationService({directory:cards,manager,issues,
    projects:[{projectKey:'yuki-link',repository:'Emilia-tan-Ovo/yuki-link',repositoryRoot:repo,
      baseRef:'refs/heads/main',worktreeRoot:path.join(repo,'.local','worktrees')}]});
  let continuation: CompanionContinuationService | null = null;
  t.after(() => {
    continuation?.close();
    service.close(); harness.close();
    const registered = git('worktree','list','--porcelain').split(/\r?\n/u)
      .filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    for (const worktree of registered) {
      const relative = path.relative(path.join(repo,'.local','worktrees'),worktree);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
        git('worktree','remove','--force',worktree);
    }
    rmSync(root,{recursive:true,force:true});
  });
  const input = {card_store_id:cardStoreId,card_id:card.cardId,revision:1};
  const receipt = await service.prepare(input);
  assert.equal(receipt.preparation_for_ticket_design.state,'ready',JSON.stringify(receipt));
  assert.equal(created,1); assert.equal(spawned,1);
  assert.equal(harness.tickets.size,1);
  assert.equal(harness.workflowHistory.current.size,1);
  assert.equal(harness.executionOperations.findByRequest(receipt.bindings.harness.ticketId,
    `companion-prep:${receipt.preparation_id}:ticket-design`)?.effective_state,'bound');
  await service.prepare(input);
  assert.equal(created,1); assert.equal(spawned,1);
  const runId = harness.executionOperations.findByRequest(receipt.bindings.harness.ticketId,
    `companion-prep:${receipt.preparation_id}:ticket-design`)!.runtime.run_id;
  runs.get(runId)!.status = 'completed';
  const notesPath = path.join(receipt.bindings.worktree.path,'docs','implementation-notes','ISSUE-42.md');
  mkdirSync(path.dirname(notesPath),{recursive:true});
  writeFileSync(notesPath,'# ISSUE-42 Implementation Notes\n\nSource Spec: https://github.com/Emilia-tan-Ovo/yuki-link/issues/42\n\nPRODUCT_DECISION_REQUIRED: none\n\n### Context Plan\n\n- **Core:** Issue #42\n- **Related:** AGENTS.md\n- **Retrieval:** confirmed card\n- **Expansion triggers:** scope change\n','utf8');
  continuation = new CompanionContinuationService({manager,directory:cards,preparation:service,
    issueSource:{details:async()=>remote} as any});
  (continuation as any).acceptanceAuthority=async()=>({state:'completed',plan:{criteria:[]}});
  (continuation as any).designResult=()=>({state:'completed',sha256:'a'.repeat(64),
    value:{acceptance_plan:[],product_decision_required:false,product_decisions:[]}});
  const locator={schema_version:1,...input};
  assert.equal((await continuation.get(locator)).design.reason,'COMPANION_DESIGN_BINDING_INCOMPLETE');
  const firstAdvance=await continuation.advance(locator);
  assert.equal(firstAdvance.design.reason,'COMPANION_DESIGN_BINDING_INCOMPLETE');
  const unknown = await service.get(input);
  assert.deepEqual(unknown.unknown_side_effects,['github-issue-mirror']);
  assert.equal(unknown.ticket_design_artifact.state,'unknown');
  assert.equal(unknown.next_action_readiness.state,'unknown');
  assert.ok(unknown.next_action_readiness.source_refs.length);
  const originalWorkflow = harness.workflowHistory.current.get(receipt.bindings.harness.ticketId)!;
  const recoveredSnapshot = structuredClone(originalWorkflow.snapshot);
  recoveredSnapshot.artifacts.push({artifact_id:'implementation-notes',role:'implementation-notes',kind:'file',
    location:notesPath,revision:createHash('sha256').update(readFileSync(notesPath)).digest('hex'),
    source_schema:'context-plan-v0',source:'companion-preparation',
    observed_at:new Date().toISOString(),integrity:'observed'});
  harness.recordWorkflow({ticket_id:receipt.bindings.harness.ticketId,
    request_id:`companion-prep:${receipt.preparation_id}:design-workflow`,
    expected_revision:originalWorkflow.workflow_revision,schema_version:1,snapshot:recoveredSnapshot});
  const finishedAdvance = await continuation.advance(locator);
  assert.equal(finishedAdvance.next_action.action,'endpoint-reached');
  assert.equal((await continuation.advance(locator)).next_action.action,'endpoint-reached');
  const finished = await service.get(input);
  assert.equal(finished.ticket_design_artifact.state,'ready',JSON.stringify(finished));
  assert.equal(finished.next_action_readiness.state,'unsupported');
  assert.equal(created,1); assert.equal(mirrorWrites,1); assert.equal(spawned,1);
  remote = {...remote,body:remote.body.replace('<!-- yuki-design-mirror:end -->','<!-- mirror changed -->')};
  const drift = await service.get(input);
  assert.equal(drift.ticket_design_artifact.state,'blocked');
  assert.equal(drift.next_action_readiness.state,'blocked');
});
