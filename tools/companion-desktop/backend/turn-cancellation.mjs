export class TurnCancelledError extends Error {
  constructor() { super('当前回复已取消。'); this.name = 'TurnCancelledError'; }
}

// Observe late resolve/reject even when a provider ignores its AbortSignal.
export function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new TurnCancelledError());
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
