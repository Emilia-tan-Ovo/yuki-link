export function submittedTurn(value, store) {
  const snapshot = store.snapshot();
  return { type: 'submit', text: value.text, id: value.id, roleCard: snapshot.roleCard, thinking: snapshot.thinking };
}
