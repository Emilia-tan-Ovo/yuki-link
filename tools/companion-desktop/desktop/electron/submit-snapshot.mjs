export function submittedTurn(value, store) {
  return { type: 'submit', text: value.text, id: value.id, roleCard: store.snapshot().roleCard };
}
