import { EngineeringCardStore, digestCardContent } from '../../../companion-desktop/backend/engineering-card-store.mjs';

const terminal = new Set(['completed','failed','stopped','timed_out','interrupted']);
const observed = (state,source,detail=null) => ({state,source,observed_at:new Date().toISOString(),detail});

// The card database owns intent; Harness and Workflow remain the sources of execution state.
export class CompanionWorkControlService {
  constructor({manager,directory,computer=null,store=new EngineeringCardStore(directory)}) {
    this.manager=manager; this.computer=computer; this.store=store;
  }
  start() {
    const wake=()=>{ for (const item of this.store.workStops()) void this.requestStop({schema_version:1,
      card_store_id:this.store.storeId,card_id:item.cardId,revision:item.revision,
      control_id:item.controlId}).catch(()=>{}); };
    wake(); this.timer=setInterval(wake,20_000); this.timer.unref?.();
  }
  close() { if (this.timer) clearInterval(this.timer); this.store.close(); }
  locator(input) {
    if (input?.schema_version!==1 || input.card_store_id!==this.store.storeId
      || typeof input.card_id!=='string' || !Number.isSafeInteger(input.revision)
      || input.revision<1) throw Error('COMPANION_CONTROL_INPUT_INVALID');
    const card=this.store.get(input.card_id);
    if (!card || card.revision!==input.revision || card.state!=='confirmed'
      || card.confirmation?.revision!==input.revision
      || digestCardContent(card.content)!==digestCardContent(card.confirmation.content))
      throw Error('COMPANION_CONTROL_CARD_CONFLICT');
    return card;
  }
  operation(ticketId,requestId) {
    if (!ticketId || !requestId) return {request_id:requestId,observation:observed('unknown','execution-operations')};
    const operations=this.manager.harness.executionOperations;
    const original=operations.findByRequest(ticketId,requestId);
    if (!original) return {request_id:requestId,observation:observed('unknown','execution-operations','REQUEST_NOT_FOUND')};
    let receipt;
    try { receipt=operations.reconcile(original.operation_id); }
    catch { return {request_id:requestId,operation_id:original.operation_id,
      observation:observed('unknown','execution-operations','RECONCILIATION_UNAVAILABLE')}; }
    const runtime=receipt.runtime;
    if (!runtime?.run_id || !runtime.session_id) return {request_id:requestId,
      operation_id:original.operation_id,operation:receipt,
      observation:observed(receipt.effective_state==='reconciliation-required'?'unknown':'current',
        'execution-operations',receipt.effective_state)};
    try {
      const run=this.manager.harness.source.runs(runtime.session_id).find(value=>value.id===runtime.run_id);
      if (!run) throw Error('RUN_NOT_FOUND');
      const binding=[...this.manager.harness.bindings.values()].find(value=>
        value.ticket_id===ticketId && value.session_id===runtime.session_id
          && value.conversation_id===receipt.destination?.conversation_id
          && (!receipt.binding_id || value.id===receipt.binding_id)
          && (value.scope==='session' || value.run_id===runtime.run_id));
      const verified=!!binding && receipt.effective_state!=='reconciliation-required';
      return {request_id:requestId,operation_id:original.operation_id,operation:receipt,
        run:{session_id:runtime.session_id,run_id:runtime.run_id,status:run.status,
          binding_id:binding?.id ?? null,manageable:verified && !terminal.has(run.status)},
        observation:observed(verified?'current':'unknown','codex-manager',verified?null:'BINDING_OR_OPERATION_UNVERIFIED')};
    } catch { return {request_id:requestId,operation_id:original.operation_id,operation:receipt,
      observation:observed('unknown','codex-manager','RUN_UNAVAILABLE')}; }
  }
  async get(input) {
    const card=this.locator(input), stop=this.store.workStop(card.cardId,card.revision);
    const link=this.store.continuation(card.cardId,card.revision);
    const dispatch=this.store.dispatch(card.cardId,card.revision);
    const preparation=this.store.preparation(card.cardId,card.revision);
    const claim=dispatch?.claim ? JSON.parse(dispatch.claim):null;
    const ticketId=link?.ticket_id ?? claim?.ticket_id ?? preparation?.bindings?.harness?.ticketId ?? null;
    const requests=new Set();
    if (claim?.request_id) requests.add(claim.request_id);
    if (preparation?.preparationId && ticketId) requests.add(`companion-prep:${preparation.preparationId}:ticket-design`);
    const actions=this.store.continuationActions(card.cardId,card.revision);
    for (const action of actions) if (action.intent?.request_id && !action.slot.startsWith('boundary:'))
      requests.add(action.intent.request_id);
    const operations=[...requests].map(requestId=>this.operation(ticketId,requestId));
    const tasks=[];
    for (const action of actions.filter(value=>value.slot.startsWith('full-suite:'))) {
      const taskId=action.receipt?.task_id;
      if (!taskId) { tasks.push({request_id:action.intent?.request_id,observation:observed('unknown','yca-owned-task','TASK_RECEIPT_MISSING')}); continue; }
      try {
        const task=this.computer?.tasks?.status({task_id:taskId});
        const binding=this.manager.harness.taskHistory?.target(ticketId,taskId)?.binding;
        if (!binding || binding.request_id!==action.intent.request_id
          || binding.service_epoch!==action.receipt.service_epoch)
          throw Error('TASK_BINDING_CONFLICT');
        tasks.push({request_id:action.intent.request_id,task_id:taskId,service_epoch:action.receipt.service_epoch,
          status:task?.status ?? 'unknown',manageable:!!task && !terminal.has(task.status),
          observation:observed(task?'current':'unknown','yca-owned-task')});
      } catch { tasks.push({request_id:action.intent.request_id,task_id:taskId,
        observation:observed('unknown','yca-owned-task','TASK_UNAVAILABLE')}); }
    }
    let workflow=null,acceptance=null,prDelivery=null;
    if (ticketId) {
      try { workflow=this.manager.harness.workflowHistory.summary(ticketId);
        acceptance=workflow?.acceptance ?? null; }
      catch { workflow={observation:observed('unavailable','harness-workflow')}; }
      try { if (link) prDelivery=await this.manager.companionContinuation?.delivery?.reconcile(input,{persist:false}); }
      catch { prDelivery={state:'unknown',observation:observed('unavailable','github')}; }
    }
    const unresolved=operations.some(value=>value.observation.state!=='current' || value.operation?.effective_state==='reconciliation-required')
      || tasks.some(value=>value.observation.state!=='current');
    const active=operations.some(value=>value.run?.manageable) || tasks.some(value=>value.manageable);
    return {schema_version:1,card_store_id:this.store.storeId,card_id:card.cardId,revision:card.revision,
      card:{state:card.state,confirmation:card.confirmation,dispatch_status:card.dispatchStatus,
        preparation_id:preparation?.preparationId ?? null,observation:observed('current','card-sqlite')},
      ticket_id:ticketId,initial_operation:operations[0] ?? null,operations,tasks,
      workflow,acceptance,pr_delivery:prDelivery,
      control:stop ? {control_id:stop.control_id,requested_at:stop.requested_at,
        state:unresolved?'unknown':active?'requested':'blocked-further-work',
        targets:this.store.workStopTargets(card.cardId,card.revision)}:null,
      observation:observed(unresolved?'unknown':'current','companion-control'),
      observed_at:new Date().toISOString()};
  }
  async requestStop(input) {
    const card=this.locator(input);
    const stop=this.store.workStop(card.cardId,card.revision);
    if (!stop || stop.control_id!==input.control_id
      || stop.confirmation_digest!==digestCardContent(card.confirmation.content))
      throw Error('COMPANION_CONTROL_INTENT_CONFLICT');
    const status=await this.get(input);
    for (const operation of status.operations) {
      if (!operation.run?.manageable || operation.observation.state!=='current') continue;
      const target={kind:'run',ticket_id:status.ticket_id,request_id:operation.request_id,
        operation_id:operation.operation_id,session_id:operation.run.session_id,
        run_id:operation.run.run_id,binding_id:operation.run.binding_id};
      const key=`run:${operation.operation_id}:${operation.run.run_id}`;
      const claimed=this.store.claimWorkStopTarget(card.cardId,card.revision,key,target);
      if (claimed.conflict || claimed.deduplicated) continue;
      // A lost control receipt stays unknown. Reconnection observes the frozen target, never repeats stop.
      this.store.recordWorkStopAttempt(card.cardId,card.revision,key,1,{state:'unknown',started_at:new Date().toISOString()});
      let receipt;
      try { receipt=this.manager.harness.controls.stopRun(status.ticket_id,target.run_id,target.binding_id); }
      catch (error) { receipt={outcome:'request_failed',reason:error?.code ?? 'RUN_CONTROL_UNAVAILABLE'}; }
      this.store.recordWorkStopAttempt(card.cardId,card.revision,key,2,{state:receipt.outcome,receipt});
    }
    for (const task of status.tasks) {
      if (!task.manageable || task.observation.state!=='current') continue;
      const target={kind:'task',ticket_id:status.ticket_id,request_id:task.request_id,
        task_id:task.task_id,service_epoch:task.service_epoch};
      const key=`task:${task.task_id}`;
      const claimed=this.store.claimWorkStopTarget(card.cardId,card.revision,key,target);
      if (claimed.conflict || claimed.deduplicated) continue;
      this.store.recordWorkStopAttempt(card.cardId,card.revision,key,1,{state:'unknown',started_at:new Date().toISOString()});
      let receipt;
      try { receipt=this.manager.harness.controls.stopTask(status.ticket_id,target.task_id); }
      catch (error) { receipt={outcome:'request_failed',reason:error?.code ?? 'TASK_CONTROL_UNAVAILABLE'}; }
      this.store.recordWorkStopAttempt(card.cardId,card.revision,key,2,{state:receipt.outcome,receipt});
    }
    return this.get(input);
  }
}
