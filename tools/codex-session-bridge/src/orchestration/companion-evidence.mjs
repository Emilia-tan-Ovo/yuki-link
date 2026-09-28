import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const actions = new Set(['ticket-design','implementation','review','finding-fix','focused-review']);
const safe = /^[A-Za-z0-9._/-]{1,240}$/u;

export class CompanionEvidenceAdapter {
  constructor({manager}) { this.manager=manager; }
  resultPath(worktree,slot) {
    if (!safe.test(slot) || slot.includes('..')) throw Error('COMPANION_RESULT_PATH_INVALID');
    return path.join(worktree,'.local','workflow-artifacts',slot,'result.json');
  }
  readResult(worktree,slot,action) {
    const filename=this.resultPath(worktree,slot);
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
        || reportStat.size>64*1024 || !realpathSync(report).startsWith(realpathSync(worktree)+path.sep))
        return {state:'unknown',reason:'COMPANION_REPORT_UNTRUSTED'};
      return {state:value.status,sha256:hash(bytes),value,filename,
        report:{path:report,sha256:hash(readFileSync(report))}};
    } catch { return {state:'unknown',reason:'COMPANION_RESULT_MISSING'}; }
  }
  operation(ticketId,requestId,action,slot,worktree) {
    const operations=this.manager.harness.executionOperations;
    const operation=operations.findByRequest(ticketId,requestId);
    if (!operation || operation.workflow_agent?.action && operation.workflow_agent.action!==action)
      return {state:'unknown',reason:'COMPANION_OPERATION_UNKNOWN'};
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
    const result=this.readResult(worktree,slot,action);
    return {...result,operation_id:operation.operation_id,run_id:run.id,
      session_id:receipt.runtime.session_id,receipt};
  }
}
