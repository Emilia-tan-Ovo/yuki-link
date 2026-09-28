import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EngineeringCardStore, preparationAuthorized } from '../../../companion-desktop/backend/engineering-card-store.mjs';
import { WorkflowAgentLauncher } from './workflow-agent-launcher.ts';
import { MarkdownContextDocumentAdapter } from './document-adapter.ts';

const hash = value => createHash('sha256').update(value).digest('hex');

const identity = (repository, item) => item && Number.isSafeInteger(item.id) && item.id > 0
  && Number.isSafeInteger(item.number) && item.number > 0
  && item.repository === repository && item.url === `https://github.com/${repository}/issues/${item.number}`
  && typeof item.body === 'string' && typeof item.creator === 'string' && item.creator.length > 0;

// The authenticated YCA process owns the write transport. Tests supply a transport
// with the same public methods, never a second issue-creation implementation.
export class GhPreparationTransport {
  api(args) {
    return JSON.parse(execFileSync('gh', ['api', ...args], { encoding:'utf8', windowsHide:true,
      shell:false, timeout:20_000, maxBuffer:2 * 1024 * 1024 }));
  }
  canonical(repository, item) { return item && !item.pull_request ? {
    repository, id:item.id, number:item.number, url:item.html_url, title:item.title,
    body:item.body, creator:item.user?.login } : null; }
  async authenticatedActor() { return this.api(['user']).login; }
  async create(repository,title,body) {
    return this.canonical(repository,this.api(['-X','POST',`repos/${repository}/issues`,
      '-f',`title=${title}`,'-f',`body=${body}`]));
  }
  async read(repository,number) { return this.canonical(repository,this.api([`repos/${repository}/issues/${number}`])); }
  async findByMarker(repository,marker) {
    const result = this.api(['-X','GET','search/issues','-f',`q=repo:${repository} is:issue "${marker}"`,'-f','per_page=100']);
    if (result.incomplete_results || result.total_count > result.items?.length) throw Error('ISSUE_SEARCH_INCOMPLETE');
    return Promise.all((result.items ?? []).filter(item => !item.pull_request).map(item => this.read(repository,item.number)));
  }
  async update(repository,number,body) {
    return this.canonical(repository,this.api(['-X','PATCH',`repos/${repository}/issues/${number}`,'-f',`body=${body}`]));
  }
}

export class GitHubPreparationIssues {
  constructor(transport = new GhPreparationTransport()) { this.transport = transport; }
  async preflight() {
    const actor = await this.transport.authenticatedActor();
    if (typeof actor !== 'string' || !actor.trim()) throw Error('PREPARATION_GITHUB_AUTH_UNAVAILABLE');
    return actor;
  }
  markerLine({marker,payloadDigest}) { return `<!-- ${marker}:${payloadDigest} -->`; }
  valid(issue,{repository,marker,payloadDigest},actor) {
    return identity(repository,issue) && issue.creator === actor
      && issue.body.includes(this.markerLine({marker,payloadDigest}));
  }
  async create(request) {
    const actor = await this.transport.authenticatedActor();
    if (!actor || !request.title?.trim() || !request.repository || !request.marker || !/^[0-9a-f]{64}$/u.test(request.payloadDigest)) throw Error('ISSUE_CREATE_INPUT_INVALID');
    const body = `${request.body}\n\n${this.markerLine(request)}`;
    const issue = await this.transport.create(request.repository,request.title,body);
    if (!this.valid(issue,request,actor)) throw Error('ISSUE_CREATE_RECEIPT_UNKNOWN');
    const reread = await this.transport.read(request.repository,issue.number);
    if (!this.valid(reread,request,actor) || reread.id !== issue.id) throw Error('ISSUE_CREATE_RECEIPT_UNKNOWN');
    return reread;
  }
  async reconcile(request) {
    const actor = await this.transport.authenticatedActor();
    if (!actor) return null;
    const candidates = await this.transport.findByMarker(request.repository,request.marker);
    const valid = [];
    for (const candidate of candidates) {
      if (!identity(request.repository,candidate)) continue;
      const observed = await this.transport.read(request.repository,candidate.number);
      if (observed?.id === candidate.id && this.valid(observed,request,actor)) valid.push(observed);
    }
    return valid.length === 1 ? valid[0] : null;
  }
  async verify(bound,request) {
    const actor = await this.transport.authenticatedActor();
    const issue = await this.transport.read(request.repository,bound.number);
    return issue?.id === bound.id && this.valid(issue,request,actor)
      && issue.body.split('\n\n<!-- yuki-design-mirror:start -->\n')[0] === bound.body ? issue : null;
  }
  async publishMirror(bound,request,notes,digest) {
    const actor = await this.transport.authenticatedActor();
    const current = await this.transport.read(request.repository,bound.number);
    if (current?.id !== bound.id || !this.valid(current,request,actor)) throw Error('DESIGN_ISSUE_IDENTITY_CONFLICT');
    const start = '\n\n<!-- yuki-design-mirror:start -->\n';
    const end = '\n<!-- yuki-design-mirror:end -->';
    const base = current.body.split(start)[0];
    if (base !== bound.body) throw Error('DESIGN_PRODUCT_SCOPE_CHANGED');
    const body = `${base}${start}sha256:${digest}\n${notes}${end}`;
    if (current.body !== body) await this.transport.update(request.repository,bound.number,body);
    const verified = await this.transport.read(request.repository,bound.number);
    if (verified?.id !== bound.id || verified.body !== body
      || !this.valid(verified,request,actor)) throw Error('DESIGN_MIRROR_OUTCOME_UNKNOWN');
    return {issueId:verified.id,digest,bodyDigest:hash(body)};
  }
  async verifyMirror(bound,request,digest,notes = null) {
    const actor = await this.transport.authenticatedActor();
    const current = await this.transport.read(request.repository,bound.number);
    if (current?.id !== bound.id || !this.valid(current,request,actor)
      || current.body.split('\n\n<!-- yuki-design-mirror:start -->\n')[0] !== bound.body
      || !current.body.includes(`<!-- yuki-design-mirror:start -->\nsha256:${digest}\n`)) return false;
    if (notes !== null && current.body !== `${bound.body}\n\n<!-- yuki-design-mirror:start -->\nsha256:${digest}\n${notes}\n<!-- yuki-design-mirror:end -->`)
      return false;
    return true;
  }
}

const samePath = (left,right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

export class GitPreparationWorktree {
  constructor(config) { this.config = config; }
  git(cwd,...args) { return execFileSync('git',['--no-optional-locks',...args],{
    cwd,encoding:'utf8',windowsHide:true,shell:false,timeout:10_000,maxBuffer:1024 * 1024 }).trim(); }
  repositoryIdentity() {
    const root = realpathSync(this.config.repositoryRoot);
    const remote = this.git(root,'remote','get-url','origin');
    if (![ `https://github.com/${this.config.repository}.git`,
      `https://github.com/${this.config.repository}`,
      `git@github.com:${this.config.repository}.git` ].includes(remote)) throw Error('PREPARATION_REPOSITORY_CONFLICT');
    const common = this.git(root,'rev-parse','--path-format=absolute','--git-common-dir');
    return { root, common:realpathSync(common) };
  }
  preflight() {
    if (!path.isAbsolute(this.config.worktreeRoot) || !this.config.baseRef?.startsWith('refs/heads/'))
      throw Error('PREPARATION_GIT_CONFIG_INVALID');
    const repository = this.repositoryIdentity();
    const expected = path.join(repository.root,'.local','worktrees');
    if (!samePath(this.config.worktreeRoot,expected)
      || [path.dirname(expected),expected].some(value => existsSync(value) && lstatSync(value).isSymbolicLink()))
      throw Error('PREPARATION_WORKTREE_ROOT_CONFLICT');
    const oid = this.git(repository.root,'rev-parse','--verify',`${this.config.baseRef}^{commit}`);
    if (!/^[0-9a-f]{40,64}$/u.test(oid)) throw Error('PREPARATION_BASE_UNAVAILABLE');
    return {repository,oid};
  }
  freeze(preparationId) {
    if (!/^[0-9a-f-]{36}$/u.test(preparationId) || !path.isAbsolute(this.config.worktreeRoot)
      || !this.config.baseRef?.startsWith('refs/heads/')) throw Error('PREPARATION_GIT_CONFIG_INVALID');
    const repository = this.repositoryIdentity();
    const oid = this.git(repository.root,'rev-parse','--verify',`${this.config.baseRef}^{commit}`);
    if (!/^[0-9a-f]{40,64}$/u.test(oid)) throw Error('PREPARATION_BASE_UNAVAILABLE');
    const root = path.resolve(this.config.worktreeRoot);
    const branch = `codex/prep-${preparationId}`;
    return { repository:this.config.repository, projectKey:this.config.projectKey,
      repositoryRoot:repository.root, repositoryCommon:repository.common,
      baseRef:this.config.baseRef, oid, branch, path:path.join(root,`prep-${preparationId}`), preparationId };
  }
  registry(root) {
    const entries = this.git(root,'worktree','list','--porcelain').split(/\r?\n\r?\n/u);
    return entries.map(entry => Object.fromEntries(entry.split(/\r?\n/u).map(line => {
      const at = line.indexOf(' '); return at < 0 ? [line,true] : [line.slice(0,at),line.slice(at+1)];
    }))).filter(entry => entry.worktree);
  }
  matchesFrozenWorktree(frozen) {
    try {
      const top = realpathSync(this.git(frozen.path,'rev-parse','--show-toplevel'));
      const common = realpathSync(this.git(frozen.path,'rev-parse','--path-format=absolute','--git-common-dir'));
      return samePath(top,realpathSync(frozen.path)) && samePath(common,frozen.repositoryCommon);
    } catch { return false; }
  }
  inspect(frozen) {
    try {
      const current = this.repositoryIdentity();
      if (frozen.repository !== this.config.repository || frozen.projectKey !== this.config.projectKey
        || frozen.baseRef !== this.config.baseRef || !samePath(current.root,frozen.repositoryRoot)
        || !samePath(current.common,frozen.repositoryCommon)
        || frozen.branch !== `codex/prep-${frozen.preparationId}`
        || !samePath(frozen.path,path.join(this.config.worktreeRoot,`prep-${frozen.preparationId}`))) return null;
      const entry = this.registry(current.root).find(value => samePath(value.worktree,frozen.path));
      if (!entry || entry.branch !== `refs/heads/${frozen.branch}` || entry.HEAD !== frozen.oid
        || !this.matchesFrozenWorktree(frozen)
        || !existsSync(frozen.path) || this.git(frozen.path,'rev-parse','HEAD') !== frozen.oid
        || this.git(frozen.path,'rev-parse','--abbrev-ref','HEAD') !== frozen.branch) return null;
      return {path:realpathSync(frozen.path),head:frozen.oid};
    } catch { return null; }
  }
  ensure(frozen) {
    const current = this.repositoryIdentity();
    if (frozen.repository !== this.config.repository || frozen.projectKey !== this.config.projectKey
      || frozen.baseRef !== this.config.baseRef || !samePath(current.root,frozen.repositoryRoot)
      || !samePath(current.common,frozen.repositoryCommon)
      || frozen.branch !== `codex/prep-${frozen.preparationId}`
      || !samePath(frozen.path,path.join(this.config.worktreeRoot,`prep-${frozen.preparationId}`)))
      throw Error('PREPARATION_GIT_IDENTITY_CONFLICT');
    const entries = this.registry(current.root);
    const occupied = entries.find(entry => entry.branch === `refs/heads/${frozen.branch}`);
    if (occupied && !samePath(occupied.worktree,frozen.path)) throw Error('PREPARATION_BRANCH_OCCUPIED');
    const registered = entries.find(entry => samePath(entry.worktree,frozen.path));
    if (registered && !this.matchesFrozenWorktree(frozen)) throw Error('PREPARATION_WORKTREE_CONFLICT');
    let branchOid = null;
    try { branchOid = this.git(current.root,'rev-parse','--verify',`refs/heads/${frozen.branch}^{commit}`); }
    catch { /* A branch can be absent after the freeze record was written. */ }
    if (branchOid && branchOid !== frozen.oid) throw Error('PREPARATION_BRANCH_CONFLICT');
    if (!branchOid) this.git(current.root,'branch',frozen.branch,frozen.oid);
    if (!registered) {
      if (existsSync(frozen.path)) throw Error('PREPARATION_PATH_OCCUPIED');
      mkdirSync(path.dirname(frozen.path),{recursive:true});
      if (!samePath(realpathSync(path.dirname(frozen.path)),path.dirname(frozen.path)))
        throw Error('PREPARATION_WORKTREE_ROOT_CONFLICT');
      this.git(current.root,'worktree','add',frozen.path,frozen.branch);
    } else if (registered.branch !== `refs/heads/${frozen.branch}` || registered.HEAD !== frozen.oid)
      throw Error('PREPARATION_WORKTREE_CONFLICT');
    const verified = this.registry(current.root).find(entry => samePath(entry.worktree,frozen.path));
    if (!verified || verified.branch !== `refs/heads/${frozen.branch}` || verified.HEAD !== frozen.oid
      || !this.matchesFrozenWorktree(frozen)
      || this.git(frozen.path,'rev-parse','HEAD') !== frozen.oid
      || this.git(frozen.path,'rev-parse','--abbrev-ref','HEAD') !== frozen.branch)
      throw Error('PREPARATION_WORKTREE_CONFLICT');
    return { ...frozen, path:realpathSync(frozen.path), head:frozen.oid };
  }
}

const checkpointText = (ticketKey,worktree,branch,oid,issueUrl) => `---\nschema_version: 1\nticket: ${JSON.stringify(`${ticketKey} / ${issueUrl}`)}\nphase: ticket-design\nworktree: ${JSON.stringify(worktree.replaceAll('\\','/'))}\nbranch: ${JSON.stringify(branch)}\nfixed_point: ${JSON.stringify(oid)}\nhead: ${JSON.stringify(oid)}\n---\n\nIssue: ${issueUrl}\n`;
const checkpointPath = (worktree,key) => path.join(worktree,'.local','workflow-state',`${key}.md`);
const checkpoint = (worktree,key,branch,oid,issueUrl) => {
  const target = checkpointPath(worktree,key), expected = checkpointText(key,worktree,branch,oid,issueUrl);
  if (existsSync(target)) {
    if (readFileSync(target,'utf8') !== expected) throw Error('PREPARATION_CHECKPOINT_CONFLICT');
  } else {
    mkdirSync(path.dirname(target),{recursive:true});
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary,expected,{encoding:'utf8',flag:'wx'});
    renameSync(temporary,target);
  }
  return { path:target, sha256:hash(readFileSync(target)) };
};

const initialWorkflow = (ticket,issue,worktree,checkpointReceipt,card) => {
  const at = new Date().toISOString(), oid = worktree.oid;
  return { phase:'ticket-design', actor:{name:'Emilia',method:'deterministic'},
    checkpoint:{artifact_id:'checkpoint',ticket_key:`${ticket.key} / ${issue.url}`,
      worktree:worktree.path,branch:worktree.branch,fixed_point:oid,head:oid,phase:'ticket-design',schema_version:1},
    subject:{subject_id:`preparation:${worktree.preparationId}`,fixed_point:oid,head:oid,
      scope:[],staged:[],unstaged:[],untracked:[],ticket_ref:issue.url,
      spec_ref:`card:${card.cardId}:${card.revision}`,standards:['AGENTS.md'],tests:[]},
    artifacts:[{artifact_id:'checkpoint',role:'checkpoint',kind:'file',location:checkpointReceipt.path,
      revision:checkpointReceipt.sha256,source_schema:'checkpoint-v1',source:'companion-preparation',
      observed_at:at,integrity:'observed'}],
    reviews:[],findings:[],acceptance:{acceptance_id:null,status:'not-recorded',
      actor:{name:'Emilia',method:'deterministic'},subject_ref:null,criteria:[],evidence:[],
      evidence_refs:[],execution_refs:[],applicability:'not-applicable',reason:'尚未验收'},
    closeout:{status:'pending',artifact_refs:[],evidence:[],applicability:'not-applicable',reason:'尚未收尾'},
    runtime_refs:[] };
};

export class CompanionPreparationService {
  constructor({directory,manager,projects = [],issues = new GitHubPreparationIssues(),
    gitFactory = config => new GitPreparationWorktree(config),launch = null}) {
    this.store = new EngineeringCardStore(directory);
    this.manager = manager; this.projects = projects; this.issues = issues;
    this.gitFactory = gitFactory; this.launch = launch;
  }
  close() { this.store.close(); }
  known(input) {
    if (input?.card_store_id !== this.store.storeId || !input.card_id || !Number.isSafeInteger(input.revision))
      throw Error('PREPARATION_CARD_IDENTITY_CONFLICT');
    const card = this.store.get(input.card_id);
    if (!card || card.revision !== input.revision) throw Error('PREPARATION_CARD_STALE');
    return card;
  }
  update(record,change) {
    const next = this.store.updatePreparation(record.preparationId,record.version,change);
    if (next.conflict) throw Error('PREPARATION_RECORD_CONFLICT');
    return next;
  }
  async blocked(input,code) {
    const receipt = await this.get(input);
    const state = receipt.unknown_side_effects.length ? 'unknown' : 'blocked';
    return {...receipt,configuration_blocker:code,
      preparation_for_ticket_design:{state,
        blockers:[code,...receipt.preparation_for_ticket_design.blockers]},
      next_action_readiness:{...receipt.next_action_readiness,state,
        blockers:[code,...receipt.next_action_readiness.blockers]}};
  }
  async get(input) {
    const card = this.known(input), record = this.store.preparation(card.cardId,card.revision);
    const blockers = [];
    if (!preparationAuthorized(card.content) || card.preparationStatus !== 'authorized')
      blockers.push('PREPARATION_AUTHORIZATION_MISSING');
    if (!record) blockers.push('PREPARATION_NOT_STARTED');
    else for (const key of ['issue','worktree','harness','workflow']) if (!record.bindings[key])
      blockers.push(`PREPARATION_${key.toUpperCase()}_MISSING`);
    if (record?.bindings.issue) {
      try {
        const verified = await this.issues.verify(record.bindings.issue,{repository:card.content.repository,
          marker:record.marker,payloadDigest:record.payloadDigest});
        if (!verified) blockers.push('PREPARATION_ISSUE_DRIFT');
      } catch { blockers.push('PREPARATION_ISSUE_UNKNOWN'); }
    }
    if (record?.bindings.worktree) {
      const config = this.projects.find(project => project.projectKey === card.content.projectKey
        && project.repository === card.content.repository);
      if (!config || !this.gitFactory(config).inspect(record.bindings.worktree))
        blockers.push('PREPARATION_WORKTREE_DRIFT');
    }
    if (record?.bindings.harness) {
      const ticket = this.manager.harness?.tickets?.get(record.bindings.harness.ticketId);
      if (!ticket || ticket.key !== record.bindings.harness.ticketKey
        || ticket.reference !== record.bindings.issue?.url || ticket.comparison_baseline_gap
        || ticket.comparison_baseline?.integrity !== 'complete'
        || ticket.comparison_baseline?.commit_oid !== record.bindings.worktree?.oid)
        blockers.push('PREPARATION_HARNESS_DRIFT');
    }
    if (record?.bindings.workflow) {
      const harness = this.manager.harness, ticket = harness?.tickets?.get(record.bindings.harness?.ticketId);
      const workflow = harness?.workflowHistory?.current.get(ticket?.id);
      try {
        if (!workflow || !ticket || workflow.workflow_revision !== (record.bindings.design?.workflowRevision
          ?? record.bindings.workflow.revision)
          || harness.workflowHistory.source.assess(ticket,workflow.snapshot).state !== 'verified')
          blockers.push('PREPARATION_WORKFLOW_DRIFT');
      } catch { blockers.push('PREPARATION_WORKFLOW_UNKNOWN'); }
    }
    if (record?.bindings.harness) {
      try {
        const policy = this.manager.workflowAgentAuthority.snapshot(
          record.bindings.harness.ticketKey,'ticket-design',
          `companion-preparation:${record.preparationId}`).policy;
        if (!policy || policy.project_key !== card.content.projectKey
          || policy.workflow_phase !== 'ticket-design'
          || policy.permission_selection !== 'owner-native-default')
          blockers.push('PREPARATION_DESIGN_POLICY_CONFLICT');
      } catch { blockers.push('PREPARATION_DESIGN_POLICY_UNKNOWN'); }
    }
    if (record?.unknownSideEffects.length) blockers.unshift('PREPARATION_UNKNOWN_SIDE_EFFECT');
    const preparationReady = blockers.length === 0 && record?.stepReceipts.launch?.state !== 'unknown';
    const design = record?.bindings.design;
    const designBlockers = [];
    if (!design) designBlockers.push('DESIGN_ARTIFACT_NOT_VERIFIED');
    else {
      const local = new MarkdownContextDocumentAdapter().read(record.bindings.worktree.path,
        design.notes.path,'implementation-notes');
      if (local.status !== 'observed' || local.digest !== `sha256:${design.notes.sha256}`)
        designBlockers.push('DESIGN_CANONICAL_NOTES_DRIFT');
      try {
        if (!await this.issues.verifyMirror(record.bindings.issue,{repository:card.content.repository,
          marker:record.marker,payloadDigest:record.payloadDigest},design.notes.sha256,
          local.status === 'observed' ? readFileSync(path.join(record.bindings.worktree.path,design.notes.path),'utf8') : null))
          designBlockers.push('DESIGN_MIRROR_DRIFT');
      } catch { designBlockers.push('DESIGN_MIRROR_UNKNOWN'); }
      let run = null;
      try {
        const operation = this.manager.harness?.executionOperations?.findByRequest(
          record.bindings.harness.ticketId,`companion-prep:${record.preparationId}:ticket-design`);
        run = operation?.runtime?.session_id && operation.runtime.run_id
          ? this.manager.harness.source.runs(operation.runtime.session_id)
            .find(value => value.id === operation.runtime.run_id) : null;
      } catch { designBlockers.push('DESIGN_RUN_UNKNOWN'); }
      if (run?.status !== 'completed') designBlockers.push('DESIGN_RUN_NOT_COMPLETED');
      const workflow = this.manager.harness?.workflowHistory?.current.get(record.bindings.harness.ticketId);
      if (!workflow || workflow.workflow_revision !== design.workflowRevision
        || this.manager.harness.workflowHistory.source.assess(
          this.manager.harness.tickets.get(record.bindings.harness.ticketId),workflow.snapshot).state !== 'verified')
        designBlockers.push('DESIGN_WORKFLOW_DRIFT');
    }
    if (record?.unknownSideEffects.length) designBlockers.unshift('PREPARATION_UNKNOWN_SIDE_EFFECT');
    const unknown = Boolean(record?.unknownSideEffects.length);
    const preparationUnknown = unknown || blockers.some(code => code.endsWith('_UNKNOWN'));
    const designUnknown = unknown || designBlockers.some(code => code.endsWith('_UNKNOWN'));
    const nextAction = preparationUnknown || design && designUnknown ? 'unknown'
      : design && designBlockers.length === 0 && card.content.endpoint === 'design-only'
        ? 'unsupported' : design ? designBlockers.length === 0 && preparationReady ? 'ready' : 'blocked'
          : preparationReady ? 'ready' : 'blocked';
    return { schema_version:1, card_store_id:this.store.storeId, card_id:card.cardId,
      revision:card.revision, preparation_id:record?.preparationId ?? null,
      preparation_for_ticket_design:{state:preparationReady ? 'ready' : preparationUnknown ? 'unknown' : 'blocked',blockers,
        source_refs:['card-sqlite','github-issue','git-worktree','harness-registration','harness-workflow','trusted-policy']},
      ticket_design_artifact:{state:designUnknown ? 'unknown' : designBlockers.length ? 'blocked' : 'ready',
        blockers:designBlockers,notes:design?.notes ?? null,
        source_refs:['codex-run','local-notes','github-issue-mirror','harness-workflow']},
      next_action_readiness:{action:design ? 'implementation' : 'ticket-design',state:nextAction,
        blockers:card.content.endpoint === 'design-only' && designBlockers.length === 0
          ? ['ENDPOINT_DESIGN_ONLY'] : [...blockers,...designBlockers],
        source_refs:['preparation-for-ticket-design','ticket-design-artifact','owner-endpoint']},
      unknown_side_effects:record?.unknownSideEffects ?? [],
      bindings:record?.bindings ?? null,step_receipts:record?.stepReceipts ?? {},
      source_refs:['card-sqlite','github-issue','git-worktree','harness-workflow','harness-execution-operations'],
      observed_at:new Date().toISOString() };
  }
  async prepare(input) {
    const card = this.known(input);
    if (card.preparationStatus !== 'authorized') return this.get(input);
    const config = this.projects.find(project => project.projectKey === card.content.projectKey
      && project.repository === card.content.repository);
    if (!config || !this.manager.harness || !this.manager.workflowAgentAuthority)
      return this.blocked(input,'PREPARATION_TRUSTED_CONFIG_UNAVAILABLE');
    const git = this.gitFactory(config);
    try {
      const roots = this.manager.allowedCwds;
      if (roots && !roots.some(root => {
        const relative = path.relative(root,config.worktreeRoot);
        return relative === '' || relative !== '..' && !relative.startsWith('..'+path.sep)
          && !path.isAbsolute(relative);
      })) throw Error('PREPARATION_WORKTREE_ROOT_NOT_ALLOWED');
      git.preflight();
      await this.issues.preflight();
      const policy = this.manager.workflowAgentAuthority.snapshot('ISSUE-0','ticket-design','').policy;
      if (policy?.project_key !== card.content.projectKey || policy.workflow_phase !== 'ticket-design'
        || policy.permission_selection !== 'owner-native-default') throw Error('PREPARATION_POLICY_UNAVAILABLE');
      this.manager.harness.executionGate('new-side-effect');
    } catch (error) { return this.blocked(input,error?.message ?? 'PREPARATION_PREFLIGHT_UNAVAILABLE'); }
    let record = this.store.preparation(card.cardId,card.revision);
    if (!record && this.manager.harness.source?.activeRuns?.().length)
      return this.blocked(input,'PREPARATION_MODEL_LINE_BUSY');
    if (!record) {
      const started = this.store.beginPreparation(card.cardId,card.revision,
        `yuki-preparation:${randomUUID()}`);
      if (started.conflict) return this.get(input);
      record = started;
    }
    if (record.payloadDigest !== hashStableCard(card.content) || record.confirmationAt !== card.confirmation?.confirmedAt)
      throw Error('PREPARATION_CARD_CHANGED');
    if (record.unknownSideEffects.some(item => !['github-issue-create','github-issue-mirror','ticket-design-launch'].includes(item))) return this.get(input);
    const request = {repository:card.content.repository,marker:record.marker,payloadDigest:record.payloadDigest,
      title:card.content.summary,body:card.content.original};
    let issue = record.bindings.issue;
    if (issue) {
      issue = await this.issues.verify(issue,request);
      if (!issue) return this.get(input);
    } else if (record.stepReceipts.issueCreate?.state === 'attempted') {
      issue = await this.issues.reconcile(request).catch(() => null);
      if (!issue) return this.get(input);
    } else {
      record = this.update(record,value => ({...value,
        stepReceipts:{...value.stepReceipts,issueCreate:{state:'attempted',at:new Date().toISOString()}},
        unknownSideEffects:['github-issue-create']}));
      try { issue = await this.issues.create(request); }
      catch { issue = await this.issues.reconcile(request).catch(() => null); }
      if (!issue) return this.get(input);
    }
    if (!record.bindings.issue) record = this.update(record,value => ({...value,
      bindings:{...value.bindings,issue},unknownSideEffects:[],
      stepReceipts:{...value.stepReceipts,issueCreate:{state:'verified',issueId:issue.id}} }));
    if (!record.bindings.worktree) record = this.update(record,value => ({...value,
      bindings:{...value.bindings,worktree:git.freeze(value.preparationId)}}));
    const worktree = git.ensure(record.bindings.worktree);
    const harness = this.manager.harness;
    const baseline = harness.changes.facts.capture(worktree.path,worktree.oid);
    if (baseline.integrity !== 'complete' || baseline.start_observation.integrity !== 'complete'
      || baseline.start_observation.head !== worktree.oid) return this.get(input);
    const ticketKey = `ISSUE-${issue.number}`;
    const registration = harness.register({project_key:card.content.projectKey,
      project_name:card.content.projectKey,ticket_key:ticketKey,title:issue.title,
      reference:issue.url,expected_worktree:worktree.path,fixed_point:worktree.oid});
    const ticket = harness.tickets.get(registration.ticket_id);
    if (!ticket?.comparison_baseline || ticket.comparison_baseline.integrity !== 'complete'
      || ticket.comparison_baseline_gap) throw Error('PREPARATION_BASELINE_CONFLICT');
    if (!record.bindings.harness) record = this.update(record,value => ({...value,
      bindings:{...value.bindings,harness:{ticketId:ticket.id,conversationId:ticket.main_conversation_id,
        ticketKey}},stepReceipts:{...value.stepReceipts,harness:{state:'verified'}}}));
    else if (record.bindings.harness.ticketId !== ticket.id) throw Error('PREPARATION_HARNESS_CONFLICT');
    if (this.store.registerContinuation(card.cardId,card.revision,'preparation',
      record.preparationId,ticket.id).conflict) throw Error('PREPARATION_CONTINUATION_CONFLICT');
    this.manager.companionContinuation?.wake({schema_version:1,card_store_id:this.store.storeId,
      card_id:card.cardId,revision:card.revision});
    const cp = checkpoint(worktree.path,ticketKey,worktree.branch,worktree.oid,issue.url);
    const snapshot = initialWorkflow(ticket,issue,worktree,cp,card);
    let workflow;
    if (record.bindings.workflow) {
      workflow = harness.workflowHistory.current.get(ticket.id);
      const designRecorded = !record.bindings.design && record.stepReceipts.mirror?.state === 'attempted'
        && workflow?.request_id === `companion-prep:${record.preparationId}:design-workflow`;
      if (!workflow || workflow.workflow_revision !== record.bindings.workflow.revision && !designRecorded
        || workflow.snapshot?.checkpoint?.artifact_id !== 'checkpoint'
        || !record.stepReceipts.launch
          && harness.workflowHistory.source.assess(ticket,workflow.snapshot).state !== 'verified')
        return this.get(input);
    } else {
      const saved = harness.workflowHistory.current.get(ticket.id);
      if (saved && saved.request_id === `companion-preparation:${record.preparationId}:workflow`
        && saved.snapshot?.checkpoint?.artifact_id === 'checkpoint') {
        workflow = saved;
      } else if (saved) throw Error('PREPARATION_WORKFLOW_CONFLICT');
      else {
        const receipt = harness.recordWorkflow({ticket_id:ticket.id,
          request_id:`companion-preparation:${record.preparationId}:workflow`,
          expected_revision:null,schema_version:1,snapshot});
        workflow = harness.workflowHistory.current.get(ticket.id);
        if (receipt.applicability?.state !== 'verified') return this.get(input);
      }
      if (!workflow || !record.stepReceipts.launch
        && harness.workflowHistory.source.assess(ticket,workflow.snapshot).state !== 'verified')
        return this.get(input);
    }
    if (!record.bindings.workflow) record = this.update(record,value => ({...value,
      bindings:{...value.bindings,workflow:{revision:workflow.workflow_revision,checkpoint:cp}},
      stepReceipts:{...value.stepReceipts,workflow:{state:'verified'}}}));
    const launchReceipt = record.stepReceipts.launch;
    if (launchReceipt) {
      if (launchReceipt.state === 'attempted') {
        const operation = harness.executionOperations.findByRequest(ticket.id,launchReceipt.requestId);
        if (operation?.companion_dispatch?.dispatch_id === record.preparationId) {
          const observed = harness.executionOperations.reconcile(operation.operation_id);
          if (observed?.runtime?.run_id) record = this.update(record,value => ({...value,
            unknownSideEffects:value.unknownSideEffects.filter(item => item !== 'ticket-design-launch'),
            stepReceipts:{...value.stepReceipts,launch:{state:'accepted',requestId:launchReceipt.requestId,
              operationId:operation.operation_id}}}));
        }
      }
      return this.finalizeDesign(input,record,issue,worktree,workflow);
    }
    const policy = this.manager.workflowAgentAuthority.snapshot(ticketKey,'ticket-design',
      `companion-preparation:${record.preparationId}`).policy;
    if (policy?.project_key !== card.content.projectKey || policy.workflow_phase !== 'ticket-design'
      || policy.permission_selection !== 'owner-native-default') return this.get(input);
    const raw = harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    if (raw.completeness !== 'complete' || !raw.digest) return this.get(input);
    const contentIdentity = {scheme:raw.scheme,version:raw.version,scope:raw.scope,
      completeness:raw.completeness,digest:raw.digest};
    const authorizationRef = `companion-preparation:${record.preparationId}`;
    const launcherInput = {schema_version:1,action:'ticket-design',ticket_id:ticket.id,
      request_id:`companion-prep:${record.preparationId}:ticket-design`,authorization_ref:authorizationRef,
      expected:{workflow_revision:workflow.workflow_revision,subject_ref:snapshot.subject.subject_id,
        subject_identity:null,content_identity:contentIdentity,policy:{policy_id:policy.policy_id,
          revision:policy.revision,digest:policy.digest}},references:[issue.url],current_delta:[]};
    mkdirSync(path.join(worktree.path,'.local','workflow-artifacts','ticket-design'),{recursive:true});
    record = this.update(record,value => ({...value,
      stepReceipts:{...value.stepReceipts,launch:{state:'attempted',requestId:launcherInput.request_id}},
      unknownSideEffects:['ticket-design-launch']}));
    try {
      const launcher = this.launch ?? new WorkflowAgentLauncher({manager:this.manager,harness,
        workflowAuthority:this.authority(input,record,issue,policy,snapshot)});
      const result = await launcher.start(launcherInput);
      record = this.update(record,value => ({...value,unknownSideEffects:[],
        stepReceipts:{...value.stepReceipts,launch:{state:'accepted',operationId:result.operation_id ?? null,
          requestId:launcherInput.request_id}}}));
    } catch { /* The operation may have reserved or spawned. Reconcile by request ID; never launch again. */ }
    return this.get(input);
  }
  async finalizeDesign(input,record,issue,worktree,workflow) {
    if (record.bindings.design) return this.get(input);
    const operation = this.manager.harness.executionOperations.findByRequest(record.bindings.harness.ticketId,
      `companion-prep:${record.preparationId}:ticket-design`);
    const run = operation?.runtime?.session_id && operation.runtime.run_id
      ? this.manager.harness.source.runs(operation.runtime.session_id)
        .find(value => value.id === operation.runtime.run_id) : null;
    const designRecorded = record.stepReceipts.mirror?.state === 'attempted'
      && workflow.request_id === `companion-prep:${record.preparationId}:design-workflow`;
    if (run?.status !== 'completed'
      || workflow.workflow_revision !== record.bindings.workflow.revision && !designRecorded)
      return this.get(input);
    const ticketKey = record.bindings.harness.ticketKey;
    const relative = `docs/implementation-notes/${ticketKey}.md`;
    const absolute = path.join(worktree.path,relative);
    const document = new MarkdownContextDocumentAdapter().read(worktree.path,relative,'implementation-notes');
    if (document.status !== 'observed' || !document.context_plan?.core?.length) return this.get(input);
    const content = readFileSync(absolute,'utf8');
    if (hash(content) !== document.digest.slice(7)) return this.get(input);
    if (!record.stepReceipts.localNotes) {
      const temporary = `${absolute}.${randomUUID()}.tmp`;
      writeFileSync(temporary,content,{encoding:'utf8',flag:'wx'}); renameSync(temporary,absolute);
      if (hash(readFileSync(absolute)) !== document.digest.slice(7)) return this.get(input);
      record = this.update(record,value => ({...value,stepReceipts:{...value.stepReceipts,
        localNotes:{state:'verified',digest:document.digest.slice(7)}}}));
    } else if (record.stepReceipts.localNotes.digest !== document.digest.slice(7)) return this.get(input);
    const request = {repository:this.known(input).content.repository,marker:record.marker,
      payloadDigest:record.payloadDigest};
    let mirror;
    if (record.stepReceipts.mirror?.state === 'attempted') {
      const valid = await this.issues.verifyMirror(record.bindings.issue,request,
        document.digest.slice(7),content).catch(() => false);
      if (!valid) return this.get(input);
      mirror = {issueId:record.bindings.issue.id,digest:document.digest.slice(7)};
    } else {
      record = this.update(record,value => ({...value,
        stepReceipts:{...value.stepReceipts,mirror:{state:'attempted',digest:document.digest.slice(7)}},
        unknownSideEffects:['github-issue-mirror']}));
      try { mirror = await this.issues.publishMirror(record.bindings.issue,request,content,document.digest.slice(7)); }
      catch { return this.get(input); }
    }
    const harness = this.manager.harness;
    const ticket = harness.tickets.get(record.bindings.harness.ticketId);
    const current = harness.workflowHistory.current.get(ticket.id);
    let designWorkflow;
    const requestId = `companion-prep:${record.preparationId}:design-workflow`;
    if (current?.request_id === requestId) designWorkflow = current;
    else {
      if (!current || current.workflow_revision !== workflow.workflow_revision) return this.get(input);
      const snapshot = structuredClone(current.snapshot);
      snapshot.artifacts.push({artifact_id:'implementation-notes',role:'implementation-notes',
        kind:'file',location:absolute,revision:document.digest.slice(7),source_schema:'context-plan-v0',
        source:'companion-preparation',observed_at:new Date().toISOString(),integrity:'observed'});
      const saved = harness.recordWorkflow({ticket_id:ticket.id,request_id:requestId,
        expected_revision:current.workflow_revision,schema_version:1,snapshot});
      if (saved.applicability?.state !== 'verified') return this.get(input);
      designWorkflow = harness.workflowHistory.current.get(ticket.id);
    }
    if (!designWorkflow || harness.workflowHistory.source.assess(ticket,designWorkflow.snapshot).state !== 'verified')
      return this.get(input);
    record = this.update(record,value => ({...value,
      bindings:{...value.bindings,design:{notes:{path:relative,sha256:document.digest.slice(7)},
        mirror,workflowRevision:designWorkflow.workflow_revision,runId:run.id}},unknownSideEffects:[],
      stepReceipts:{...value.stepReceipts,mirror:{state:'verified',digest:document.digest.slice(7)}}}));
    return this.get(input);
  }
  authority(input,record,issue,policy,snapshot) {
    const service = this;
    return {snapshot(ticketKey,action,authorizationRef) {
      const card = service.known(input), current = service.store.preparation(card.cardId,card.revision);
      if (!current || card.preparationStatus !== 'authorized' || current.payloadDigest !== record.payloadDigest
        || current.bindings.issue?.id !== issue.id || current.bindings.harness?.ticketKey !== ticketKey
        || current.unknownSideEffects.some(item => item !== 'ticket-design-launch')
        || action !== 'ticket-design' || authorizationRef !== `companion-preparation:${record.preparationId}`)
        throw Error('PREPARATION_AUTHORITY_CONFLICT');
      const active = service.manager.workflowAgentAuthority.snapshot(ticketKey,action,authorizationRef).policy;
      if (active.digest !== policy.digest) throw Error('PREPARATION_POLICY_CHANGED');
      return {policy,authorization:{schema_version:1,authorization_id:authorizationRef,ticket_key:ticketKey,
        action:'ticket-design',authorization_ref:authorizationRef,
        subject_ref:snapshot.subject.subject_id,subject_identity:null,authority_refs:[issue.url,authorizationRef]},
        source:{schema_version:1,kind:'adapter',reference:authorizationRef,canonical_path:null,
          sha256:hash(`${record.payloadDigest}:${policy.digest}:${issue.id}`)},
        companion:{schema_version:1,card_store_id:service.store.storeId,card_id:card.cardId,
          revision:card.revision,dispatch_id:record.preparationId,content_digest:record.payloadDigest,
          confirmation_at:record.confirmationAt,ticket_scope_digest:hash(`${issue.id}:${issue.body}`),
          product_endpoint:card.content.endpoint,action:'ticket-design',policy_digest:policy.digest},
        confirmed_request:card.content.original,
        companion_result_path:path.join(current.bindings.worktree.path,'.local','workflow-artifacts',
          'ticket-design','result.json')};
    }};
  }
}

function hashStableCard(content) {
  const stable = value => Array.isArray(value) ? '['+value.map(stable).join(',')+']'
    : value && typeof value === 'object' ? '{'+Object.keys(value).sort().map(key => JSON.stringify(key)+':'+stable(value[key])).join(',')+'}'
      : JSON.stringify(value);
  return hash(stable(content));
}
