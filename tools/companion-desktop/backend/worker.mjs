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
    } else if (data?.type === 'close') {
      session?.close(); session = undefined; post({ type: 'closed' });
    }
  } catch (error) {
    // No command bodies or credentials in diagnostics or UI.
    const known = error instanceof LocalPersistenceError || error instanceof Error && /^(请输入|DeepSeek|文字服务|上一条|角色卡|记忆输入|对话输入)/.test(error.message);
    post({ type: 'error', id: data?.id, status: session?.status(), message: known ? error.message : '这次文字交流没有完成，请检查网络或稍后重试。' });
  }
});
