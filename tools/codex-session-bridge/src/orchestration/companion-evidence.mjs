import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const actions = new Set(['ticket-design','implementation','review','finding-fix','focused-review']);
const safe = /^[A-Za-z0-9._/-]{1,240}$/u;
export const companionResultIdentity = (worktree,cardId,revision,slot,requestId,
  workflowRevision,subjectRef,subjectIdentity) => {
  if (!safe.test(slot) || slot.includes('..') || typeof cardId!=='string'
    || !Number.isSafeInteger(revision) || revision<1 || typeof requestId!=='string')
    throw Error('COMPANION_RESULT_IDENTITY_INVALID');
  return {card_id:cardId,revision,request_id:requestId,workflow_revision:workflowRevision,
    subject_ref:subjectRef,subject_identity:subjectIdentity,
    result_path:path.join(worktree,'.local','workflow-artifacts','companion',
      hash(`${cardId}:${revision}:${slot}:${requestId}`),slot,'result.json')};
};

export class CompanionEvidenceAdapter {
  constructor({manager}) { this.manager=manager; }
  resultPath(worktree,slot,cardId=null,revision=null,requestId=null) {
    if (!safe.test(slot) || slot.includes('..')) throw Error('COMPANION_RESULT_PATH_INVALID');
    if (cardId===null) return path.join(worktree,'.local','workflow-artifacts',slot,'result.json');
    return companionResultIdentity(worktree,cardId,revision,slot,requestId,
      null,null,null).result_path;
  }
  readResult(worktree,slot,action,expected=null) {
    const filename=expected?.result_path ?? this.resultPath(worktree,slot);
    if (expected && filename!==this.resultPath(worktree,slot,expected.card_id,
      expected.revision,expected.request_id))
      return {state:'unknown',reason:'COMPANION_RESULT_PATH_CONFLICT'};
    try {
      const stat=lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>64*1024
        || !realpathSync(filename).startsWith(realpathSync(worktree)+path.sep))
        return {state:'unknown',reason:'COMPANION_RESULT_UNTRUSTED'};
      const bytes=readFileSync(filename);
      const value=JSON.parse(bytes.toString('utf8'));
      if (value?.schema_version!==1 || value.action!==action || !actions.has(action)
        || !['completed','blocked','incomplete'].includes(value.status)
        || typeof value.report_ref!=='string' || !value.report_ref.trim()
        || !Array.isArray(value.blockers) || value.blockers.length>32
        || value.blockers.some(item => typeof item!=='string' || item.length>240))
        return {state:'unknown',reason:'COMPANION_RESULT_INVALID'};
      if (expected && (value.request_id!==expected.request_id
        || value.operation_id!==expected.operation_id || value.run_id!==expected.run_id
        || value.subject_ref!==expected.subject_ref
        || value.subject_identity!==expected.subject_identity))
        return {state:'unknown',reason:'COMPANION_RESULT_IDENTITY_CONFLICT'};
      if (action==='ticket-design' && (typeof value.product_decision_required!=='boolean'
        || !Array.isArray(value.product_decisions)
        || !Array.isArray(value.acceptance_plan) || value.acceptance_plan.length>32
        || value.acceptance_plan.some(item=>typeof item?.criteria_ref!=='string'
          || !['repository-test','git-subject','harness-run','review',
            'external-observation','agent-session','pr-delivery'].includes(item.source_kind))))
        return {state:'unknown',reason:'COMPANION_DESIGN_RESULT_INVALID'};
      if ((action==='implementation' || action==='finding-fix') && value.status==='completed'
        && (!Array.isArray(value.files) || !value.files.length || value.files.length>256
          || value.files.some(file=>typeof file!=='string' || !/^[A-Za-z0-9_./-]{1,240}$/u.test(file)
            || file.includes('..') || file.startsWith('.local/'))))
        return {state:'unknown',reason:'COMPANION_IMPLEMENTATION_FILES_INVALID'};
      if (action==='review' && (!value.axes || !['passed','findings','incomplete'].includes(value.axes.standards)
        || !['passed','findings','incomplete'].includes(value.axes.spec)
        || !Array.isArray(value.findings)))
        return {state:'unknown',reason:'COMPANION_REVIEW_RESULT_INVALID'};
      if (action==='focused-review' && (!value.axes
        || !['passed','not-applicable','incomplete'].includes(value.axes.standards)
        || !['passed','not-applicable','incomplete'].includes(value.axes.spec)
        || !Array.isArray(value.verified_finding_ids)))
        return {state:'unknown',reason:'COMPANION_FOCUSED_RESULT_INVALID'};
      if (action==='finding-fix' && value.verified===true)
        return {state:'unknown',reason:'COMPANION_FIX_CANNOT_VERIFY'};
      const report=path.isAbsolute(value.report_ref) ? value.report_ref
        : path.join(worktree,value.report_ref);
      const reportStat=lstatSync(report);
      if (!reportStat.isFile() || reportStat.isSymbolicLink() || reportStat.nlink!==1
        || reportStat.size>64*1024 || !realpathSync(report).startsWith(
          realpathSync(expected ? path.dirname(filename):worktree)+path.sep))
        return {state:'unknown',reason:'COMPANION_REPORT_UNTRUSTED'};
      return {state:value.status,sha256:hash(bytes),value,filename,
        report:{path:report,sha256:hash(readFileSync(report))}};
    } catch { return {state:'unknown',reason:'COMPANION_RESULT_MISSING'}; }
  }
  operation(ticketId,requestId,action,slot,worktree,expected=null) {
    const operations=this.manager.harness.executionOperations;
    const operation=operations.findByRequest(ticketId,requestId);
    const protectedAction=action==='implementation' ? 'implementation'
      : action==='review' ? 'review':'workflow_agent';
    if (!operation || operation.request_id!==requestId
      || !operation.protected_intent?.[protectedAction]
      || protectedAction==='workflow_agent'
        && operation.protected_intent.workflow_agent.action!==action)
      return {state:'unknown',reason:'COMPANION_OPERATION_UNKNOWN'};
    if (expected && (operation.protected_intent?.subject_ref!==expected.subject_ref
      || operation.protected_intent?.expected_workflow_revision!==expected.workflow_revision))
      return {state:'unknown',reason:'COMPANION_OPERATION_SUBJECT_CONFLICT'};
    if (['ticket-design','implementation','finding-fix'].includes(action)
      && operation.destination?.kind!=='main')
      return {state:'unknown',reason:'COMPANION_MAIN_DESTINATION_UNKNOWN'};
    if ((action==='review' || action==='focused-review')
      && (operation.destination?.kind!=='child' || operation.destination?.relation?.kind!=='review'))
      return {state:'unknown',reason:'COMPANION_REVIEW_ISOLATION_UNKNOWN'};
    const receipt=operations.reconcile(operation.operation_id);
    if (receipt.effective_state==='reconciliation-required' || !receipt.runtime?.run_id
      || !receipt.runtime?.session_id)
      return {state:'unknown',reason:'COMPANION_OPERATION_RECONCILIATION_REQUIRED',receipt};
    let run;
    try { run=this.manager.harness.source.runs(receipt.runtime.session_id)
      .find(value => value.id===receipt.runtime.run_id); }
    catch { return {state:'unknown',reason:'COMPANION_RUN_OBSERVATION_UNKNOWN',receipt}; }
    if (!run) return {state:'unknown',reason:'COMPANION_RUN_OBSERVATION_UNKNOWN',receipt};
    if (run.status!=='completed') return {state:['failed','stopped','timed_out','interrupted'].includes(run.status)
      ? 'blocked':'waiting',reason:`COMPANION_RUN_${run.status.toUpperCase()}`,receipt};
    const result=this.readResult(worktree,slot,action,expected && {
      ...expected,operation_id:operation.operation_id,run_id:run.id});
    return {...result,operation_id:operation.operation_id,run_id:run.id,
      session_id:receipt.runtime.session_id,receipt};
  }
}
