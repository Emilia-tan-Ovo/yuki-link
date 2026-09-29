import { HarnessError } from '../harness/model.ts';

// Lifecycle choice is made by the journal reservation, not the caller's prompt.
export function dispatchWorkItem(manager: any, receipt: any, input: any, guard: (dispatch: any) => void) {
  if (!receipt.work_item) throw new HarnessError('WORK_ITEM_REQUIRED');
  if (receipt.execution_mode === 'continue') {
    if (!receipt.continuation_session_id || typeof manager.sendGuarded !== 'function')
      throw new HarnessError('WORK_ITEM_CONTINUATION_UNAVAILABLE');
    const { cwd: _cwd, ...message } = input;
    return manager.sendGuarded({ ...message, session_id: receipt.continuation_session_id }, guard);
  }
  return manager.startGuarded(input, guard);
}
