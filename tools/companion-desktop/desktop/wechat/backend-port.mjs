/** Versioned, narrow capability. The shared worker owns all chat and memory facts. */
export function backendPort(port) {
  for (const method of ['submit', 'list', 'remember', 'correct', 'forget', 'lookup']) {
    if (typeof port?.[method] !== 'function') throw Error('Shared backend port unavailable');
  }
  const final = async promise => {
    const result = await promise;
    return { outcome: result?.outcome ?? (result?.committed === true ? 'committed' : 'unknown'), reason: result?.reason, finalText: result?.finalText, turnId: result?.turnId, messageId: result?.messageId, memoryRevision: result?.memoryRevision, receipt: result?.receipt };
  };
  return Object.freeze({
    generation: () => port.generation?.() ?? null,
    submit: input => final(port.submit({ version: 1, text: input.text, operationId: input.operationId, payloadDigest: input.payloadDigest, bindingEpoch: input.bindingEpoch, origin: 'wechat' })),
    list: async input => {
      const result = await port.list({ version: 1, bindingEpoch: input.bindingEpoch });
      return { outcome: result?.outcome ?? (result?.committed === true ? 'committed' : 'unknown'), reason: result?.reason, listVersion: result?.listVersion ?? String(result?.memoryRevision ?? ''), memoryRevision: result?.memoryRevision,
        entries: Array.isArray(result?.entries) ? result.entries.map(row => ({ id: row?.id, text: row?.text })) : null,
      };
    },
    remember: input => final(port.remember({ version: 1, operationId: input.operationId, payloadDigest: input.payloadDigest, bindingEpoch: input.bindingEpoch, text: input.text, sourceKind: 'explicit_chat', sourceRef: input.sourceRef })),
    correct: input => final(port.correct({ version: 1, operationId: input.operationId, payloadDigest: input.payloadDigest, bindingEpoch: input.bindingEpoch, targetId: input.targetId, text: input.text })),
    forget: input => final(port.forget({ version: 1, operationId: input.operationId, payloadDigest: input.payloadDigest, bindingEpoch: input.bindingEpoch, targetId: input.targetId })),
    lookup: async input => {
      const result = await port.lookup({ version: 1, operationId: input.operationId, payloadDigest: input.payloadDigest });
      return result?.receipt ?? (result?.committed === true ? result : null);
    },
    cancel: input => port.cancel?.({ version: 1, operationId: input.operationId, bindingEpoch: input.bindingEpoch }),
  });
}
