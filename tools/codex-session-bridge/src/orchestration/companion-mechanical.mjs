import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const git=(cwd,...args)=>execFileSync('git',['--no-optional-locks','-c','core.hooksPath=',...args],
  {cwd,encoding:'utf8',windowsHide:true,shell:false,timeout:30_000,maxBuffer:1024*1024}).trim();
const pathAllowed=value=>typeof value==='string' && /^[A-Za-z0-9_./-]{1,240}$/u.test(value)
  && !value.startsWith('/') && !value.includes('..') && !value.startsWith('.local/')
  && !value.startsWith('.git/');

// Mechanical results are bound to exact Git content. A lost task/commit/push receipt
// blocks the next action until its original immutable identity is reconciled.
export class CompanionMechanicalAdapter {
  constructor({store,computer}) { this.store=store; this.computer=computer; }
  changed(cwd) {
    const records=git(cwd,'status','--porcelain=v1','-z','--untracked-files=all').split('\0');
    const files=[];
    for (let i=0;i<records.length;i++) {
      const row=records[i]; if (!row) continue;
      const code=row.slice(0,2),file=row.slice(3).replaceAll('\\','/');
      if (code.includes('R') || code.includes('C')) i++;
      if (!pathAllowed(file)) throw fail('COMPANION_GIT_PATH_UNTRUSTED');
      files.push(file);
    }
    return [...new Set(files)].sort();
  }
  content(cwd,files) {
    return files.map(file=>{
      const full=path.join(cwd,file);
      if (!existsSync(full)) return {path:file,sha256:null};
      const stat=lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>10*1024*1024
        || !realpathSync(full).startsWith(realpathSync(cwd)+path.sep))
        throw fail('COMPANION_GIT_FILE_UNTRUSTED');
      return {path:file,sha256:hash(readFileSync(full))};
    });
  }
  suiteScript() {
    return "& npm --prefix tools/codex-session-bridge test\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n& npm --prefix tools/companion-desktop test\nexit $LASTEXITCODE";
  }
  async fullSuite(locator,ticket,subjectKey) {
    const slot=`full-suite:${subjectKey}`;
    const cwd=ticket.expected_worktree;
    const files=this.changed(cwd),content=this.content(cwd,files),head=git(cwd,'rev-parse','HEAD');
    const script=this.suiteScript();
    const requestId=`companion-task:${hash(`${locator.card_id}:${locator.revision}:${slot}`).slice(0,60)}`;
    const intent={schema_version:1,head,content,script_sha256:hash(script),request_id:requestId,
      ticket_id:ticket.id,cwd};
    const prior=this.store.continuationAction(locator.card_id,locator.revision,slot);
    if (prior && JSON.stringify(prior.intent)!==JSON.stringify(intent))
      throw fail('COMPANION_TEST_SUBJECT_CHANGED');
    const action=prior ?? this.store.claimContinuationAction(locator.card_id,locator.revision,slot,intent).action;
    if (!action) throw fail('COMPANION_TEST_INTENT_CONFLICT');
    if (action.attempt_state==='verified') return {state:'passed',...action.receipt};
    if (action.attempt_state==='unknown') return {state:'unknown',reason:'COMPANION_TEST_TASK_UNKNOWN'};
    if (action.attempt_state==='reserved') {
      if (!this.computer?.tasks) return {state:'blocked',reason:'COMPANION_OWNED_TASK_UNAVAILABLE'};
      const marked=this.store.updateContinuationAction(locator.card_id,locator.revision,slot,'reserved','attempted');
      if (marked.conflict) return {state:'unknown',reason:'COMPANION_TEST_TASK_CONFLICT'};
      try {
        const epoch=this.computer.tasks.status().service_epoch;
        const started=this.computer.tasks.start({service_epoch:epoch,request_id:requestId,
          cwd,script,timeout_ms:1_800_000,ticket_id:ticket.id},id=>{
            if (id!==ticket.id) throw fail('COMPANION_TEST_TICKET_CONFLICT');
          });
        this.store.updateContinuationAction(locator.card_id,locator.revision,slot,'attempted','attempted',
          {task_id:started.task_id,service_epoch:epoch});
      } catch { return {state:'unknown',reason:'COMPANION_TEST_TASK_START_UNKNOWN'}; }
    }
    const current=this.store.continuationAction(locator.card_id,locator.revision,slot);
    if (!current?.receipt?.task_id) return {state:'unknown',reason:'COMPANION_TEST_TASK_RECEIPT_UNKNOWN'};
    let task;
    try { task=this.computer.tasks.status({task_id:current.receipt.task_id}); }
    catch { return {state:'unknown',reason:'COMPANION_TEST_TASK_OBSERVATION_UNKNOWN'}; }
    if (!['completed','failed','stopped'].includes(task.status))
      return {state:task.status==='unknown' ? 'unknown':'waiting',reason:'COMPANION_TEST_TASK_ACTIVE',task_id:task.task_id};
    if (task.status!=='completed' || task.exit_code!==0)
      return {state:'blocked',reason:'COMPANION_FULL_SUITE_FAILED',task_id:task.task_id,
        exit_code:task.exit_code};
    if (git(cwd,'rev-parse','HEAD')!==head || JSON.stringify(this.content(cwd,files))!==JSON.stringify(content))
      return {state:'blocked',reason:'COMPANION_TEST_SUBJECT_CHANGED'};
    const receipt={task_id:task.task_id,exit_code:0,head,content_digest:hash(JSON.stringify(content))};
    this.store.updateContinuationAction(locator.card_id,locator.revision,slot,'attempted','verified',receipt);
    return {state:'passed',...receipt};
  }
  suiteReceipt(locator,subjectKey) {
    const action=this.store.continuationAction(locator.card_id,locator.revision,`full-suite:${subjectKey}`);
    return action?.attempt_state==='verified' && action.receipt?.exit_code===0
      ? {state:'passed',...action.receipt} : {state:'unknown'};
  }
  commit(locator,ticket,subjectKey,files,tests) {
    const slot=`commit:${subjectKey}`,cwd=ticket.expected_worktree;
    if (tests?.state!=='passed' || !Array.isArray(files) || !files.length
      || new Set(files).size!==files.length || files.some(value=>!pathAllowed(value)))
      throw fail('COMPANION_COMMIT_INPUT_INVALID');
    const prior=this.store.continuationAction(locator.card_id,locator.revision,slot);
    if (prior) {
      if (JSON.stringify([...files].sort())!==JSON.stringify(prior.intent.files))
        throw fail('COMPANION_COMMIT_INTENT_CONFLICT');
      return this.reconcileCommit(locator,ticket,subjectKey);
    }
    const observed=this.changed(cwd);
    if (JSON.stringify([...files].sort())!==JSON.stringify(observed))
      throw fail('COMPANION_COMMIT_SCOPE_CONFLICT');
    const parent=git(cwd,'rev-parse','HEAD'),content=this.content(cwd,observed);
    const intent={schema_version:1,parent,content,files:observed,
      tests:{task_id:tests.task_id,content_digest:tests.content_digest}};
    const claimed=this.store.claimContinuationAction(locator.card_id,locator.revision,slot,intent);
    if (claimed.conflict) throw fail('COMPANION_COMMIT_INTENT_CONFLICT');
    git(cwd,'add','--',...observed);
    const staged=git(cwd,'diff','--cached','--name-only').split(/\r?\n/u).filter(Boolean).sort();
    if (JSON.stringify(staged)!==JSON.stringify(observed)) throw fail('COMPANION_COMMIT_INDEX_CONFLICT');
    const tree=git(cwd,'write-tree');
    const marked=this.store.updateContinuationAction(locator.card_id,locator.revision,slot,'reserved','attempted',
      {tree,parent});
    if (marked.conflict) return {state:'unknown',reason:'COMPANION_COMMIT_ATTEMPT_CONFLICT'};
    try { git(cwd,'commit','--no-verify','-m',`feat: 完成 ${ticket.key} 的已验证实现`); }
    catch { /* Git may have advanced HEAD before its receipt was lost. */ }
    return this.reconcileCommit(locator,ticket,subjectKey);
  }
  reconcileCommit(locator,ticket,subjectKey) {
    const action=this.store.continuationAction(locator.card_id,locator.revision,`commit:${subjectKey}`);
    if (!action) return {state:'not-started'};
    const cwd=ticket.expected_worktree,head=git(cwd,'rev-parse','HEAD');
    if (action.attempt_state==='verified')
      return head===action.receipt?.oid ? {state:'committed',...action.receipt}
        : {state:'unknown',reason:'COMPANION_COMMIT_HEAD_DRIFT'};
    if (action.attempt_state==='reserved') return {state:'reserved'};
    let parent,tree;
    try { parent=git(cwd,'rev-parse','HEAD^'); tree=git(cwd,'rev-parse','HEAD^{tree}'); }
    catch { return {state:'unknown',reason:'COMPANION_COMMIT_OUTCOME_UNKNOWN'}; }
    if (parent!==action.intent.parent || tree!==action.receipt?.tree)
      return {state:'unknown',reason:'COMPANION_COMMIT_OUTCOME_UNKNOWN'};
    const receipt={oid:head,parent,tree};
    this.store.updateContinuationAction(locator.card_id,locator.revision,`commit:${subjectKey}`,
      action.attempt_state,'verified',receipt);
    return {state:'committed',...receipt};
  }
  push(locator,ticket,subjectKey,commit) {
    const slot=`push:${subjectKey}`,cwd=ticket.expected_worktree;
    if (commit?.state!=='committed') throw fail('COMPANION_PUSH_COMMIT_UNVERIFIED');
    const repository=/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/[1-9][0-9]*$/u
      .exec(ticket.reference)?.[1];
    const origin=git(cwd,'remote','get-url','origin');
    if (!repository || ![`https://github.com/${repository}`,
      `https://github.com/${repository}.git`,`git@github.com:${repository}.git`,
      `git@github.com:${repository}`].includes(origin)) throw fail('COMPANION_PUSH_REMOTE_CONFLICT');
    const branch=git(cwd,'rev-parse','--abbrev-ref','HEAD');
    if (!branch.startsWith('codex/') || git(cwd,'rev-parse','HEAD')!==commit.oid)
      throw fail('COMPANION_PUSH_BRANCH_CONFLICT');
    const ref=`refs/heads/${branch}`;
    const prior=this.store.continuationAction(locator.card_id,locator.revision,slot);
    if (prior) {
      if (prior.intent.oid!==commit.oid || prior.intent.ref!==ref || prior.intent.remote!=='origin')
        throw fail('COMPANION_PUSH_INTENT_CONFLICT');
      return this.reconcilePush(locator,ticket,subjectKey);
    }
    let remote;
    try { remote=git(cwd,'ls-remote','--heads','origin',ref).split(/\s+/u)[0] || null; }
    catch { return {state:'unknown',reason:'COMPANION_PUSH_REMOTE_UNKNOWN'}; }
    const intent={schema_version:1,remote:'origin',ref,oid:commit.oid,prior_remote_oid:remote};
    const claimed=this.store.claimContinuationAction(locator.card_id,locator.revision,slot,intent);
    if (claimed.conflict) throw fail('COMPANION_PUSH_INTENT_CONFLICT');
    if (remote===commit.oid) {
      this.store.updateContinuationAction(locator.card_id,locator.revision,slot,'reserved','verified',
        {remote_oid:remote,ref});
      return {state:'pushed',remote_oid:remote,ref};
    }
    const attempted=this.store.updateContinuationAction(locator.card_id,locator.revision,slot,'reserved','attempted');
    if (attempted.conflict) return {state:'unknown',reason:'COMPANION_PUSH_ATTEMPT_CONFLICT'};
    try { git(cwd,'push','origin',`HEAD:${ref}`); }
    catch { /* A network error may follow a successful push. */ }
    return this.reconcilePush(locator,ticket,subjectKey);
  }
  reconcilePush(locator,ticket,subjectKey) {
    const action=this.store.continuationAction(locator.card_id,locator.revision,`push:${subjectKey}`);
    if (!action) return {state:'not-started'};
    let remote;
    try { remote=git(ticket.expected_worktree,'ls-remote','--heads','origin',action.intent.ref)
      .split(/\s+/u)[0] || null; }
    catch { return {state:'unknown',reason:'COMPANION_PUSH_REMOTE_UNKNOWN'}; }
    if (remote!==action.intent.oid) return {state:'unknown',reason:'COMPANION_PUSH_OUTCOME_UNKNOWN'};
    if (action.attempt_state!=='verified') this.store.updateContinuationAction(locator.card_id,locator.revision,
      `push:${subjectKey}`,action.attempt_state,'verified',{remote_oid:remote,ref:action.intent.ref});
    return {state:'pushed',remote_oid:remote,ref:action.intent.ref};
  }
}
