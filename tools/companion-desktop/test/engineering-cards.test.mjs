import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineeringCardStore } from '../backend/engineering-card-store.mjs';
import { EngineeringCards, resolveTarget, modelCandidate, localCandidate } from '../backend/engineering-cards.mjs';
import { BackendSession } from '../backend/session.mjs';
import { createWorkerHandler } from '../backend/worker.mjs';
import { githubIssueSource } from '../backend/github-issue-source.mjs';
import { harnessCandidateSource } from '../backend/harness-candidate-source.mjs';

const projects = [{ key: 'yuki-link', aliases: ['Yuki', 'yuki-link'], repository: 'Emilia-tan-Ovo/yuki-link' }, { key: 'other', aliases: ['other'], repository: 'example/other' }];
const issue = (repository, number, title = 'COMPANION-004') => ({ repository, number, title, url: `https://github.com/${repository}/issues/${number}`, state: 'closed' });
async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'yuki-cards-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('content revisions are immutable; confirmation, edit and revoke check revision and state atomically across reopen', async t => {
  const dir = await fixture(t); let store = new EngineeringCardStore(dir);
  const content = { original: '给 yuki-link 的 004 做到 PR', summary: '处理 004', projectKey: 'yuki-link', repository: 'Emilia-tan-Ovo/yuki-link', ticket: issue('Emilia-tan-Ovo/yuki-link', 129), resolution: { status: 'verified_existing', source: 'github', observedAt: '2026-09-26' }, desiredPhase: 'implementation', endpoint: 'to-pr', extraAuthorization: { merge: false, deploy: false } };
  const created = store.create(content); assert.equal(created.revision, 1);
  const edited = store.edit(created.cardId, 1, { ...content, desiredPhase: 'ticket-design', endpoint: 'design-only' });
  assert.equal(edited.revision, 2); assert.equal(store.revision(created.cardId, 1).content.endpoint, 'to-pr');
  assert.equal(store.confirm(created.cardId, 1, 'desktop-user-action').conflict, true);
  const confirmed = store.confirm(created.cardId, 2, 'desktop-user-action'); assert.equal(confirmed.confirmation.revision, 2);
  assert.deepEqual(store.confirm(created.cardId, 2, 'desktop-user-action').confirmation, confirmed.confirmation);
  assert.equal(store.edit(created.cardId, 1, content).conflict, true);
  assert.equal(store.revoke(created.cardId, 1).conflict, true);
  assert.equal(store.revoke(created.cardId, 2).card.state, 'revoked');
  assert.equal(store.confirm(created.cardId, 2, 'desktop-user-action').conflict, true);
  store.close(); store = new EngineeringCardStore(dir);
  assert.equal(store.get(created.cardId).revision, 2); assert.equal(store.get(created.cardId).state, 'revoked'); store.close();
});

test('resolver separates verified ticket, no-ticket intent, ambiguity, unavailable source and workflow freshness', async () => {
  const source = { async lookup(repo, number) { return issue(repo, number); }, async search(repo, term) { return term === '004' ? [issue(repo, repo.includes('yuki-link') ? 129 : 4)] : []; } };
  const known = await resolveTarget({ project: 'yuki-link', ticket: '#129' }, { projects, issueSource: source });
  assert.equal(known.resolution.status, 'verified_existing'); assert.equal(known.ticket.number, 129);
  const noTicket = await resolveTarget({ project: 'yuki-link', noTicket: true }, { projects, issueSource: source });
  assert.equal(noTicket.resolution.status, 'explicit_new_requirement'); assert.equal(noTicket.ticket, null);
  const ambiguous = await resolveTarget({ ticket: '004' }, { projects, issueSource: source });
  assert.equal(ambiguous.resolution.status, 'ambiguous'); assert.equal(ambiguous.candidates.length, 2);
  assert.equal((await resolveTarget({ project: 'yuki-link', ticket: '#129' }, { projects })).resolution.status, 'source_unavailable');
  assert.equal((await resolveTarget({ project: 'yuki-link', ticket: '#404' }, { projects, issueSource: { lookup: async () => null } })).resolution.status, 'verification_failed');
  const focused = await resolveTarget({ ticket: '004' }, { projects, issueSource: source, focus: { projectKey: 'yuki-link' } });
  assert.equal(focused.resolution.status, 'verified_existing');
  assert.equal((await resolveTarget({ ticket: '004' }, { projects, recentCards: [{ content: { repository: 'Emilia-tan-Ovo/yuki-link', ticket: issue('Emilia-tan-Ovo/yuki-link',129) } }] })).resolution.status, 'source_unavailable');
});

test('model cannot invent a Ticket, no-ticket declaration or PR authorization', async () => {
  const candidate = await modelCandidate(async () => ({ content: JSON.stringify({ project: 'yuki-link', ticket: '#129', noTicket: true, endpoint: 'to-pr', summary: '做好了' }) }), '帮我看看设计');
  assert.equal(candidate.ticket, null); assert.equal(candidate.noTicket, false); assert.equal(candidate.endpoint, null); assert.equal(candidate.project, null);
});

test('natural language candidate becomes a persisted card, refresh does not change content revision, no dispatch', async t => {
  const dir = await fixture(t), store = new EngineeringCardStore(dir), calls = [];
  const cards = new EngineeringCards({ store, projects, extract: async () => ({ project: 'yuki-link', ticket: '#129', summary: '完成卡片', desiredPhase: 'implementation', endpoint: 'to-pr' }), issueSource: { lookup: async (...args) => { calls.push(args); return issue('Emilia-tan-Ovo/yuki-link', 129); } }, workflowSource: { observe: async () => ({ phase: 'implementation', revision: 3, assessment: 'stale', observedAt: '2026-09-26' }) } });
  const card = await cards.create('给 yuki-link 的 004 做到 PR');
  assert.equal(card.content.resolution.status, 'verified_existing'); assert.equal(card.observedWorkflow.assessment, 'stale');
  assert.equal(card.content.endpoint, 'to-pr'); assert.equal(card.content.extraAuthorization.merge, false);
  assert.equal(cards.confirm(card.cardId, 1, 'desktop-user-action').card.state, 'confirmed');
  assert.equal(store.get(card.cardId).dispatchStatus, 'not-dispatched');
  await cards.refresh(card.cardId); assert.equal(store.get(card.cardId).revision, 1);
  assert.equal(calls.length, 1); store.close();
});

test('worker card command creates and confirms no-ticket intent without invoking engineering dispatch', async t => {
  const dir = await fixture(t), events = [];
  const handle = createWorkerHandler({ post: event => events.push(event), createSession: () => new BackendSession({ directory: dir, mode: 'preview' }) });
  await handle({ type: 'start', generation: 1, preview: true });
  await handle({ type: 'engineering-card', generation: 1, id: 'create-1', action: 'create', original: 'yuki-link 这是新需求，还没 Ticket，只做设计' });
  const card = events.at(-1).card;
  assert.equal(card.content.resolution.status, 'explicit_new_requirement');
  assert.equal(card.content.ticket, null);
  await handle({ type: 'engineering-card', generation: 1, id: 'confirm-1', action: 'confirm', cardId: card.cardId, expectedRevision: 1 });
  assert.equal(events.at(-1).card.state, 'confirmed'); assert.equal(events.at(-1).card.dispatchStatus, 'not-dispatched');
  assert.equal(events.some(event => /dispatch|codex|run-start/iu.test(event.type)), false);
  await handle({ type: 'close', generation: 1 });
});

test('worker edit response wraps the persisted new revision for the renderer contract', async t => {
  const dir = await fixture(t), events = [], repo = 'Emilia-tan-Ovo/yuki-link';
  const source = { lookup: async (repository, n) => issue(repository, n, 'COMPANION-004') };
  const handle = createWorkerHandler({ post: event => events.push(event), createSession: () => new BackendSession({ directory: dir, mode: 'preview', issueSource: source }) });
  await handle({ type: 'start', generation: 1, preview: true });
  await handle({ type: 'engineering-card', generation: 1, id: 'create-edit-contract', action: 'create', original: '给 yuki-link 的 #129 只做设计' });
  const first = events.at(-1).card;
  await handle({ type: 'engineering-card', generation: 1, id: 'edit-contract', action: 'edit', cardId: first.cardId, expectedRevision: first.revision,
    fields: { original: first.content.original, summary: '继续设计', project: 'yuki-link', ticket: '#129', noTicket: false, desiredPhase: 'ticket-design', endpoint: 'design-only' } });
  const edited = events.at(-1);
  assert.equal(edited.action, 'edit'); assert.equal(edited.card.cardId, first.cardId); assert.equal(edited.card.revision, 2);
  assert.equal(edited.card.content.ticket.number, 129); assert.equal(edited.card.dispatchStatus, 'not-dispatched');
  await handle({ type: 'close', generation: 1 });
});
test('target changes invalidate old workflow and late observation cannot attach to new target', async t => {
  const store = new EngineeringCardStore(await fixture(t));
  const content = { original: '做 #129', projectKey: 'yuki-link', repository: 'Emilia-tan-Ovo/yuki-link', ticket: issue('Emilia-tan-Ovo/yuki-link',129), resolution: {status:'verified_existing'}, desiredPhase:'implementation', endpoint:'to-pr', extraAuthorization:{merge:false,deploy:false} };
  const first = store.create(content);
  store.observe(first.cardId,{phase:'review'},content.ticket.url);
  const next = store.edit(first.cardId,1,{...content,ticket:issue('Emilia-tan-Ovo/yuki-link',130)});
  assert.equal(next.observedWorkflow,null);
  assert.equal(store.observe(first.cardId,{phase:'review'},content.ticket.url).observedWorkflow,null);
  store.close();
});

test('public GitHub adapter validates canonical issue and treats unavailable search as unavailable', async () => {
  const requests = [];
  const source = githubIssueSource({ fetchImpl: async url => { requests.push(url); return {ok:true,json:async () => url.includes('/search/') ? {total_count:1,items:[{number:129,title:'COMPANION-004',html_url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129',repository_url:'https://api.github.com/repos/Emilia-tan-Ovo/yuki-link'}]} : {number:129,title:'COMPANION-004',html_url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'} }; } });
  assert.equal((await source.lookup('Emilia-tan-Ovo/yuki-link',129)).number,129);
  assert.equal((await source.search('Emilia-tan-Ovo/yuki-link','004'))[0].number,129);
  assert.match(requests[0],/^https:\/\/api.github.com\/repos\/Emilia-tan-Ovo\/yuki-link\/issues\/129$/);
  await assert.rejects(githubIssueSource({fetchImpl:async () => { throw Error('offline'); }}).search('Emilia-tan-Ovo/yuki-link','004'));
  assert.equal(await githubIssueSource({fetchImpl:async () => ({status:404,ok:false})}).lookup('Emilia-tan-Ovo/yuki-link',129),null);
});

test('Desktop worker default runtime resolves an existing public Ticket through its read-only source', async t => {
  const originalFetch = globalThis.fetch, requests = [], events = [];
  globalThis.fetch = async url => { requests.push(url); return {ok:true,json:async () => ({number:129,title:'COMPANION-004',html_url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'})}; };
  t.after(() => { globalThis.fetch = originalFetch; });
  const handle = createWorkerHandler({post:event => events.push(event)});
  await handle({type:'start',generation:1,preview:true,directory:await fixture(t)});
  await handle({type:'engineering-card',generation:1,id:'card-request',action:'create',original:'给 yuki-link 的 #129 只做设计'});
  assert.equal(events.at(-1).card.content.resolution.status,'verified_existing');
  assert.equal(events.at(-1).card.content.ticket.url,'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129');
  assert.equal(events.at(-1).card.observedWorkflow?.assessment,'source_unavailable');
  assert.equal(requests.length,1);
  await handle({type:'close',generation:1});
});

test('explicit merge and deploy requests remain separate and require clear targets', async t => {
  const store = new EngineeringCardStore(await fixture(t));
  const cards = new EngineeringCards({store,projects,issueSource:{lookup:async () => issue('Emilia-tan-Ovo/yuki-link',129)}});
  const pending = await cards.create('给 yuki-link 的 #129 做到 PR，包含合并和部署');
  assert.equal(pending.content.extraAuthorization.merge.requested,true);
  assert.equal(pending.content.extraAuthorization.deploy.requested,true);
  assert.equal(cards.confirm(pending.cardId,1,'desktop-user-action').invalid,true);
  const unclear = await cards.edit(pending.cardId,1,{project:'yuki-link',ticket:'#129',summary:'完成',desiredPhase:'implementation',endpoint:'to-pr',mergeRequested:true,mergeTarget:'稍后那个 PR',deployRequested:true,deployTarget:'staging'});
  assert.equal(cards.confirm(unclear.cardId,2,'desktop-user-action').invalid,true);
  const edited = await cards.edit(pending.cardId,2,{project:'yuki-link',ticket:'#129',summary:'完成',desiredPhase:'implementation',endpoint:'to-pr',mergeRequested:true,mergeTarget:'PR #147',deployRequested:true,deployTarget:'staging'});
  assert.equal(cards.confirm(edited.cardId,3,'desktop-user-action').confirmation.content.extraAuthorization.deploy.target,'staging');
  store.close();
});

test('a merge PR reference does not replace the target Ticket reference', () => {
  const candidate = localCandidate('合并 PR #147，给 yuki-link 的 #129 做到 PR');
  assert.equal(candidate.ticket,'#129');
  assert.equal(candidate.extraAuthorization.merge.target,'PR #147');
});

test('reopened verified card focus resolves shorthand through GitHub lookup even with competing routes', async t => {
  const dir = await fixture(t), store = new EngineeringCardStore(dir);
  const cards = new EngineeringCards({store,issueSource:{lookup:async (repo,n) => issue(repo,n,'COMPANION-004'),search:async repo => [issue(repo,129,'COMPANION-004'),issue(repo,120,'ORCH-004')]}});
  const first = await cards.create('给 yuki-link 的 #129 做到 PR');
  store.confirm(first.cardId,1,'desktop-user-action');
  store.close();
  const reopened = new EngineeringCardStore(dir), calls=[];
  const resumed = new EngineeringCards({store:reopened,issueSource:{lookup:async (repo,n) => {calls.push(n);return issue(repo,n,'COMPANION-004');},search:async repo => [issue(repo,129,'COMPANION-004'),issue(repo,120,'ORCH-004')]}});
  const card = await resumed.create('继续004');
  assert.equal(first.content.resolution.status,'verified_existing');
  assert.deepEqual(calls,[129]); assert.equal(card.content.ticket.number,129);
  assert.equal(card.content.resolution.status,'verified_existing'); assert.equal(card.dispatchStatus,'not-dispatched');
  reopened.close();
});

test('ORCH focus stays on ORCH and no focus with multiple 004 candidates stays ambiguous', async () => {
  const source={lookup:async(repo,n)=>issue(repo,n,n===120?'ORCH-004':'COMPANION-004'),search:async repo=>[issue(repo,120,'ORCH-004'),issue(repo,129,'COMPANION-004')]};
  const focused=await resolveTarget({ticket:'004'},{issueSource:source,focus:{projectKey:'yuki-link',ticket:issue('Emilia-tan-Ovo/yuki-link',120,'ORCH-004')}});
  assert.equal(focused.ticket.number,120);
  const ambiguous=await resolveTarget({ticket:'004'},{issueSource:source});
  assert.equal(ambiguous.resolution.status,'ambiguous'); assert.equal(ambiguous.candidates.length,2);
});

test('selecting an ambiguous candidate edits the same card and verifies GitHub', async t => {
  const store=new EngineeringCardStore(await fixture(t));
  const source={lookup:async(repo,n)=>issue(repo,n,n===129?'COMPANION-004':'ORCH-004'),search:async repo=>[issue(repo,120,'ORCH-004'),issue(repo,129,'COMPANION-004')]};
  const cards=new EngineeringCards({store,issueSource:source});
  const pending=await cards.create('继续004'); assert.equal(pending.content.resolution.status,'ambiguous');
  const chosen=await cards.edit(pending.cardId,1,{project:'yuki-link',ticket:'#129',summary:pending.content.summary,desiredPhase:'implementation',endpoint:'to-pr'});
  assert.equal(chosen.cardId,pending.cardId); assert.equal(chosen.revision,2);
  assert.equal(chosen.content.ticket.number,129); assert.equal(chosen.content.resolution.status,'verified_existing');
  assert.equal(chosen.dispatchStatus,'not-dispatched'); store.close();
});

test('Harness candidates use only validated loopback URL, root cookie and canonical references', async () => {
  const calls=[];
  const source=harnessCandidateSource({url:'http://127.0.0.1:4321/',fetchImpl:async (url,options)=>{calls.push([url,options]);return url.endsWith('/')?{ok:true,headers:{get:()=> 'yuki_harness=opaque; HttpOnly; Path=/'},body:null}:{ok:true,json:async()=>({projects:[{key:'yuki-link',tickets:[{key:'COMPANION-004',title:'COMPANION-004',reference:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'}]}]})};}});
  assert.equal((await source.search('Emilia-tan-Ovo/yuki-link','004'))[0].number,129);
  assert.equal(calls[1][1].headers.Cookie,'yuki_harness=opaque');
  assert.equal(calls.every(([,options])=>options.redirect==='error' && options.signal),true);
  for(const url of ['https://127.0.0.1:4321/','http://localhost:4321/','http://user:pass@127.0.0.1:4321/','http://127.0.0.1:4321/other','http://127.0.0.1:4321/?x=1']) assert.equal(harnessCandidateSource({url}),null);
  await assert.rejects(harnessCandidateSource({url:'http://127.0.0.1:4321/',fetchImpl:async()=>({ok:true,redirected:true})}).search('Emilia-tan-Ovo/yuki-link','004'));
});

test('unavailable Harness hint does not block explicit GitHub ticket verification', async () => {
  const resolved=await resolveTarget({project:'yuki-link',ticket:'#129'},{issueSource:{lookup:async(repo,n)=>issue(repo,n)},candidateSources:[{search:async()=>{throw Error('offline');}}]});
  assert.equal(resolved.resolution.status,'verified_existing');
});

test('recent cards alone cannot silently choose among conflicting 004 routes', async t => {
  const store=new EngineeringCardStore(await fixture(t));
  const repo='Emilia-tan-Ovo/yuki-link';
  for(const [n,title] of [[120,'ORCH-004'],[129,'COMPANION-004']]) store.create({original:`处理 ${title}`,repository:repo,projectKey:'yuki-link',ticket:issue(repo,n,title),resolution:{status:'verified_existing'}});
  const source={lookup:async(r,n)=>issue(r,n,n===120?'ORCH-004':'COMPANION-004'),search:async r=>[issue(r,120,'ORCH-004'),issue(r,129,'COMPANION-004')]};
  const card=await new EngineeringCards({store,issueSource:source}).create('继续004');
  assert.equal(card.content.resolution.status,'ambiguous'); assert.equal(card.content.candidates.length,2); store.close();
});

test('candidate source outage keeps shorthand conservative when GitHub finds only one candidate', async () => {
  const repo='Emilia-tan-Ovo/yuki-link';
  const resolved=await resolveTarget({ticket:'004'},{issueSource:{search:async()=>[issue(repo,129)],lookup:async()=>issue(repo,129)},candidateSources:[{search:async()=>{throw Error('offline');}}]});
  assert.equal(resolved.resolution.status,'ambiguous');
});

test('default worker accepts saved workbench URL and explicit env seam without fixed port', async t => {
  const previous=process.env.YUKI_HARNESS_URL, requests=[], events=[];
  process.env.YUKI_HARNESS_URL='http://127.0.0.1:4322/';
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{requests.push(url); if(url.endsWith('/')) return {ok:true,headers:{get:()=> 'yuki_harness=opaque; Path=/'},body:null}; if(url.endsWith('/api/projects')) return {ok:true,json:async()=>({projects:[{key:'yuki-link',tickets:[{key:'COMPANION-004',title:'COMPANION-004',reference:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'}]}]})}; if(url.includes('/search/issues')) return {ok:true,json:async()=>({total_count:1,items:[{number:129,title:'COMPANION-004',html_url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129',repository_url:'https://api.github.com/repos/Emilia-tan-Ovo/yuki-link'}]})}; return {ok:true,json:async()=>({number:129,title:'COMPANION-004',html_url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'})};};
  t.after(()=>{globalThis.fetch=originalFetch;if(previous===undefined) delete process.env.YUKI_HARNESS_URL; else process.env.YUKI_HARNESS_URL=previous;});
  const handle=createWorkerHandler({post:event=>events.push(event)});
  await handle({type:'start',generation:1,preview:true,directory:await fixture(t),workbenchUrl:'http://127.0.0.1:4321/'});
  await handle({type:'engineering-card',generation:1,id:'one',action:'create',original:'继续004'});
  assert.equal(events.at(-1).card.content.resolution.status,'verified_existing');
  assert.equal(requests.some(url=>url.startsWith('http://127.0.0.1:4321/')),true);
  await handle({type:'candidate-source-configure',generation:1,workbenchUrl:''});
  await handle({type:'engineering-card',generation:1,id:'two',action:'create',original:'继续 COMPANION-004'});
  assert.equal(requests.some(url=>url.startsWith('http://127.0.0.1:4322/')),true);
  await handle({type:'close',generation:1});
});
