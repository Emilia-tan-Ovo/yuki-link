import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EngineeringCardStore, digestCardContent } from '../../../companion-desktop/backend/engineering-card-store.mjs';
import { CompanionEvidenceAdapter } from './companion-evidence.mjs';
import { CompanionDeliveryAdapter } from './companion-delivery.mjs';
import { CompanionMechanicalAdapter } from './companion-mechanical.mjs';
import { WorkflowAgentLauncher } from './workflow-agent-launcher.ts';
import { reviewContractDigest } from './review-launcher.ts';
import { HarnessError } from '../harness/model.ts';
import { GhPreparationTransport } from './companion-preparation.mjs';
import { githubIssueSource } from '../../../companion-desktop/backend/github-issue-source.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new HarnessError(code); };
const policyId = value => ({policy_id:value.policy_id,revision:value.revision,digest:value.digest});
const finalRuns = new Set(['completed','failed','stopped','timed_out','interrupted']);
const git = (cwd,...args) => execFileSync('git',['--no-optional-locks',...args],{
  cwd,encoding:'utf8',windowsHide:true,shell:false,timeout:10_000,maxBuffer:1024*1024}).trim();
const identity = subject => {
  if (subject.head && [...subject.staged,...subject.unstaged,...subject.untracked].every(value => value.sha256)) {
    const sort = values => values.map(value => ({path:value.path.replaceAll('\\','/'),sha256:value.sha256}))
      .sort((a,b) => a.path.localeCompare(b.path) || (a.sha256 ?? '').localeCompare(b.sha256 ?? ''));
    return hash(JSON.stringify({head:subject.head,staged:sort(subject.staged),
      unstaged:sort(subject.unstaged),untracked:sort(subject.untracked)}));
  }
  return null;
};

export class CompanionContinuationService {
  constructor({manager,directory,computer=null,projects=[],preparation=null,dispatch=null,issueSource=githubIssueSource(),
    issueTransport=new GhPreparationTransport(),delivery=null}) {
    this.manager=manager; this.store=new EngineeringCardStore(directory);
    this.preparation=preparation; this.dispatch=dispatch; this.issueSource=issueSource;
    this.issueTransport=issueTransport;
    this.projects=projects;
    this.evidence=new CompanionEvidenceAdapter({manager});
    this.mechanical=new CompanionMechanicalAdapter({store:this.store,computer});
    this.taskUnsubscribe=computer?.tasks?.subscribe?.((identity,event)=>{
      if (!['completed','failed','stopped','unknown'].includes(event.snapshot?.status)) return;
      for (const item of this.store.continuations()) {
        const link=this.store.continuation(item.cardId,item.revision);
        if (link?.ticket_id===identity.ticket_id) this.wake({schema_version:1,
          card_store_id:this.store.storeId,card_id:item.cardId,revision:item.revision});
      }
    }) ?? null;
    this.delivery=delivery ?? new CompanionDeliveryAdapter({store:this.store,
      observeAuthority:(locator,intent)=>this.deliveryAuthority(locator,intent)});
    this.active=new Map();
    this.subscriptions=new Map();
    this.timer=null;
  }
  start() {
    for (const item of this.store.continuations()) this.wake({schema_version:1,
      card_store_id:this.store.storeId,card_id:item.cardId,revision:item.revision});
    this.timer=setInterval(()=>{
      for (const item of this.store.continuations()) this.wake({schema_version:1,
        card_store_id:this.store.storeId,card_id:item.cardId,revision:item.revision});
    },20_000);
    this.timer.unref?.();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.taskUnsubscribe?.();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear(); this.store.close();
  }
  wake(raw) {
    void this.advance(raw).then(receipt=>{
      const runs=[receipt.initial_operation?.runtime?.run_id,
        ...this.store.continuationActions(raw.card_id,raw.revision).map(value =>
          this.manager.harness.executionOperations.findByRequest(receipt.ticket_id,
            value.intent.request_id)?.runtime?.run_id)].filter(Boolean);
      for (const runId of runs) if (!this.subscriptions.has(runId)) {
        const unsubscribe=this.manager.store?.subscribe?.(runId,()=>{
          try {
            const run=this.manager.status({run_id:runId})?.run;
            if (finalRuns.has(run?.status)) this.wake(raw);
          } catch { /* The periodic read will reconcile the original run. */ }
        });
        if (unsubscribe) this.subscriptions.set(runId,unsubscribe);
      }
    }).catch(()=>{});
  }
  locator(raw) {
    if (raw?.schema_version!==1 || raw.card_store_id!==this.store.storeId
      || typeof raw.card_id!=='string' || !Number.isSafeInteger(raw.revision) || raw.revision<1
      || Object.keys(raw).sort().join(',')!=='card_id,card_store_id,revision,schema_version')
      fail('COMPANION_CONTINUATION_INPUT_INVALID');
    const card=this.store.get(raw.card_id);
    const link=this.store.continuation(raw.card_id,raw.revision);
    if (!card || !link || card.state!=='confirmed' || card.revision!==raw.revision
      || card.confirmation?.revision!==raw.revision
      || digestCardContent(card.confirmation.content)!==link.confirmation_digest
      || digestCardContent(card.content)!==link.confirmation_digest)
      fail('COMPANION_CONTINUATION_AUTHORITY_CONFLICT');
    const binding=link.binding_kind==='dispatch' ? this.store.received(raw.card_id,raw.revision,link.binding_id)
      : this.store.preparation(raw.card_id,raw.revision);
    if (!binding || link.binding_kind==='preparation'
      && (binding.preparationId!==link.binding_id || binding.bindings?.harness?.ticketId!==link.ticket_id)
      || link.binding_kind==='dispatch' && binding.ticket_id!==link.ticket_id)
      fail('COMPANION_CONTINUATION_BINDING_CONFLICT');
    const ticket=this.manager.harness.tickets.get(link.ticket_id);
    if (!ticket || !ticket.expected_worktree || ticket.reference!==
      (link.binding_kind==='dispatch' ? card.content.ticket?.url : binding.bindings?.issue?.url))
      fail('COMPANION_CONTINUATION_TICKET_CONFLICT');
    return {card,link,binding,ticket};
  }
  initialOperation(context) {
    const {link,binding}=context;
    const requestId=link.binding_kind==='dispatch' ? binding.request_id
      : `companion-prep:${binding.preparationId}:ticket-design`;
    const operation=this.manager.harness.executionOperations.findByRequest(link.ticket_id,requestId);
    if (!operation) return {state:'unknown',reason:'COMPANION_INITIAL_OPERATION_UNKNOWN'};
    const receipt=this.manager.harness.executionOperations.reconcile(operation.operation_id);
    if (receipt.effective_state==='reconciliation-required' || !receipt.runtime?.run_id)
      return {state:'unknown',reason:'COMPANION_INITIAL_OPERATION_RECONCILIATION_REQUIRED',receipt};
    let run;
    try { run=this.manager.harness.source.runs(receipt.runtime.session_id)
      .find(value => value.id===receipt.runtime.run_id); }
    catch { return {state:'unknown',reason:'COMPANION_INITIAL_RUN_UNKNOWN',receipt}; }
    if (!run) return {state:'unknown',reason:'COMPANION_INITIAL_RUN_UNKNOWN',receipt};
    return {state:run.status==='completed' ? 'completed' : finalRuns.has(run.status) ? 'blocked':'waiting',
      reason:run.status==='completed' ? null : `COMPANION_INITIAL_RUN_${run.status.toUpperCase()}`,
      receipt,run};
  }
  async designEvidence(raw,context,initial) {
    if (initial.state!=='completed') return initial;
    const {link,binding,ticket,card}=context;
    const notesRelative=`docs/implementation-notes/${ticket.key}.md`;
    const filename=path.join(ticket.expected_worktree,notesRelative);
    if (!existsSync(filename)) return {state:'unknown',reason:'COMPANION_DESIGN_NOTES_MISSING'};
    const bytes=readFileSync(filename);
    const content=bytes.toString('utf8');
    if (link.binding_kind==='dispatch' && binding.action!=='ticket-design') {
      const workflow=this.manager.harness.workflowHistory.current.get(ticket.id);
      const artifact=workflow?.snapshot?.artifacts?.find(value=>value.role==='implementation-notes'
        && value.location===filename && value.revision===hash(bytes));
      const issue=await this.issueSource.details(card.content.repository,card.content.ticket.number)
        .catch(()=>null);
      if (!artifact || !issue || issue.id!==card.content.ticket.id
        || issue.scope?.digest!==card.content.ticket.scope.digest
        || !issue.body.includes(content))
        return {state:'unknown',reason:'COMPANION_PRIOR_DESIGN_UNVERIFIED'};
      return {state:'completed',notes:{path:notesRelative,sha256:hash(bytes)},
        workflow_revision:workflow.workflow_revision};
    }
    const designRequest=link.binding_kind==='dispatch' ? binding.request_id
      : `companion-prep:${binding.preparationId}:ticket-design`;
    const candidate=this.evidence.operation(ticket.id,designRequest,'ticket-design',
      'ticket-design',ticket.expected_worktree);
    if (candidate.state!=='completed') return candidate;
    if (candidate.value.product_decision_required || candidate.value.product_decisions.length)
      return {state:'blocked',reason:'PRODUCT_DECISION_REQUIRED'};
    if (!/^### Context Plan|^## Context Plan/mu.test(content)
      || !/PRODUCT_DECISION_REQUIRED:\s*none\b/iu.test(content))
      return {state:'blocked',reason:'COMPANION_DESIGN_UNRESOLVED'};
    const workflow=this.manager.harness.workflowHistory.current.get(ticket.id);
    if (workflow?.snapshot.phase!=='ticket-design') {
      const boundary=this.store.continuationAction(card.cardId,card.revision,
        'boundary:design-to-implementation');
      const recorded=boundary && this.manager.harness.workflowHistory.requests.get(
        `${ticket.id}:${boundary.intent.request_id}`);
      if (!boundary || boundary.attempt_state!=='verified' || !recorded
        || boundary.intent.predecessor?.result_sha256!==candidate.sha256
        || boundary.intent.predecessor?.run_id!==initial.run.id)
        return {state:'unknown',reason:'COMPANION_DESIGN_HANDOFF_UNVERIFIED'};
      return {state:'completed',notes:{path:notesRelative,sha256:hash(bytes)},
        design_notes:boundary.intent.predecessor.notes,result_sha256:candidate.sha256,
        run_id:initial.run.id,workflow_revision:workflow.workflow_revision};
    }
    if (link.binding_kind==='preparation') {
      if (!binding.bindings?.design || binding.bindings.design.runId!==initial.run.id
        || binding.bindings.design.notes.path!==notesRelative
        || binding.bindings.design.notes.sha256!==hash(bytes)
        || binding.unknownSideEffects?.length)
        return {state:'unknown',reason:'COMPANION_DESIGN_BINDING_INCOMPLETE'};
      const mirror=await this.preparation?.issues?.verifyMirror(binding.bindings.issue,
        {repository:card.content.repository,marker:binding.marker,
          payloadDigest:binding.payloadDigest},hash(bytes),content).catch(()=>false);
      if (!mirror)
        return {state:'unknown',reason:'COMPANION_DESIGN_MIRROR_UNVERIFIED'};
    } else {
      const artifact=workflow?.snapshot?.artifacts?.find(value => value.role==='implementation-notes'
        && value.location===filename && value.revision===hash(bytes));
      if (!artifact) return {state:'unknown',reason:'COMPANION_DESIGN_WORKFLOW_UNVERIFIED'};
      if (!await this.verifyExistingMirror(card.content,content,hash(bytes)))
        return {state:'unknown',reason:'COMPANION_DESIGN_MIRROR_UNVERIFIED'};
    }
    return {state:'completed',notes:{path:notesRelative,sha256:hash(bytes)},run_id:initial.run.id,
      result_sha256:candidate.sha256,
      workflow_revision:this.manager.harness.workflowHistory.current.get(ticket.id)?.workflow_revision};
  }
  actionEvidence(context,slot,action) {
    const saved=this.store.continuationAction(context.card.cardId,context.card.revision,slot);
    if (!saved) return null;
    if (saved.attempt_state==='unknown') return {state:'unknown',reason:'COMPANION_ACTION_RECEIPT_UNKNOWN'};
    const result=this.evidence.operation(context.ticket.id,saved.intent.request_id,action,
      slot,context.ticket.expected_worktree);
    return {...result,slot,attempt_state:saved.attempt_state};
  }
  async get(raw) {
    const context=this.locator(raw);
    const workflow=this.manager.harness.workflowHistory.current.get(context.ticket.id);
    const summary=this.manager.harness.workflowHistory.summary(context.ticket.id);
    const initial=this.initialOperation(context);
    const design=await this.designEvidence(raw,context,initial);
    const actions=this.store.continuationActions(raw.card_id,raw.revision);
    const pr=await this.delivery.reconcile(raw,{persist:false});
    const prIntent=actions.find(item=>item.slot==='pr-delivery')?.intent;
    const prCurrent=prIntent && workflow
      && prIntent.subject_identity===identity(workflow.snapshot.subject)
      && prIntent.head_oid===workflow.snapshot.subject.head;
    let next;
    if (initial.state!=='completed') next={action:'observe-initial',state:initial.state,reason:initial.reason};
    else if (design.state!=='completed') next={action:'verify-design',state:design.state,reason:design.reason};
    else if (context.card.content.endpoint==='design-only') next={action:'endpoint-reached',state:'ready',reason:null};
    else if (pr.state==='delivered' && summary.acceptance?.accepted && prCurrent)
      next={action:'endpoint-reached',state:'ready',reason:null};
    else if (pr.state==='delivered' && !prCurrent)
      next={action:'reconcile-pr',state:'blocked',reason:'COMPANION_PR_ACCEPTANCE_CHANGED'};
    else if (actions.some(item => item.attempt_state==='unknown'))
      next={action:'reconcile',state:'unknown',reason:'COMPANION_ACTION_RECEIPT_UNKNOWN'};
    else if (pr.state==='unknown') next={action:'reconcile-pr',state:'unknown',reason:pr.reason};
    else if (pr.state==='observed-closed')
      next={action:'pr-delivery',state:'blocked',reason:'COMPANION_PR_ALREADY_CLOSED'};
    else if (!workflow || summary.assessment?.state!=='verified')
      next={action:'refresh-workflow',state:'blocked',reason:'COMPANION_WORKFLOW_UNVERIFIED'};
    else if (workflow.snapshot.phase==='ticket-design') next={action:'implementation',state:'ready',reason:null};
    else if (workflow.snapshot.phase==='implementation') {
      const fix=actions.find(item => item.slot.startsWith('finding-fix-'));
      const slot=fix?.slot ?? 'implementation';
      const result=this.actionEvidence(context,slot,fix ? 'finding-fix':'implementation');
      next=result ? {action:'verify-implementation',state:result.state==='completed' ? 'ready':result.state,
        reason:result.reason ?? null}
        : {action:fix || workflow.snapshot.findings.some(value=>value.status==='open')
          ? 'finding-fix':'implementation',state:'ready',reason:null};
    } else if (workflow.snapshot.phase==='review') {
      const focused=actions.find(item => item.slot.startsWith('focused-review-'));
      const slot=focused?.slot ?? 'primary-review';
      const result=this.actionEvidence(context,slot,focused ? 'focused-review':'review');
      next=!focused && workflow.snapshot.reviews.some(value=>value.mode==='focused' && value.status==='pending')
        ? {action:'focused-review',state:'ready',reason:null}
        : result ? {action:'verify-review',state:result.state==='completed' ? 'ready':result.state,
        reason:result.reason ?? null}
        : {action:focused ? 'focused-review':'primary-review',state:'ready',reason:null};
    } else if (workflow.snapshot.phase==='acceptance')
      next=summary.acceptance?.accepted ? {action:'pr-delivery',state:'ready',reason:null}
        : {action:'collect-acceptance',
          state:actions.some(value=>value.slot==='boundary:acceptance-collection') ? 'blocked':'ready',
          reason:actions.some(value=>value.slot==='boundary:acceptance-collection')
            ? 'COMPANION_ACCEPTANCE_EVIDENCE_PENDING':null};
    else if (workflow.snapshot.phase==='closeout' && summary.acceptance?.accepted)
      next={action:'pr-delivery',state:'ready',reason:null};
    else next={action:'reconcile',state:'blocked',reason:'COMPANION_PHASE_UNSUPPORTED'};
    return {schema_version:1,card_store_id:raw.card_store_id,card_id:raw.card_id,revision:raw.revision,
      endpoint:context.card.content.endpoint,ticket_ref:context.ticket.reference,ticket_id:context.ticket.id,
      preparation_id:context.link.binding_kind==='preparation' ? context.link.binding_id:null,
      dispatch_id:context.link.binding_kind==='dispatch' ? context.link.binding_id:null,
      initial_operation:initial.receipt ?? null,initial_run:initial.run ?? null,design,
      workflow_revision:workflow?.workflow_revision ?? null,workflow:summary,
      acceptance:summary.acceptance ?? null,pr_delivery:pr,next_action:next,
      source_refs:['card-sqlite','harness-workflow','harness-execution-operations','git','github'],
      observed_at:new Date().toISOString()};
  }
  async advance(raw) {
    const key=`${raw.card_id}:${raw.revision}`;
    if (this.active.has(key)) return this.active.get(key);
    const work=this.advanceOne(raw).finally(()=>this.active.delete(key));
    this.active.set(key,work);
    return work;
  }
  async advanceOne(raw) {
    const before=this.locator(raw);
    this.reconcileBoundaries(before);
    this.reconcileModelActions(before);
    await this.delivery.reconcile(raw);
    const receipt=await this.get(raw);
    if (receipt.design?.reason==='COMPANION_DESIGN_MIRROR_UNVERIFIED') {
      const context=this.locator(raw);
      if (context.link.binding_kind==='dispatch' && receipt.initial_run?.status==='completed') {
        await this.mirrorExisting(raw,context);
        return this.get(raw);
      }
    }
    if (receipt.next_action.state!=='ready' || receipt.next_action.action==='endpoint-reached') return receipt;
    const context=this.locator(raw);
    if (receipt.next_action.action==='implementation') {
      const workflow=this.manager.harness.workflowHistory.current.get(context.ticket.id);
      if (workflow.snapshot.phase==='ticket-design') {
        const moved=this.movePhase(context,'implementation','design-to-implementation',receipt.design);
        if (!moved) return this.get(raw);
      }
      return this.startModel(raw,context,'implementation','implementation',receipt.design);
    }
    if (receipt.next_action.action==='verify-implementation') {
      const fix=this.store.continuationActions(raw.card_id,raw.revision)
        .find(value=>value.slot.startsWith('finding-fix-'));
      const slot=fix?.slot ?? 'implementation';
      const result=this.actionEvidence(context,slot,fix ? 'finding-fix':'implementation');
      if (result?.state!=='completed') return this.get(raw);
      const subjectKey=fix ? `fix-${hash(fix.intent.origin_review_id).slice(0,32)}`:'implementation';
      const tests=await this.mechanical.fullSuite(raw,context.ticket,subjectKey);
      if (tests.state!=='passed') return {...await this.get(raw),mechanical:tests,
        next_action:{action:'full-suite',state:tests.state,reason:tests.reason ?? null}};
      const files=[...new Set([...result.value.files,
        ...(this.mechanical.changed(context.ticket.expected_worktree).includes(receipt.design.notes.path)
          ? [receipt.design.notes.path] : [])])];
      const committed=this.mechanical.commit(raw,context.ticket,subjectKey,files,tests);
      if (committed.state!=='committed') return {...await this.get(raw),mechanical:committed,
        next_action:{action:'commit',state:committed.state,reason:committed.reason ?? null}};
      if (fix) {
        const origin=fix.intent.origin_review_id;
        const focusedId=`companion-focused:${hash(`${context.card.cardId}:${origin}`).slice(0,48)}`;
        this.movePhase(context,'review',`fix-to-focused-${hash(origin).slice(0,32)}`,
          {result_sha256:result.sha256,commit_oid:committed.oid,tests_task_id:tests.task_id},snapshot=>{
            const subjectIdentity=identity(snapshot.subject);
            const findings=snapshot.findings.filter(value=>value.origin_review_id===origin && value.status==='open');
            if (findings.length!==fix.intent.batch.length) fail('COMPANION_FIX_BATCH_CONFLICT');
            for (const finding of findings) Object.assign(finding,{status:'fixed-unverified',
              subject_ref:snapshot.subject.subject_id,subject_identity:subjectIdentity});
            snapshot.reviews.push({review_id:focusedId,original_review_id:origin,mode:'focused',
              status:'pending',subject_ref:snapshot.subject.subject_id,subject_identity:subjectIdentity,
              artifact_refs:[],standards:{status:'pending',evidence:[],reason:null},
              spec:{status:'pending',evidence:[],reason:null},
              finding_refs:fix.intent.batch.map(value=>({origin_review_id:origin,
                finding_id:value.finding_id})),isolated:'unknown',applicability:'not-applicable',reason:null});
          });
        this.recordModelResult(context,slot,result);
        return this.startFocusedReview(raw,context,focusedId,fix,committed,result);
      }
      const reviewId=`companion-primary:${context.card.cardId}:${context.card.revision}`;
      this.movePhase(context,'review','implementation-to-review',{result_sha256:result.sha256,
        commit_oid:committed.oid,tests_task_id:tests.task_id},snapshot=>{
        const subjectIdentity=identity(snapshot.subject);
        snapshot.reviews.push({review_id:reviewId,original_review_id:null,mode:'full',status:'pending',
          subject_ref:snapshot.subject.subject_id,subject_identity:subjectIdentity,
          artifact_refs:[],standards:{status:'pending',evidence:[],reason:null},
          spec:{status:'pending',evidence:[],reason:null},finding_refs:[],isolated:'unknown',
          applicability:'not-applicable',reason:null});
      });
      this.recordModelResult(context,slot,result);
      return this.startPrimaryReview(raw,context,reviewId,committed,result);
    }
    if (receipt.next_action.action==='primary-review') {
      const committed=this.mechanical.reconcileCommit(raw,context.ticket,'implementation');
      const result=this.actionEvidence(context,'implementation','implementation');
      if (committed.state!=='committed' || result?.state!=='completed')
        return {...receipt,next_action:{action:'reconcile-review-input',state:'unknown',
          reason:'COMPANION_REVIEW_INPUT_UNKNOWN'}};
      const reviewId=`companion-primary:${context.card.cardId}:${context.card.revision}`;
      return this.startPrimaryReview(raw,context,reviewId,committed,result);
    }
    if (receipt.next_action.action==='finding-fix') return this.startFindingFix(raw,context);
    if (receipt.next_action.action==='focused-review') {
      const fix=this.store.continuationActions(raw.card_id,raw.revision)
        .find(value=>value.slot.startsWith('finding-fix-'));
      if (!fix) return {...receipt,next_action:{action:'focused-review',state:'unknown',
        reason:'COMPANION_FIX_INTENT_UNKNOWN'}};
      const commit=this.mechanical.reconcileCommit(raw,context.ticket,
        `fix-${hash(fix.intent.origin_review_id).slice(0,32)}`);
      const result=this.actionEvidence(context,fix.slot,'finding-fix');
      const focused=this.manager.harness.workflowHistory.current.get(context.ticket.id)?.snapshot.reviews
        .find(value=>value.mode==='focused' && value.status==='pending');
      if (commit.state!=='committed' || result?.state!=='completed' || !focused)
        return {...receipt,next_action:{action:'focused-review',state:'unknown',
          reason:'COMPANION_FOCUSED_INPUT_UNKNOWN'}};
      return this.startFocusedReview(raw,context,focused.review_id,fix,commit,result);
    }
    if (receipt.next_action.action==='verify-review') {
      const focused=this.store.continuationActions(raw.card_id,raw.revision)
        .find(value=>value.slot.startsWith('focused-review-'));
      if (focused) {
        const result=this.actionEvidence(context,focused.slot,'focused-review');
        if (result?.state!=='completed') return receipt;
        const fix=this.store.continuationActions(raw.card_id,raw.revision)
          .find(value=>value.slot.startsWith('finding-fix-'));
        const required=fix?.intent.batch.map(value=>value.finding_id).sort();
        const verified=result.value.verified_finding_ids;
        if (!required || new Set(verified).size!==verified.length
          || JSON.stringify([...verified].sort())!==JSON.stringify(required)
          || result.value.axes.standards==='incomplete' || result.value.axes.spec==='incomplete')
          return {...receipt,next_action:{action:'focused-review-incomplete',state:'blocked',
            reason:'COMPANION_FOCUSED_COVERAGE_INCOMPLETE'}};
        const reviewId=focused.intent.authorization.review_id;
        const origin=focused.intent.origin_review_id;
        this.movePhase(context,'acceptance',`focused-review-complete-${hash(origin).slice(0,32)}`,
          {result_sha256:result.sha256,run_id:result.run_id},snapshot=>{
            const review=snapshot.reviews.find(value=>value.review_id===reviewId);
            if (!review || review.status!=='pending') fail('COMPANION_FOCUSED_RECORD_CONFLICT');
            const reportId=`review-report:${reviewId}`,runRef=`review-run:${reviewId}`;
            snapshot.artifacts.push({artifact_id:reportId,role:'review-report',kind:'file',
              location:result.report.path,revision:result.report.sha256,
              source_schema:'companion-result-v1',source:'companion-evidence',
              observed_at:new Date().toISOString(),integrity:'observed'});
            snapshot.runtime_refs.push({runtime_ref_id:runRef,kind:'codex-run',
              session_id:result.session_id,run_id:result.run_id,task_id:null,call_id:null,
              expected_state:'completed',source:'harness-execution-operations'});
            Object.assign(review,{status:'passed',artifact_refs:[reportId],
              standards:{status:result.value.axes.standards,evidence:[reportId],reason:null},
              spec:{status:result.value.axes.spec,evidence:[reportId],reason:null},
              isolated:true,applicability:'verified',execution_refs:[runRef],
              participant_execution_refs:[{participant:'coordinator',runtime_ref_id:runRef}]});
            for (const finding of snapshot.findings.filter(value=>value.origin_review_id===origin))
              Object.assign(finding,{status:'verified',verification_review_id:reviewId,
                subject_ref:snapshot.subject.subject_id,subject_identity:identity(snapshot.subject),
                applicability:'verified',evidence:[...finding.evidence,reportId]});
          });
        this.recordModelResult(context,focused.slot,result);
        return this.get(raw);
      }
      const result=this.actionEvidence(context,'primary-review','review');
      if (result?.state!=='completed') return receipt;
      const reviewId=`companion-primary:${context.card.cardId}:${context.card.revision}`;
      const values=result.value.findings;
      if (values.length>32 || values.some(value=>typeof value?.finding_id!=='string'
        || typeof value?.summary!=='string' || !value.summary.trim())
        || new Set(values.map(value=>value.finding_id)).size!==values.length)
        return {...receipt,next_action:{action:'verify-review',state:'unknown',
          reason:'COMPANION_FINDINGS_INVALID'}};
      const axes=result.value.axes;
      const passed=axes.standards==='passed' && axes.spec==='passed' && values.length===0;
      const findings=values.length>0;
      if (!passed && !findings) return {...receipt,next_action:{action:'verify-review',state:'blocked',
        reason:'COMPANION_REVIEW_INCOMPLETE'}};
      const nextPhase=findings ? 'implementation':'acceptance';
      this.movePhase(context,nextPhase,'primary-review-complete',
        {result_sha256:result.sha256,run_id:result.run_id},snapshot=>{
          const review=snapshot.reviews.find(value=>value.review_id===reviewId);
          if (!review || review.status!=='pending') fail('COMPANION_REVIEW_RECORD_CONFLICT');
          const reportId=`review-report:${reviewId}`;
          const runRef=`review-run:${reviewId}`;
          snapshot.artifacts.push({artifact_id:reportId,role:'review-report',kind:'file',
            location:result.report.path,revision:result.report.sha256,source_schema:'companion-result-v1',
            source:'companion-evidence',observed_at:new Date().toISOString(),integrity:'observed'});
          snapshot.runtime_refs.push({runtime_ref_id:runRef,kind:'codex-run',
            session_id:result.session_id,run_id:result.run_id,task_id:null,call_id:null,
            expected_state:'completed',source:'harness-execution-operations'});
          Object.assign(review,{status:passed ? 'passed':'findings',
            artifact_refs:[reportId],standards:{status:axes.standards,evidence:[reportId],reason:null},
            spec:{status:axes.spec,evidence:[reportId],reason:null},
            finding_refs:values.map(value=>({origin_review_id:reviewId,finding_id:value.finding_id})),
            isolated:true,applicability:'verified',execution_refs:[runRef],
            participant_execution_refs:[{participant:'coordinator',runtime_ref_id:runRef}]});
          for (const value of values) snapshot.findings.push({origin_review_id:reviewId,
            finding_id:value.finding_id,status:'open',severity:value.severity ?? null,
            summary:value.summary,subject_ref:review.subject_ref,
            subject_identity:review.subject_identity,verification_review_id:null,
            artifact_refs:[reportId],evidence:[reportId],applicability:'verified',reason:null});
        });
      this.recordModelResult(context,'primary-review',result);
      return this.get(raw);
    }
    if (receipt.next_action.action==='collect-acceptance') return this.collectAcceptance(raw,context,receipt);
    if (receipt.next_action.action==='pr-delivery') {
      if (this.manager.harness.workflowHistory.current.get(context.ticket.id)?.snapshot.phase==='acceptance')
        this.movePhase(context,'closeout','acceptance-to-delivery',
          {acceptance_revision:receipt.workflow_revision});
      return this.deliverPr(raw,context);
    }
    return receipt;
  }
  movePhase(context,phase,slot,predecessor,decorate=null) {
    const {ticket,card}=context;
    const harness=this.manager.harness;
    const current=harness.workflowHistory.current.get(ticket.id);
    const requestId=`companion-boundary:${hash(`${card.cardId}:${card.revision}:${slot}`).slice(0,56)}`;
    const already=harness.workflowHistory.requests.get(`${ticket.id}:${requestId}`);
    if (already) return already;
    if (!current || harness.workflowHistory.source.assess(ticket,current.snapshot).state!=='verified')
      fail('COMPANION_WORKFLOW_UNVERIFIED');
    const checkpointArtifact=current.snapshot.artifacts.find(value => value.artifact_id===current.snapshot.checkpoint.artifact_id);
    if (!checkpointArtifact || checkpointArtifact.kind!=='file') fail('COMPANION_CHECKPOINT_MISSING');
    const old=readFileSync(checkpointArtifact.location,'utf8');
    if (hash(old)!==checkpointArtifact.revision) fail('COMPANION_CHECKPOINT_CONFLICT');
    const head=git(ticket.expected_worktree,'rev-parse','HEAD');
    const changed=old.replace(/^phase:.*$/mu,`phase: ${phase}`).replace(/^head:.*$/mu,`head: ${JSON.stringify(head)}`);
    const snapshot=structuredClone(current.snapshot);
    snapshot.phase=phase; snapshot.checkpoint.phase=phase; snapshot.checkpoint.head=head;
    snapshot.subject.head=head;
    const artifacts=new Set(snapshot.artifacts.filter(value=>value.kind==='file')
      .map(value=>path.relative(ticket.expected_worktree,value.location).replaceAll('\\','/')));
    const rawStatus=execFileSync('git',['--no-optional-locks','status','--porcelain=v1','-z','--untracked-files=all'],
      {cwd:ticket.expected_worktree,encoding:'utf8',windowsHide:true,shell:false,timeout:10_000});
    const status={staged:[],unstaged:[],untracked:[]};
    const rows=rawStatus.split('\0');
    for (let index=0;index<rows.length;index++) {
      const row=rows[index]; if (!row) continue;
      const code=row.slice(0,2),file=row.slice(3).replaceAll('\\','/');
      if (code.includes('R') || code.includes('C')) index++;
      if (artifacts.has(file)) continue;
      const entry=this.mechanical.content(ticket.expected_worktree,[file])[0];
      if (code==='??') status.untracked.push(entry);
      else {
        if (code[0]!==' ') status.staged.push(entry);
        if (code[1]!==' ') status.unstaged.push(entry);
      }
    }
    snapshot.subject.staged=status.staged; snapshot.subject.unstaged=status.unstaged;
    snapshot.subject.untracked=status.untracked;
    snapshot.subject.subject_id=`companion-subject:${hash(JSON.stringify({head,status})).slice(0,48)}`;
    snapshot.artifacts=snapshot.artifacts.map(value => value.artifact_id===checkpointArtifact.artifact_id
      ? {...value,revision:hash(changed),observed_at:new Date().toISOString()} : value);
    decorate?.(snapshot);
    const intent={schema_version:1,request_id:requestId,predecessor,expected_revision:current.workflow_revision,
      old_checkpoint_digest:hash(old),checkpoint_bytes:changed,snapshot};
    const prior=this.store.continuationAction(card.cardId,card.revision,`boundary:${slot}`);
    const claimed=prior ? {action:prior} : this.store.claimContinuationAction(card.cardId,card.revision,`boundary:${slot}`,intent);
    if (claimed.conflict) fail('COMPANION_BOUNDARY_INTENT_CONFLICT');
    const frozen=claimed.action.intent;
    if (readFileSync(checkpointArtifact.location,'utf8')===old) {
      const tmp=`${checkpointArtifact.location}.${randomUUID()}.tmp`;
      writeFileSync(tmp,frozen.checkpoint_bytes,{encoding:'utf8',flag:'wx'});
      renameSync(tmp,checkpointArtifact.location);
    }
    if (hash(readFileSync(checkpointArtifact.location))!==hash(frozen.checkpoint_bytes))
      fail('COMPANION_CHECKPOINT_CONFLICT');
    const saved=harness.recordWorkflow({ticket_id:ticket.id,request_id:requestId,
      expected_revision:frozen.expected_revision,schema_version:1,snapshot:frozen.snapshot});
    if (saved.applicability?.state!=='verified') fail('COMPANION_BOUNDARY_WORKFLOW_UNVERIFIED');
    this.store.updateContinuationAction(card.cardId,card.revision,`boundary:${slot}`,
      claimed.action.attempt_state,'verified',{workflow_revision:saved.workflow_revision});
    return harness.workflowHistory.current.get(ticket.id);
  }
  reconcileBoundaries(context) {
    const {card,ticket}=context,harness=this.manager.harness;
    for (const action of this.store.continuationActions(card.cardId,card.revision)
      .filter(value => value.slot.startsWith('boundary:') && value.attempt_state!=='verified')) {
      const intent=action.intent;
      const recorded=harness.workflowHistory.requests.get(`${ticket.id}:${intent.request_id}`);
      if (recorded) {
        this.store.updateContinuationAction(card.cardId,card.revision,action.slot,
          action.attempt_state,'verified',{workflow_revision:recorded.workflow_revision});
        continue;
      }
      const artifact=intent.snapshot.artifacts.find(value => value.artifact_id===intent.snapshot.checkpoint.artifact_id);
      const current=harness.workflowHistory.current.get(ticket.id);
      if (!artifact || !current || current.workflow_revision!==intent.expected_revision) continue;
      const currentBytes=readFileSync(artifact.location);
      if (hash(currentBytes)===intent.old_checkpoint_digest) {
        const tmp=`${artifact.location}.${randomUUID()}.tmp`;
        writeFileSync(tmp,intent.checkpoint_bytes,{encoding:'utf8',flag:'wx'});
        renameSync(tmp,artifact.location);
      }
      if (hash(readFileSync(artifact.location))!==hash(intent.checkpoint_bytes)) continue;
      try {
        const receipt=harness.recordWorkflow({ticket_id:ticket.id,request_id:intent.request_id,
          expected_revision:intent.expected_revision,schema_version:1,snapshot:intent.snapshot});
        if (receipt.applicability?.state==='verified') this.store.updateContinuationAction(
          card.cardId,card.revision,action.slot,action.attempt_state,'verified',
          {workflow_revision:receipt.workflow_revision});
      } catch { /* Preserve the original intent and checkpoint for reconciliation. */ }
    }
  }
  reconcileModelActions(context) {
    for (const action of this.store.continuationActions(context.card.cardId,context.card.revision)
      .filter(value=>value.attempt_state==='unknown'
        && ['implementation','review','finding-fix','focused-review'].includes(value.intent.action))) {
      const operation=this.manager.harness.executionOperations.findByRequest(context.ticket.id,
        action.intent.request_id);
      if (!operation) continue;
      const receipt=this.manager.harness.executionOperations.reconcile(operation.operation_id);
      if (receipt.runtime?.run_id && receipt.effective_state!=='reconciliation-required')
        this.store.updateContinuationAction(context.card.cardId,context.card.revision,
          action.slot,'unknown','attempted',{operation_id:operation.operation_id});
    }
  }
  recordModelResult(context,slot,result) {
    const action=this.store.continuationAction(context.card.cardId,context.card.revision,slot);
    if (action?.attempt_state==='attempted') this.store.updateContinuationAction(
      context.card.cardId,context.card.revision,slot,'attempted','verified',
      {operation_id:result.operation_id,run_id:result.run_id,result_sha256:result.sha256});
  }
  async startModel(raw,context,action,slot,predecessor) {
    const {ticket,card}=context;
    const harness=this.manager.harness;
    const workflow=harness.workflowHistory.current.get(ticket.id);
    if (!workflow || harness.workflowHistory.source.assess(ticket,workflow.snapshot).state!=='verified')
      fail('COMPANION_WORKFLOW_UNVERIFIED');
    const existing=this.store.continuationAction(card.cardId,card.revision,slot);
    if (existing) return this.get(raw);
    const notes=predecessor.notes;
    if (!notes || hash(readFileSync(path.join(ticket.expected_worktree,notes.path)))!==notes.sha256)
      fail('COMPANION_NOTES_CONFLICT');
    const active=this.manager.implementationLaunchAuthority?.snapshot(ticket.key,'')?.policy;
    if (!active || active.workflow_phase!=='implementation' || active.permission_selection!=='owner-native-default')
      fail('COMPANION_POLICY_UNAVAILABLE');
    const rawIdentity=harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    if (rawIdentity?.completeness!=='complete') fail('COMPANION_SUBJECT_UNVERIFIED');
    const contentIdentity={scheme:rawIdentity.scheme,version:rawIdentity.version,
      scope:rawIdentity.scope,completeness:rawIdentity.completeness,digest:rawIdentity.digest};
    const authorizationRef=`companion-continuation:${card.cardId}:${card.revision}:${slot}`;
    const requestId=`companion:${hash(`${card.cardId}:${card.revision}:${slot}`).slice(0,64)}`;
    const resultPath=this.evidence.resultPath(ticket.expected_worktree,slot);
    const authorization={schema_version:1,authorization_id:authorizationRef,ticket_key:ticket.key,
      action:'ticket-implementation',endpoint:'implementation',contract_version:1,
      authorization_ref:authorizationRef,notes,authority_refs:[ticket.reference,authorizationRef]};
    const input={schema_version:1,action:'implementation',ticket_id:ticket.id,request_id:requestId,
      authorization_ref:authorizationRef,expected:{workflow_revision:workflow.workflow_revision,
        subject_ref:workflow.snapshot.subject.subject_id,content_identity:contentIdentity,
        notes,policy:policyId(active)},current_delta:[]};
    const intent={schema_version:1,action,request_id:requestId,workflow_revision:workflow.workflow_revision,
      predecessor,authorization,policy:active,result_path:resultPath,launcher_input:input};
    const claimed=this.store.claimContinuationAction(card.cardId,card.revision,slot,intent);
    if (claimed.conflict) fail('COMPANION_ACTION_INTENT_CONFLICT');
    if (claimed.deduplicated) return this.get(raw);
    mkdirSync(path.dirname(resultPath),{recursive:true});
    const service=this;
    const authority={snapshot(ticketKey,authorizationRefObserved) {
      const current=service.locator(raw);
      const activePolicy=service.manager.implementationLaunchAuthority?.snapshot(ticketKey,'')?.policy;
      const observed=service.manager.harness.workflowHistory.current.get(ticket.id);
      if (current.card.content.endpoint!=='to-pr' || ticketKey!==ticket.key
        || authorizationRefObserved!==authorizationRef || !activePolicy
        || activePolicy.digest!==active.digest || observed?.workflow_revision!==workflow.workflow_revision
        || hash(readFileSync(path.join(ticket.expected_worktree,notes.path)))!==notes.sha256)
        fail('COMPANION_ACTION_AUTHORITY_CONFLICT');
      return {policy:active,authorization,source:{schema_version:1,kind:'adapter',
        reference:authorizationRef,canonical_path:null,sha256:hash(JSON.stringify(intent))},
        companion_result_path:resultPath};
    }};
    const attempted=this.store.updateContinuationAction(card.cardId,card.revision,slot,'reserved','attempted');
    if (attempted.conflict) return this.get(raw);
    try {
      await new WorkflowAgentLauncher({manager:this.manager,harness,implementationAuthority:authority}).start(input);
    } catch {
      this.store.updateContinuationAction(card.cardId,card.revision,slot,'attempted','unknown');
    }
    return this.get(raw);
  }
  async startPrimaryReview(raw,context,reviewId,commit,implementationResult) {
    const {card,ticket}=context,harness=this.manager.harness;
    const slot='primary-review';
    if (this.store.continuationAction(card.cardId,card.revision,slot)) return this.get(raw);
    const workflow=harness.workflowHistory.current.get(ticket.id);
    const review=workflow?.snapshot.reviews.find(value=>value.review_id===reviewId);
    const subjectIdentity=workflow && identity(workflow.snapshot.subject);
    if (!workflow || review?.status!=='pending' || !subjectIdentity
      || review.subject_identity!==subjectIdentity || git(ticket.expected_worktree,'rev-parse','HEAD')!==commit.oid)
      fail('COMPANION_REVIEW_SUBJECT_CONFLICT');
    const active=this.manager.reviewLaunchAuthority?.snapshot(ticket.key,reviewId,'')?.policy;
    if (!active || active.workflow_phase!=='review' || active.permission_selection!=='owner-native-default')
      fail('COMPANION_REVIEW_POLICY_UNAVAILABLE');
    const rawIdentity=harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    if (rawIdentity?.completeness!=='complete') fail('COMPANION_REVIEW_CONTENT_UNVERIFIED');
    const contentIdentity={scheme:rawIdentity.scheme,version:rawIdentity.version,
      scope:rawIdentity.scope,completeness:rawIdentity.completeness,digest:rawIdentity.digest};
    const authorizationRef=`companion-continuation:${card.cardId}:${card.revision}:${slot}`;
    const requestId=`companion:${hash(`${card.cardId}:${card.revision}:${slot}`).slice(0,64)}`;
    const resultPath=this.evidence.resultPath(ticket.expected_worktree,slot);
    const authorization={schema_version:1,authorization_id:authorizationRef,ticket_key:ticket.key,
      review_id:reviewId,action:'ticket-review',endpoint:'review',contract_version:1,
      contract_digest:reviewContractDigest,authorization_ref:authorizationRef,
      subject_ref:workflow.snapshot.subject.subject_id,subject_identity:subjectIdentity,
      content_identity:contentIdentity,authority_refs:[ticket.reference,authorizationRef]};
    const input={schema_version:1,action:'review',ticket_id:ticket.id,request_id:requestId,
      review_id:reviewId,authorization_ref:authorizationRef,
      expected:{workflow_revision:workflow.workflow_revision,
        subject_ref:workflow.snapshot.subject.subject_id,subject_identity:subjectIdentity,
        content_identity:contentIdentity,policy:policyId(active)},
      references:[ticket.reference,implementationResult.report.path],current_delta:[]};
    const intent={schema_version:1,action:'review',request_id:requestId,
      predecessor:{commit_oid:commit.oid,result_sha256:implementationResult.sha256},
      policy:active,authorization,result_path:resultPath,launcher_input:input};
    const claimed=this.store.claimContinuationAction(card.cardId,card.revision,slot,intent);
    if (claimed.conflict) fail('COMPANION_REVIEW_INTENT_CONFLICT');
    if (claimed.deduplicated) return this.get(raw);
    mkdirSync(path.dirname(resultPath),{recursive:true});
    const service=this;
    const authority={snapshot(ticketKey,observedReview,observedRef) {
      const current=service.locator(raw);
      const activePolicy=service.manager.reviewLaunchAuthority?.snapshot(ticketKey,observedReview,'')?.policy;
      const nowWorkflow=harness.workflowHistory.current.get(ticket.id);
      if (current.card.content.endpoint!=='to-pr' || ticketKey!==ticket.key
        || observedReview!==reviewId || observedRef!==authorizationRef
        || activePolicy?.digest!==active.digest || nowWorkflow?.workflow_revision!==workflow.workflow_revision
        || git(ticket.expected_worktree,'rev-parse','HEAD')!==commit.oid)
        fail('COMPANION_REVIEW_AUTHORITY_CONFLICT');
      return {policy:active,authorization,source:{schema_version:1,kind:'adapter',
        reference:authorizationRef,canonical_path:null,sha256:hash(JSON.stringify(intent))},
        companion_result_path:resultPath};
    }};
    this.store.updateContinuationAction(card.cardId,card.revision,slot,'reserved','attempted');
    try { await new WorkflowAgentLauncher({manager:this.manager,harness,
      reviewAuthority:authority}).start(input); }
    catch { this.store.updateContinuationAction(card.cardId,card.revision,slot,'attempted','unknown'); }
    return this.get(raw);
  }
  async startFindingFix(raw,context) {
    const {card,ticket}=context,harness=this.manager.harness;
    const workflow=harness.workflowHistory.current.get(ticket.id);
    const open=workflow?.snapshot.findings.filter(value=>value.status==='open') ?? [];
    if (!open.length || new Set(open.map(value=>value.origin_review_id)).size!==1)
      fail('COMPANION_FINDING_BATCH_CONFLICT');
    const origin=open[0].origin_review_id;
    const slot=`finding-fix-${hash(origin).slice(0,32)}`;
    if (this.store.continuationAction(card.cardId,card.revision,slot)) return this.get(raw);
    const review=workflow.snapshot.reviews.find(value=>value.review_id===origin);
    const report=review?.artifact_refs.map(id=>workflow.snapshot.artifacts.find(value=>value.artifact_id===id))
      .find(value=>value?.role==='review-report');
    if (!report || review.status!=='findings' || !workflow.snapshot.subject.head)
      fail('COMPANION_FINDING_REPORT_UNVERIFIED');
    const batch=open.map(value=>({origin_review_id:origin,finding_id:value.finding_id,
      report_ref:report.location,fix_baseline:workflow.snapshot.subject.head}));
    const authorizationRef=`companion-continuation:${card.cardId}:${card.revision}:${slot}`;
    const active=this.manager.workflowAgentAuthority?.snapshot(ticket.key,'finding-fix',authorizationRef)?.policy;
    if (!active || active.workflow_phase!=='implementation' || active.permission_selection!=='owner-native-default')
      fail('COMPANION_FIX_POLICY_UNAVAILABLE');
    const rawIdentity=harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    if (rawIdentity?.completeness!=='complete') fail('COMPANION_FIX_SUBJECT_UNVERIFIED');
    const contentIdentity={scheme:rawIdentity.scheme,version:rawIdentity.version,
      scope:rawIdentity.scope,completeness:rawIdentity.completeness,digest:rawIdentity.digest};
    const requestId=`companion:${hash(`${card.cardId}:${card.revision}:${slot}`).slice(0,64)}`;
    const resultPath=this.evidence.resultPath(ticket.expected_worktree,slot);
    const authorization={schema_version:1,authorization_id:authorizationRef,ticket_key:ticket.key,
      action:'finding-fix',authorization_ref:authorizationRef,
      subject_ref:workflow.snapshot.subject.subject_id,subject_identity:identity(workflow.snapshot.subject),
      authority_refs:[ticket.reference,authorizationRef],finding_batch:batch};
    const input={schema_version:1,action:'finding-fix',ticket_id:ticket.id,
      request_id:requestId,authorization_ref:authorizationRef,
      expected:{workflow_revision:workflow.workflow_revision,
        subject_ref:workflow.snapshot.subject.subject_id,
        subject_identity:identity(workflow.snapshot.subject),content_identity:contentIdentity,
        policy:policyId(active)},finding_batch:batch};
    const intent={schema_version:1,action:'finding-fix',request_id:requestId,
      origin_review_id:origin,batch,policy:active,authorization,
      workflow_revision:workflow.workflow_revision,result_path:resultPath,launcher_input:input};
    const claimed=this.store.claimContinuationAction(card.cardId,card.revision,slot,intent);
    if (claimed.conflict) fail('COMPANION_FIX_INTENT_CONFLICT');
    if (claimed.deduplicated) return this.get(raw);
    mkdirSync(path.dirname(resultPath),{recursive:true});
    const service=this;
    const authority={snapshot(ticketKey,action,observedRef) {
      const current=service.locator(raw);
      const activePolicy=service.manager.workflowAgentAuthority?.snapshot(ticketKey,action,observedRef)?.policy;
      const nowWorkflow=harness.workflowHistory.current.get(ticket.id);
      if (current.card.content.endpoint!=='to-pr' || ticketKey!==ticket.key || action!=='finding-fix'
        || observedRef!==authorizationRef || activePolicy?.digest!==active.digest
        || nowWorkflow?.workflow_revision!==workflow.workflow_revision
        || nowWorkflow.snapshot.findings.filter(value=>value.status==='open').length!==batch.length)
        fail('COMPANION_FIX_AUTHORITY_CONFLICT');
      return {policy:active,authorization,source:{schema_version:1,kind:'adapter',
        reference:authorizationRef,canonical_path:null,sha256:hash(JSON.stringify(intent))},
        companion_result_path:resultPath};
    }};
    this.store.updateContinuationAction(card.cardId,card.revision,slot,'reserved','attempted');
    try { await new WorkflowAgentLauncher({manager:this.manager,harness,
      workflowAuthority:authority}).start(input); }
    catch { this.store.updateContinuationAction(card.cardId,card.revision,slot,'attempted','unknown'); }
    return this.get(raw);
  }
  async startFocusedReview(raw,context,reviewId,fix,commit,fixResult) {
    const {card,ticket}=context,harness=this.manager.harness;
    const origin=fix.intent.origin_review_id;
    const slot=`focused-review-${hash(origin).slice(0,32)}`;
    if (this.store.continuationAction(card.cardId,card.revision,slot)) return this.get(raw);
    const workflow=harness.workflowHistory.current.get(ticket.id);
    const review=workflow?.snapshot.reviews.find(value=>value.review_id===reviewId);
    const subjectIdentity=workflow && identity(workflow.snapshot.subject);
    if (!workflow || review?.status!=='pending' || review.original_review_id!==origin
      || review.subject_identity!==subjectIdentity || git(ticket.expected_worktree,'rev-parse','HEAD')!==commit.oid)
      fail('COMPANION_FOCUSED_SUBJECT_CONFLICT');
    const authorizationRef=`companion-continuation:${card.cardId}:${card.revision}:${slot}`;
    const active=this.manager.workflowAgentAuthority?.snapshot(ticket.key,'focused-review',authorizationRef)?.policy;
    if (!active || active.workflow_phase!=='review' || active.permission_selection!=='owner-native-default')
      fail('COMPANION_FOCUSED_POLICY_UNAVAILABLE');
    const rawIdentity=harness.changes.facts.currentIdentity(ticket.comparison_baseline);
    if (rawIdentity?.completeness!=='complete') fail('COMPANION_FOCUSED_CONTENT_UNVERIFIED');
    const contentIdentity={scheme:rawIdentity.scheme,version:rawIdentity.version,
      scope:rawIdentity.scope,completeness:rawIdentity.completeness,digest:rawIdentity.digest};
    const requestId=`companion:${hash(`${card.cardId}:${card.revision}:${slot}`).slice(0,64)}`;
    const resultPath=this.evidence.resultPath(ticket.expected_worktree,slot);
    const authorization={schema_version:1,authorization_id:authorizationRef,ticket_key:ticket.key,
      action:'focused-review',authorization_ref:authorizationRef,
      subject_ref:workflow.snapshot.subject.subject_id,subject_identity:subjectIdentity,
      authority_refs:[ticket.reference,authorizationRef],review_id:reviewId,
      finding_batch:fix.intent.batch};
    const input={schema_version:1,action:'focused-review',ticket_id:ticket.id,request_id:requestId,
      authorization_ref:authorizationRef,review_id:reviewId,
      expected:{workflow_revision:workflow.workflow_revision,
        subject_ref:workflow.snapshot.subject.subject_id,subject_identity:subjectIdentity,
        content_identity:contentIdentity,policy:policyId(active)},finding_batch:fix.intent.batch};
    const intent={schema_version:1,action:'focused-review',request_id:requestId,
      origin_review_id:origin,predecessor:{commit_oid:commit.oid,fix_result_sha256:fixResult.sha256},
      policy:active,authorization,result_path:resultPath,launcher_input:input};
    const claimed=this.store.claimContinuationAction(card.cardId,card.revision,slot,intent);
    if (claimed.conflict) fail('COMPANION_FOCUSED_INTENT_CONFLICT');
    if (claimed.deduplicated) return this.get(raw);
    mkdirSync(path.dirname(resultPath),{recursive:true});
    const service=this;
    const authority={snapshot(ticketKey,action,observedRef) {
      const current=service.locator(raw);
      const activePolicy=service.manager.workflowAgentAuthority?.snapshot(ticketKey,action,observedRef)?.policy;
      const nowWorkflow=harness.workflowHistory.current.get(ticket.id);
      if (current.card.content.endpoint!=='to-pr' || ticketKey!==ticket.key || action!=='focused-review'
        || observedRef!==authorizationRef || activePolicy?.digest!==active.digest
        || nowWorkflow?.workflow_revision!==workflow.workflow_revision
        || git(ticket.expected_worktree,'rev-parse','HEAD')!==commit.oid)
        fail('COMPANION_FOCUSED_AUTHORITY_CONFLICT');
      return {policy:active,authorization,source:{schema_version:1,kind:'adapter',
        reference:authorizationRef,canonical_path:null,sha256:hash(JSON.stringify(intent))},
        companion_result_path:resultPath};
    }};
    this.store.updateContinuationAction(card.cardId,card.revision,slot,'reserved','attempted');
    try { await new WorkflowAgentLauncher({manager:this.manager,harness,
      workflowAuthority:authority}).start(input); }
    catch { this.store.updateContinuationAction(card.cardId,card.revision,slot,'attempted','unknown'); }
    return this.get(raw);
  }
  async collectAcceptance(raw,context,receipt) {
    const {card,ticket,link,binding}=context,harness=this.manager.harness;
    const workflow=harness.workflowHistory.current.get(ticket.id);
    if (!workflow || workflow.snapshot.phase!=='acceptance'
      || harness.workflowHistory.source.assess(ticket,workflow.snapshot).state!=='verified')
      fail('COMPANION_ACCEPTANCE_SUBJECT_UNVERIFIED');
    const design=this.evidence.readResult(ticket.expected_worktree,'ticket-design','ticket-design');
    const plan=design.state==='completed' ? design.value.acceptance_plan:null;
    if (!plan?.length) return {...receipt,next_action:{action:'collect-acceptance',state:'blocked',
      reason:'COMPANION_ACCEPTANCE_PLAN_MISSING'}};
    const issueNumber=link.binding_kind==='dispatch' ? card.content.ticket.number:binding.bindings.issue.number;
    const issue=await this.issueSource.details(card.content.repository,issueNumber).catch(()=>null);
    if (!issue || issue.id!==(link.binding_kind==='dispatch'
      ? card.content.ticket.id:binding.bindings.issue.id))
      return {...receipt,next_action:{action:'collect-acceptance',state:'unknown',
        reason:'COMPANION_ACCEPTANCE_ISSUE_UNKNOWN'}};
    const section=/^## Acceptance criteria[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/imu.exec(issue.body)?.[1] ?? '';
    const checklist=section.split(/\r?\n/u).filter(value=>/^\s*- \[[ xX]\] /u.test(value));
    const required=checklist.map((_,index)=>`AC${index+1}`);
    if (!required.length || plan.some(value=>value.source_kind==='pr-delivery')
      || new Set(plan.map(value=>value.criteria_ref)).size!==plan.length
      || plan.some(value=>!/^AC[1-9][0-9]{0,2}$/u.test(value.criteria_ref))
      || required.length!==plan.length
      || required.some(value=>!plan.some(item=>item.criteria_ref===value)))
      return {...receipt,next_action:{action:'collect-acceptance',state:'blocked',
        reason:'COMPANION_ACCEPTANCE_PLAN_SCOPE_CONFLICT'}};
    const snapshot=workflow.snapshot;
    const fix=this.store.continuationActions(raw.card_id,raw.revision)
      .find(value=>value.slot.startsWith('finding-fix-'));
    const subjectKey=fix ? `fix-${hash(fix.intent.origin_review_id).slice(0,32)}`:'implementation';
    const tests=this.mechanical.suiteReceipt(raw,subjectKey);
    const commit=this.mechanical.reconcileCommit(raw,ticket,subjectKey);
    const full=snapshot.reviews.find(value=>value.mode==='full'
      && ['passed','findings'].includes(value.status) && value.applicability==='verified');
    const findingsVerified=snapshot.findings.every(value=>value.status==='verified'
      && value.applicability==='verified');
    const reviewReady=Boolean(full && findingsVerified
      && (snapshot.findings.length===0 ? full.status==='passed'
        : snapshot.reviews.some(value=>value.mode==='focused' && value.status==='passed'
          && value.applicability==='verified' && value.subject_ref===snapshot.subject.subject_id)));
    const implementation=this.actionEvidence(context,'implementation','implementation');
    const criteria=plan.map(item=>{
      let evidence=[];
      if (item.source_kind==='repository-test' && tests.state==='passed'
        && commit.state==='committed' && tests.head===commit.parent)
        evidence=[`owned-task:${tests.task_id}:exit-0`,`git:${commit.oid}`];
      else if (item.source_kind==='git-subject' && commit.state==='committed'
        && snapshot.subject.head===commit.oid) evidence=[`git:${commit.oid}`];
      else if (item.source_kind==='harness-run' && implementation?.state==='completed')
        evidence=[`operation:${implementation.operation_id}`,`run:${implementation.run_id}`];
      else if (item.source_kind==='review' && reviewReady)
        evidence=[`review:${full.review_id}`,
          ...snapshot.reviews.filter(value=>value.mode==='focused').map(value=>`review:${value.review_id}`)];
      else if (item.source_kind==='external-observation') {
        const artifact=snapshot.artifacts.find(value=>value.artifact_id===`acceptance:${item.criteria_ref}`
          && value.role==='acceptance-report' && value.integrity==='observed');
        if (artifact && harness.workflowHistory.source.assess(ticket,snapshot).artifacts
          .some(value=>value.artifact_id===artifact.artifact_id && value.state==='verified'))
          evidence=[`artifact:${artifact.artifact_id}:${artifact.revision}`];
      }
      return {criteria_ref:item.criteria_ref,status:evidence.length ? 'pass':'not-verified',
        evidence,notes:evidence.length ? null:`${item.source_kind} evidence missing`};
    });
    if (!criteria.length) return {...receipt,next_action:{action:'collect-acceptance',state:'blocked',
      reason:'COMPANION_ACCEPTANCE_NO_PRE_PR_CRITERIA'}};
    const accepted=criteria.every(value=>value.status==='pass') && reviewReady;
    if (!accepted) return {...receipt,acceptance_evidence:{criteria,review_ready:reviewReady},
      next_action:{action:'collect-acceptance',state:'blocked',
        reason:'COMPANION_ACCEPTANCE_EVIDENCE_PENDING'}};
    this.movePhase(context,'acceptance','acceptance-collection',
      {plan_sha256:design.sha256,subject_head:snapshot.subject.head},next=>{
        next.acceptance={acceptance_id:`companion-acceptance:${card.cardId}:${card.revision}`,
          status:'passed',actor:{name:'Emilia',method:'deterministic'},
          subject_ref:next.subject.subject_id,criteria,
          evidence:[...new Set(criteria.flatMap(value=>value.evidence))],
          evidence_refs:[],execution_refs:[],
          applicability:'verified',reason:null};
      });
    return this.get(raw);
  }
  async deliverPr(raw,context) {
    const {card,ticket}=context;
    const prior=this.store.continuationAction(card.cardId,card.revision,'pr-delivery');
    if (prior) {
      if (prior.attempt_state==='reserved') {
        const {marker,body_digest,actor,...payload}=prior.intent;
        const suffix=`\n\n${marker}`;
        if (!payload.body.endsWith(suffix)) fail('COMPANION_PR_INTENT_CONFLICT');
        payload.body=payload.body.slice(0,-suffix.length);
        await this.delivery.deliver(raw,payload);
      }
      return this.get(raw);
    }
    const config=this.projects.find(value=>value.projectKey===card.content.projectKey
      && value.repository===card.content.repository);
    if (!config || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(config.baseRef))
      return {...await this.get(raw),next_action:{action:'pr-delivery',state:'blocked',
        reason:'COMPANION_PR_BASE_CONFIG_UNAVAILABLE'}};
    const workflow=this.manager.harness.workflowHistory.current.get(ticket.id);
    const summary=this.manager.harness.workflowHistory.summary(ticket.id);
    if (!summary.acceptance?.accepted || summary.assessment?.state!=='verified')
      fail('COMPANION_PR_ACCEPTANCE_NOT_VERIFIED');
    const fix=this.store.continuationActions(card.cardId,card.revision)
      .find(value=>value.slot.startsWith('finding-fix-'));
    const subjectKey=fix ? `fix-${hash(fix.intent.origin_review_id).slice(0,32)}`:'implementation';
    const commit=this.mechanical.reconcileCommit(raw,ticket,subjectKey);
    if (commit.state!=='committed' || commit.oid!==workflow.snapshot.subject.head)
      return {...await this.get(raw),next_action:{action:'pr-delivery',state:'blocked',
        reason:'COMPANION_PR_COMMIT_UNVERIFIED'}};
    const pushed=this.mechanical.push(raw,ticket,subjectKey,commit);
    if (pushed.state!=='pushed') return {...await this.get(raw),mechanical:pushed,
      next_action:{action:'push',state:pushed.state,reason:pushed.reason ?? null}};
    const issueNumber=context.link.binding_kind==='dispatch'
      ? card.content.ticket.number:context.binding.bindings.issue.number;
    const issue=await this.issueSource.details(card.content.repository,issueNumber).catch(()=>null);
    if (!issue || issue.url!==ticket.reference) return {...await this.get(raw),
      next_action:{action:'pr-delivery',state:'unknown',reason:'COMPANION_PR_ISSUE_UNKNOWN'}};
    let baseOid;
    try { baseOid=await this.delivery.transport.ref(card.content.repository,config.baseRef); }
    catch { return {...await this.get(raw),next_action:{action:'pr-delivery',state:'unknown',
      reason:'COMPANION_PR_BASE_UNKNOWN'}}; }
    const payload={repository:card.content.repository,head_repo:card.content.repository,
      base_repo:card.content.repository,head_ref:pushed.ref,base_ref:config.baseRef,
      head_oid:commit.oid,base_oid:baseOid,ticket_ref:ticket.reference,
      subject_identity:identity(workflow.snapshot.subject),
      acceptance_ref:`workflow:${ticket.id}:${workflow.workflow_revision}`,
      title:`${ticket.key}: ${issue.title}`,
      body:`Closes ${ticket.reference}\n\nAcceptance: workflow revision ${workflow.workflow_revision}\nReviewed head: ${commit.oid}`};
    const delivery=await this.delivery.deliver(raw,payload);
    return {...await this.get(raw),pr_delivery:delivery};
  }
  async deliveryAuthority(raw,intent) {
    const context=this.locator(raw);
    if (context.card.content.endpoint!=='to-pr' || context.card.content.repository!==intent.repository)
      fail('COMPANION_PR_NOT_AUTHORIZED');
    const summary=this.manager.harness.workflowHistory.summary(context.ticket.id);
    if (!summary.acceptance?.accepted || summary.assessment?.state!=='verified')
      fail('COMPANION_PR_ACCEPTANCE_NOT_VERIFIED');
    if (git(context.ticket.expected_worktree,'rev-parse','HEAD')!==intent.head_oid)
      fail('COMPANION_PR_SUBJECT_CHANGED');
    const workflow=this.manager.harness.workflowHistory.current.get(context.ticket.id);
    if (`workflow:${context.ticket.id}:${workflow?.workflow_revision}`!==intent.acceptance_ref
      || identity(workflow.snapshot.subject)!==intent.subject_identity)
      fail('COMPANION_PR_ACCEPTANCE_CHANGED');
    const issueNumber=context.link.binding_kind==='dispatch'
      ? context.card.content.ticket.number:context.binding.bindings.issue.number;
    const issue=await this.issueSource.details(context.card.content.repository,issueNumber).catch(()=>null);
    if (!issue || issue.url!==context.ticket.reference) fail('COMPANION_PR_ISSUE_UNKNOWN');
  }
  mirrorBody(base,notes,digest) {
    return `${base}\n\n<!-- canonical-implementation-notes-sha256: ${digest} -->\n${notes}`;
  }
  issueScope(content,body,title) {
    return hash(JSON.stringify({repository:content.repository,id:content.ticket.id,
      number:content.ticket.number,title,body}));
  }
  async verifyExistingMirror(content,notes,digest) {
    try {
      const issue=await this.issueSource.details(content.repository,content.ticket.number);
      if (!issue || issue.id!==content.ticket.id || issue.title!==content.ticket.title) return false;
      const suffix=`\n\n<!-- canonical-implementation-notes-sha256: ${digest} -->\n${notes}`;
      if (!issue.body.endsWith(suffix)) return false;
      const base=issue.body.slice(0,-suffix.length);
      return this.issueScope(content,base,issue.title)===content.ticket.scope.digest;
    } catch { return false; }
  }
  async mirrorExisting(raw,context) {
    const {card,ticket}=context;
    const filename=path.join(ticket.expected_worktree,`docs/implementation-notes/${ticket.key}.md`);
    const notes=readFileSync(filename,'utf8'),digest=hash(notes);
    const slot='design-mirror';
    const prior=this.store.continuationAction(card.cardId,card.revision,slot);
    if (prior) {
      if (await this.verifyExistingMirror(card.content,notes,digest)) {
        if (prior.attempt_state!=='verified') this.store.updateContinuationAction(card.cardId,card.revision,
          slot,prior.attempt_state,'verified',{notes_sha256:digest});
      }
      return;
    }
    const issue=await this.issueSource.details(card.content.repository,card.content.ticket.number);
    if (!issue || issue.id!==card.content.ticket.id || issue.title!==card.content.ticket.title
      || issue.scope?.digest!==card.content.ticket.scope.digest)
      fail('COMPANION_TICKET_SCOPE_CHANGED');
    const body=this.mirrorBody(issue.body,notes,digest);
    const intent={schema_version:1,repository:card.content.repository,issue_id:issue.id,
      issue_number:issue.number,base_body:issue.body,base_digest:issue.scope.digest,
      body_digest:hash(body),notes_sha256:digest};
    const claimed=this.store.claimContinuationAction(card.cardId,card.revision,slot,intent);
    if (claimed.conflict) fail('COMPANION_MIRROR_INTENT_CONFLICT');
    if (claimed.deduplicated) return;
    const attempted=this.store.updateContinuationAction(card.cardId,card.revision,slot,'reserved','attempted');
    if (attempted.conflict) return;
    try {
      await this.issueTransport.update(card.content.repository,issue.number,body);
      if (await this.verifyExistingMirror(card.content,notes,digest))
        this.store.updateContinuationAction(card.cardId,card.revision,slot,'attempted','verified',
          {notes_sha256:digest});
    } catch { /* A remote update may have succeeded; retry observes the frozen body only. */ }
  }
}
