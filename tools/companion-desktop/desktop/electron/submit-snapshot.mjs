import { normalizeUserText } from '../turn-contract.mjs';

export function submittedTurn(value, store) {
  const snapshot = store.snapshot();
  return { type: 'submit', text: normalizeUserText(value.text), id: value.requestId ?? value.id, requestId: value.requestId ?? value.id,
    generation: value.generation, origin: value.origin ?? 'typed', voiceScope: value.voiceScope,
    roleCard: snapshot.roleCard, thinking: snapshot.thinking };
}
