import { BackendSession } from './session.mjs';
import { deepSeekProvider, previewProvider } from './provider.mjs';
import { LocalPersistenceError } from './dialogue-pipeline.mjs';
import { TurnCancelledError } from './turn-cancellation.mjs';
import { validRequestId } from '../desktop/turn-contract.mjs';
import { WorkerVoice } from './voice-worker.mjs';
import { githubIssueSource } from './github-issue-source.mjs';
import { harnessCandidateSource } from './harness-candidate-source.mjs';
import { loadEngineeringConfig } from './engineering-coordinator.mjs';

export function createWorkerHandler({ post, createVoice, createSession = data => new BackendSession({ directory: data.directory, provider: data.preview ? previewProvider() : deepSeekProvider(data.key), mode: data.preview ? 'preview' : 'real', issueSource: githubIssueSource(), candidateSources: [harnessCandidateSource({url:data.workbenchUrl || process.env.YUKI_HARNESS_URL})].filter(Boolean), engineeringConfig: data.preview ? null : loadEngineeringConfig(data.directory) }) }) {
  let session, generation, voice, configRevision, preview;
  return async data => {
    if (data?.type === 'start') {
      voice?.close(); session?.close(); session = undefined; generation = data.generation;
      configRevision = Number.isSafeInteger(data.configRevision) ? data.configRevision : 0; preview = data.preview;
      try { session = createSession(data); voice = new WorkerVoice({ config: data.voiceConfig, key: data.voiceKey, preview: data.preview, post, createVoice }); post({ type: 'ready', status: session.status(), history: session.displayHistory() }); }
      catch { post({ type: 'disconnected' }); }
      return;
    }
    if (data?.type === 'close') { voice?.close(); session?.close(); session = undefined; post({ type: 'closed' }); return; }
    if (!session || data?.generation !== generation) { data?.wav?.fill(0); return; }
    if (data.type === 'candidate-source-configure') { session.setCandidateSource?.(harnessCandidateSource({url:data.workbenchUrl || process.env.YUKI_HARNESS_URL})); return; }
    if (data.type === 'voice-configure') {
      if (!Number.isSafeInteger(data.configRevision) || data.configRevision <= configRevision) return;
      voice?.close();
      configRevision = data.configRevision;
      voice = new WorkerVoice({ config: data.voiceConfig, key: data.voiceKey, preview, post, createVoice });
      return;
    }
    if (['voice-start', 'voice-asr', 'voice-tts', 'voice-stop'].includes(data.type)) { await voice.handle(data, session); return; }
    if (data.type === 'media-readiness') { session.mediaReadiness = data.readiness; return; }
    const owner = session;
    const identity = { id: data.requestId ?? data.id, requestId: data.requestId ?? data.id, generation, origin: data.origin, voiceScope: data.voiceScope };
  try {
    if (data?.type === 'wechat') {
      const reply = value => { if (session === owner) post({ type: 'wechat-result', id: data.id, ...value }); };
      const action = data.action;
      if (action === 'lookup') {
        const receipt = owner.operationReceipt(data.operationId, data.payloadDigest);
        reply({ outcome: 'committed', receipt, memoryRevision: owner.memory.memoryRevision() });
      } else if (action === 'cancel') {
        const cancelled = owner.cancel(data.requestId);
        reply({ outcome: cancelled.outcome === 'cancelled' ? 'cancelled' : cancelled.outcome === 'alreadyCommitted' ? 'committed' : 'unknown', receipt: owner.operationReceipt(data.operationId, data.payloadDigest) });
      } else if (action === 'list') {
        reply({ outcome: 'committed', entries: owner.listMemories(), memoryRevision: owner.memory.memoryRevision() });
      } else if (!['submit','remember','correct','forget'].includes(action) || !validRequestId(data.requestId) || !/^[a-f0-9]{64}$/u.test(data.payloadDigest ?? '') || data.operationId !== data.requestId) {
        reply({ outcome: 'rejected', reason: 'invalid_input' });
      } else {
        const operation = { operationId: data.operationId, payloadDigest: data.payloadDigest };
        const existing = owner.operationReceipt(operation.operationId, operation.payloadDigest);
        if (existing) { reply({ outcome: 'committed', receipt: existing, memoryRevision: owner.memory.memoryRevision() }); return; }
        if (owner.busy) { reply({ outcome: 'rejected', reason: 'busy' }); return; }
        if (action === 'submit') {
          if (!owner.provider) { reply({ outcome: 'rejected', reason: 'unconfigured' }); return; }
          const result = await owner.submit(data.text, data.roleCard, data.thinking, { requestId: data.requestId, operation });
          reply({ outcome: 'committed', finalText: result.text, turnId: result.messages[0].turnId, messageId: result.messages[1].id, memoryRevision: owner.memory.memoryRevision() });
        } else {
          let entry;
          if (action === 'remember') entry = owner.remember({ text: data.text, sourceKind: 'explicit_chat', operation });
          if (action === 'correct') entry = owner.correctMemory(data.targetId, data.text, operation);
          if (action === 'forget') entry = owner.forgetMemory(data.targetId, operation);
          reply({ outcome: 'committed', entryId: entry.id, finalText: action === 'remember' ? '已记住。' : action === 'correct' ? '已更正。' : '已遗忘。', memoryRevision: owner.memory.memoryRevision() });
        }
      }
    } else if (data?.type === 'submit' && typeof data.text === 'string' && validRequestId(identity.requestId)) {
      voice.bindSubmit(data);
      const result = await owner.submit(data.text, data.roleCard, data.thinking, identity);
      if (session === owner) post({ type: 'reply', ...identity, ...result });
    } else if (data?.type === 'cancel-model' && validRequestId(identity.requestId)) {
      post({ type: 'cancel-ack', ...identity, ...owner.cancel(identity.requestId), status: owner.status() });
    } else if (data?.type === 'memory' && session) {
      let entry;
      if (data.action === 'remember') entry = session.remember({ text: data.text, sourceKind: data.sourceKind, sourceRef: data.sourceRef });
      else if (data.action === 'correct') entry = session.correctMemory(data.targetId, data.text);
      else if (data.action === 'forget') entry = session.forgetMemory(data.targetId);
      else if (data.action !== 'list') throw Error('陪伴记忆操作无效。');
      post({ type: 'memory', id: data.id, action: data.action, entry, entries: session.listMemories() });
    } else if (data?.type === 'engineering-card' && session) {
      const result = await session.cardCommand(data);
      if (session === owner) post({ type: 'engineering-card', id: data.id, action: data.action, ...result });
      if (data.action === 'confirm' && result.card?.dispatchId && owner.engineering && !result.conflict && !result.invalid) {
        post({ type:'engineering-status', cardId:result.card.cardId, revision:result.card.revision,
          state:'turn-starting' });
        void owner.engineering.dispatch(result.card).then(value => {
          if (session === owner) post({ type:'engineering-status', cardId:result.card.cardId,
            revision:result.card.revision, ...value });
        }).catch(() => { if (session === owner) post({ type:'engineering-status', cardId:result.card.cardId,
          revision:result.card.revision, state:'turn-unknown' }); });
      }
      if (data.action === 'confirm' && result.card?.preparationStatus === 'authorized'
        && owner.engineering && !result.conflict && !result.invalid) {
        void owner.engineering.prepare(result.card).then(status => {
          if (session === owner) post({type:'engineering-status',cardId:result.card.cardId,
            revision:result.card.revision,status});
        }).catch(() => { if (session === owner) post({type:'engineering-status',cardId:result.card.cardId,
          revision:result.card.revision,state:'preparation-unknown'}); });
      }
    }
  } catch (error) {
    if (session !== owner) return;
    if (data?.type === 'wechat') {
      let receipt = null;
      try { if (validRequestId(data.operationId) && /^[a-f0-9]{64}$/u.test(data.payloadDigest ?? '')) receipt = owner.operationReceipt(data.operationId, data.payloadDigest); } catch { /* conflicting identity is a rejection */ }
      const outcome = receipt ? 'committed' : error instanceof TurnCancelledError ? 'cancelled' : /^(上一条|DeepSeek|对话输入|陪伴记忆|请选择|这条|Operation identity)/u.test(error.message ?? '') ? 'rejected' : 'unknown';
      post({ type: 'wechat-result', id: data.id, outcome, reason: outcome === 'rejected' ? /上一条/u.test(error.message) ? 'busy' : /DeepSeek/u.test(error.message) ? 'unconfigured' : /Operation identity/u.test(error.message) ? 'identity_conflict' : 'invalid_input' : undefined, receipt });
      return;
    }
    if (error instanceof TurnCancelledError) return;
    // No command bodies or credentials in diagnostics or UI.
    const known = error instanceof LocalPersistenceError || error instanceof Error && /^(请输入|DeepSeek|文字服务|上一条|角色卡|记忆输入|对话输入|陪伴记忆|请选择|这条)/.test(error.message);
    post({ type: data?.type === 'memory' ? 'memory-error' : data?.type === 'engineering-card' ? 'engineering-card-error' : 'error', ...identity, status: owner.status(), message: data?.type === 'engineering-card' ? '工程卡片操作未完成，请检查输入或稍后重试。' : known ? error.message : data?.type === 'memory' ? '陪伴记忆未能保存，请稍后重试。' : '这次文字交流没有完成，请检查网络或稍后重试。' });
  }
  };
}

if (process.parentPort) {
  const handle = createWorkerHandler({ post: value => process.parentPort.postMessage(value) });
  process.parentPort.on('message', ({ data }) => { void handle(data); });
}
