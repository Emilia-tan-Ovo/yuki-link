import { BackendSession } from './session.mjs';
import { deepSeekProvider, previewProvider } from './provider.mjs';
import { LocalPersistenceError } from './dialogue-pipeline.mjs';

let session;
const port = process.parentPort;
const post = value => port.postMessage(value);
port.on('message', async ({ data }) => {
  try {
    if (data?.type === 'start') {
      session?.close();
      session = new BackendSession({ directory: data.directory, provider: data.preview ? previewProvider() : deepSeekProvider(data.key), mode: data.preview ? 'preview' : 'real' });
      post({ type: 'ready', status: session.status(), history: session.displayHistory() });
    } else if (data?.type === 'submit' && session && typeof data.text === 'string') {
      const result = await session.submit(data.text, data.roleCard, data.thinking);
      post({ type: 'reply', id: data.id, ...result });
    } else if (data?.type === 'memory' && session) {
      let entry;
      if (data.action === 'remember') entry = session.remember({ text: data.text, sourceKind: data.sourceKind, sourceRef: data.sourceRef });
      else if (data.action === 'correct') entry = session.correctMemory(data.targetId, data.text);
      else if (data.action === 'forget') entry = session.forgetMemory(data.targetId);
      else if (data.action !== 'list') throw Error('陪伴记忆操作无效。');
      post({ type: 'memory', id: data.id, action: data.action, entry, entries: session.listMemories() });
    } else if (data?.type === 'close') {
      session?.close(); session = undefined; post({ type: 'closed' });
    }
  } catch (error) {
    // No command bodies or credentials in diagnostics or UI.
    const known = error instanceof LocalPersistenceError || error instanceof Error && /^(请输入|DeepSeek|文字服务|上一条|角色卡|记忆输入|对话输入|陪伴记忆|请选择|这条)/.test(error.message);
    post({ type: data?.type === 'memory' ? 'memory-error' : 'error', id: data?.id, status: session?.status(), message: known ? error.message : data?.type === 'memory' ? '陪伴记忆未能保存，请稍后重试。' : '这次文字交流没有完成，请检查网络或稍后重试。' });
  }
});
