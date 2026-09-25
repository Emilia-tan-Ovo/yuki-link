import { BackendSession } from './session.mjs';
import { deepSeekProvider, previewProvider } from './provider.mjs';
import { LocalPersistenceError } from './dialogue-pipeline.mjs';
import { TurnCancelledError } from './turn-cancellation.mjs';
import { validRequestId } from '../desktop/turn-contract.mjs';
import { WorkerVoice } from './voice-worker.mjs';

export function createWorkerHandler({ post, createVoice, createSession = data => new BackendSession({ directory: data.directory, provider: data.preview ? previewProvider() : deepSeekProvider(data.key), mode: data.preview ? 'preview' : 'real' }) }) {
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
    if (data?.type === 'submit' && typeof data.text === 'string' && validRequestId(identity.requestId)) {
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
    }
  } catch (error) {
    if (session !== owner || error instanceof TurnCancelledError) return;
    // No command bodies or credentials in diagnostics or UI.
    const known = error instanceof LocalPersistenceError || error instanceof Error && /^(请输入|DeepSeek|文字服务|上一条|角色卡|记忆输入|对话输入|陪伴记忆|请选择|这条)/.test(error.message);
    post({ type: data?.type === 'memory' ? 'memory-error' : 'error', ...identity, status: owner.status(), message: known ? error.message : data?.type === 'memory' ? '陪伴记忆未能保存，请稍后重试。' : '这次文字交流没有完成，请检查网络或稍后重试。' });
  }
  };
}

if (process.parentPort) {
  const handle = createWorkerHandler({ post: value => process.parentPort.postMessage(value) });
  process.parentPort.on('message', ({ data }) => { void handle(data); });
}
