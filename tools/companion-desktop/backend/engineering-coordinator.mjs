import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCompanionTurn, validateDshConfig } from './dsh/runner.mjs';
import { getEngineeringReceipt, prepareNewRequirement, getPreparationReceipt,
  getContinuationReceipt, preparationConflictSources } from './yca-engineering-client.mjs';

const preparationConflict = error => {
  const value = typeof error?.code === 'string' ? error.code : error?.message;
  return preparationConflictSources.has(value) ? value : null;
};

export function loadEngineeringConfig(directory) {
  const file = join(directory,'engineering-runtime.json');
  if (!existsSync(file)) return { configured:false, reason:'engineering-runtime.json 尚未配置' };
  try { const value = JSON.parse(readFileSync(file,'utf8')); validateDshConfig(value); return { configured:true, value }; }
  catch { return { configured:false, reason:'工程运行配置或固定 DSH 版本无效' }; }
}

export class EngineeringCoordinator {
  constructor({ store, config, runTurn = runCompanionTurn, receipt = getEngineeringReceipt,
    prepareRequirement = prepareNewRequirement, preparationReceipt = getPreparationReceipt,
    continuationReceipt = getContinuationReceipt }) {
    this.store = store; this.config = config; this.runTurn = runTurn; this.receipt = receipt;
    this.prepareRequirement = prepareRequirement; this.preparationReceipt = preparationReceipt;
    this.continuationReceipt = continuationReceipt;
  }
  input(card) {
    const envelope = this.store.envelope(card.cardId,card.revision);
    if (!envelope || envelope.dispatch_id !== card.dispatchId) return null;
    return { schema_version:1, card_store_id:envelope.card_store_id, card_id:card.cardId,
      revision:card.revision, dispatch_id:envelope.dispatch_id };
  }
  preparationInput(card) { return { card_store_id:this.store.storeId,
    card_id:card.cardId,revision:card.revision }; }
  async prepare(card) {
    if (card.preparationStatus !== 'authorized') return this.status(card);
    try { const receipt = await this.prepareRequirement(this.config.ycaUrl,this.preparationInput(card));
      return { preparation:receipt }; }
    catch (error) {
      const blocker = preparationConflict(error);
      if (blocker) {
        try {
          const receipt = await this.preparationReceipt(this.config.ycaUrl,this.preparationInput(card));
          if (receipt?.unknown_side_effects?.length === 0) {
            const source = preparationConflictSources.get(blocker);
            const blocked = section => ({...section,state:'blocked',
              blockers:[blocker,...(section?.blockers ?? []).filter(value => value !== blocker)],
              source_refs:[...new Set([...(section?.source_refs ?? []),source])]});
            return {preparation:{...receipt,preparation_for_ticket_design:blocked(receipt.preparation_for_ticket_design),
              next_action_readiness:blocked(receipt.next_action_readiness)}};
          }
        } catch { /* Receipt cannot establish whether side effects are known. */ }
      }
      return { preparation:{ preparation_for_ticket_design:{state:'unknown',
        blockers:['PREPARATION_OUTCOME_UNKNOWN']},unknown_side_effects:['preparation-transport'] } };
    }
  }
  async status(card) {
    const continuationInput=this.preparationInput(card);
    let continuation=null;
    try { if (card.state==='confirmed') continuation=await this.continuationReceipt(this.config.ycaUrl,continuationInput); }
    catch { /* An unavailable projection does not change the original dispatch/preparation fact. */ }
    if (card.content.resolution?.status === 'explicit_new_requirement') {
      try { return { preparation:await this.preparationReceipt(this.config.ycaUrl,this.preparationInput(card)),
        continuation,endpoint:continuation?.endpoint ?? card.content.endpoint,
        workflow:continuation?.workflow ?? null,acceptance:continuation?.acceptance ?? null,
        pr_delivery:continuation?.pr_delivery ?? {state:'unknown'},
        run:continuation?.initial_run ?? null }; }
      catch { return { preparation:{ preparation_for_ticket_design:{state:'unknown',
        blockers:['PREPARATION_RECEIPT_UNAVAILABLE']},unknown_side_effects:[] } }; }
    }
    const input = this.input(card);
    if (!input) return { card_dispatch:'not-dispatched', dsh_turn:'not-started', engineering_operation:null,
      run:null, workflow:null, acceptance:null, pr_delivery:{state:'unknown'} };
    let receipt = null;
    try { receipt = await this.receipt(this.config.ycaUrl,input); } catch { /* Outcome remains unknown. */ }
    const dispatch = this.store.dispatch(card.cardId,card.revision);
    return { card_dispatch:this.store.get(card.cardId)?.dispatchStatus ?? 'unknown',
      dsh_turn:dispatch?.producer_state ?? 'unknown', dsh_receipt:dispatch?.producer_receipt ? JSON.parse(dispatch.producer_receipt) : null,
      engineering_operation:receipt ? { id:receipt.operation_id,state:receipt.operation_state,
        reconciliation:receipt.reconciliation } : null,
      run:continuation?.initial_run ?? receipt?.run ?? null,
      workflow:continuation?.workflow ?? receipt?.workflow ?? null,
      acceptance:continuation?.acceptance ?? receipt?.acceptance ?? null,
      pr_delivery:continuation?.pr_delivery ?? receipt?.pr_delivery ?? {state:'unknown'},
      endpoint:continuation?.endpoint ?? card.content.endpoint,
      next_action:continuation?.next_action ?? null,
      continuation,receipt, observed_at:new Date().toISOString() };
  }
  async dispatch(card) {
    const input = this.input(card);
    if (!input) return { state:'reconfirm-required', status:await this.status(card) };
    const attempt = this.store.producerAttempt(card.cardId,card.revision,card.dispatchId);
    if (attempt.conflict) return { state:'conflict', status:await this.status(card) };
    if (attempt.deduplicated) return { state:'already-started', status:await this.status(card) };
    let turn = { state:'turn-unknown', exit_code:null, summary:null };
    try { turn = await this.runTurn(this.config,input); }
    catch { /* A transport/process failure may follow YCA acceptance. Never replay the turn. */ }
    this.store.producerOutcome(card.cardId,card.revision,card.dispatchId,turn.state,turn);
    return { state:turn.state, dsh_turn:{ state:turn.state, exit_code:turn.exit_code,
      summary:turn.summary }, status:await this.status(card) };
  }
}
