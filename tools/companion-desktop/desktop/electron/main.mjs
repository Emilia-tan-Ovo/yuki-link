// Adapted from AAAAGENT desktop/electron/main.mjs at
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. See THIRD_PARTY_NOTICES.md.
import { app, BrowserWindow, ipcMain, protocol, Menu, dialog, safeStorage, shell } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { assetResponse } from './assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const smoke = process.argv.includes('--smoke-test');
const preview = smoke || process.argv.includes('--offline-preview');
app.setName('Yuki Link Desktop');
const smokeData = option('--smoke-data');
if (smoke && smokeData && isAbsolute(smokeData)) app.setPath('userData', smokeData);
else app.setPath('userData', join(app.getPath('appData'), preview ? 'Yuki Link Desktop Preview' : 'Yuki Link Desktop'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'yuki', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win, rendererReady = false, currentStatus, settings = { workbenchUrl: '' }, quitting = false;
const dataDir = () => app.getPath('userData');
const deliver = message => { if (rendererReady && win && !win.isDestroyed()) win.webContents.send('yuki:delivery', message); };
const connection = new BackendConnection({ worker: resolve(here, '../../backend/worker.mjs'), onMessage: (message, generation) => { currentStatus = message?.status ?? currentStatus; deliver({ ...message, generation }); } });
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'yuki://app/index.html';
const settingsFile = () => join(dataDir(), 'settings.json');
const credentialFile = () => join(dataDir(), 'credential.bin');
async function key() {
  try { return safeStorage.decryptString(await readFile(credentialFile())); }
  catch { return ''; }
}
async function start() {
  connection.start({ directory: dataDir(), key: preview ? '' : await key(), preview });
  deliver({ type: 'connection', state: 'connecting', generation: connection.generation, workbenchUrl: settings.workbenchUrl });
}
function workbenchUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.port) return null;
    return url.href;
  } catch { return null; }
}
async function checkWorkbench() {
  const url = workbenchUrl(settings.workbenchUrl);
  if (!url) return { configured: false, reachable: false };
  try { const result = await fetch(url, { signal: AbortSignal.timeout(2000) }); return { configured: true, reachable: Boolean(result.ok && result.headers.get('content-type')?.includes('text/html') && (await result.text()).includes('Yuki Harness')) }; }
  catch { return { configured: true, reachable: false }; }
}

ipcMain.on('yuki:ready', event => { if (!trusted(event) || rendererReady) return; rendererReady = true; void start(); });
ipcMain.on('yuki:submit', (event, value) => {
  if (!trusted(event) || !value || typeof value.text !== 'string' || value.text.length > 20000 || typeof value.id !== 'string') return;
  if (!connection.send({ type: 'submit', text: value.text, id: value.id }, value.generation)) deliver({ type: 'error', id: value.id, message: '文字服务尚未连接。' });
});
ipcMain.on('yuki:credential', event => {
  if (!trusted(event) || preview) return;
  void (async () => {
    if (!safeStorage.isEncryptionAvailable()) { deliver({ type: 'notice', text: '此设备的系统凭据加密不可用，未保存 Key。' }); return; }
    const result = await dialog.showOpenDialog(win, { title: '导入 DeepSeek Key 文件', properties: ['openFile'], filters: [{ name: '文本文件', extensions: ['txt', 'key'] }] });
    if (result.canceled || result.filePaths.length !== 1) return;
    const raw = await readFile(result.filePaths[0]);
    if (raw.length > 4096) throw Error('凭据文件过大');
    const value = raw.toString('utf8').trim();
    if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(value)) throw Error('凭据文件格式不正确');
    await writeFile(credentialFile(), safeStorage.encryptString(value), { mode: 0o600 });
    deliver({ type: 'notice', text: '凭据已保存在本机加密存储；尚未通过真实请求验证。' });
    await start();
  })().catch(() => deliver({ type: 'notice', text: '凭据导入失败，请检查所选文件。' }));
});
ipcMain.on('yuki:workbench-save', (event, value) => {
  if (!trusted(event) || typeof value !== 'string') return;
  const url = workbenchUrl(value);
  if (!url) { deliver({ type: 'workbench', configured: false, reachable: false, error: '请输入本机工作台地址，例如 http://127.0.0.1:端口/' }); return; }
  settings.workbenchUrl = url;
  void writeFile(settingsFile(), JSON.stringify(settings), { mode: 0o600 }).then(async () => deliver({ type: 'workbench', ...await checkWorkbench(), url })).catch(() => deliver({ type: 'workbench', configured: false, reachable: false, error: '工作台地址未能保存。' }));
});
ipcMain.on('yuki:workbench-check', event => { if (trusted(event)) void checkWorkbench().then(value => deliver({ type: 'workbench', ...value, url: settings.workbenchUrl })); });
ipcMain.on('yuki:workbench-open', event => {
  if (!trusted(event)) return;
  void checkWorkbench().then(value => value.reachable ? shell.openExternal(settings.workbenchUrl) : deliver({ type: 'workbench', ...value, url: settings.workbenchUrl, error: '工程工作台当前不可达。' }));
});
ipcMain.on('yuki:quit', event => { if (trusted(event)) app.quit(); });

void app.whenReady().then(async () => {
  await mkdir(dataDir(), { recursive: true });
  try { const saved = JSON.parse(await readFile(settingsFile(), 'utf8')); if (workbenchUrl(saved.workbenchUrl)) settings.workbenchUrl = saved.workbenchUrl; } catch {}
  const root = resolve(here, '..');
  win = new BrowserWindow({ title: 'Yuki Link · Emilia', width: 1120, height: 760, minWidth: 760, minHeight: 540, backgroundColor: '#f7f4ff', show: !smoke,
    webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:yuki-desktop' } });
  await win.webContents.session.protocol.handle('yuki', request => assetResponse(root, request.url));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Yuki Link', submenu: [{ role: 'quit' }] }, { role: 'editMenu' }]));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => { rendererReady = false; void connection.close(); });
  win.on('closed', () => app.quit());
  await win.loadURL('yuki://app/index.html');
  if (smoke) {
    try {
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline) {
        ready = await win.webContents.executeJavaScript("document.getElementById('service').dataset.state === 'offline-preview'");
        if (ready) break;
        await new Promise(done => setTimeout(done, 150));
      }
      if (!ready) throw Error('Renderer/backend did not become ready');
      const before = await win.webContents.executeJavaScript("document.querySelectorAll('#messages .message').length");
      if (option('--smoke-phase') === 'reopen' && before < 2) throw Error('History was not restored');
      await win.webContents.executeJavaScript("document.getElementById('text').value='packaged smoke';document.getElementById('form').requestSubmit()");
      let replied = false;
      while (Date.now() < deadline) {
        replied = await win.webContents.executeJavaScript("document.querySelectorAll('#messages .message').length >= " + (before + 2));
        if (replied) break;
        await new Promise(done => setTimeout(done, 150));
      }
      if (!replied) throw Error('Renderer -> IPC -> backend -> renderer round trip failed');
      await win.webContents.executeJavaScript("document.getElementById('about-open').click()");
      let license = false;
      for (let attempt = 0; attempt < 20 && !license; attempt++) {
        license = await win.webContents.executeJavaScript("document.getElementById('license').textContent.includes('AAAAGENT 非商业使用及署名许可 1.0')");
        if (!license) await new Promise(done => setTimeout(done, 100));
      }
      if (!license) throw Error('Packaged About/License is unavailable');
      await win.webContents.executeJavaScript("document.getElementById('about').close()");
      if (option('--screenshot')) {
        win.showInactive();
        await new Promise(done => setTimeout(done, 300));
        await writeFile(option('--screenshot'), (await win.webContents.capturePage()).toPNG());
      }
      console.log(`YUKI_PACKAGED_SMOKE_OK phase=${option('--smoke-phase') || 'first'} prior=${before}`);
    } catch (error) { console.error('YUKI_PACKAGED_SMOKE_FAILED ' + error.message); process.exitCode = 1; }
    app.quit();
  }
}).catch(error => { console.error('Yuki startup failed: ' + error.message); app.exit(1); });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void connection.close().finally(() => { win?.destroy(); app.quit(); });
});
