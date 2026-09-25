// Adapted from AAAAGENT desktop/electron/main.mjs at
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. See THIRD_PARTY_NOTICES.md.
import { app, BrowserWindow, ipcMain, protocol, Menu, dialog, safeStorage, shell, utilityProcess } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { assetResponse } from './assets.mjs';
import { normalizeCredential } from './credential.mjs';
import { SettingsStore } from './settings-store.mjs';
import { submittedTurn } from './submit-snapshot.mjs';
import { validRequestId, VOICE_COMMANDS } from '../turn-contract.mjs';
import { VoiceTurnCoordinator } from './voice-turn.mjs';

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

let win, rendererReady = false, currentStatus, settings, quitting = false, smokeSubmittedThinking;
const dataDir = () => app.getPath('userData');
const deliver = message => { if (rendererReady && win && !win.isDestroyed()) win.webContents.send('yuki:delivery', message); };
const voice = new VoiceTurnCoordinator(); // No capture/provider/playback installed in Phase A.
const connection = new BackendConnection({ worker: resolve(here, '../../backend/worker.mjs'), fork: (...args) => utilityProcess.fork(...args), onMessage: (message, generation) => {
  currentStatus = message?.status ?? currentStatus;
  if (message.type === 'disconnected') voice.disconnect();
  if (message.type === 'cancel-ack') voice.acknowledge(message);
  if (message.type === 'reply' || message.type === 'error') voice.complete(message.requestId);
  deliver({ ...message, generation });
} });
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'yuki://app/index.html';
const settingsFile = () => join(dataDir(), 'settings.json');
const credentialFile = () => join(dataDir(), 'credential.bin');
async function key() {
  try { return safeStorage.decryptString(await readFile(credentialFile())); }
  catch { return ''; }
}
async function start() {
  voice.disconnect();
  connection.start({ directory: dataDir(), key: preview ? '' : await key(), preview });
  deliver({ type: 'connection', state: 'connecting', generation: connection.generation, workbenchUrl: settings.snapshot().workbenchUrl });
}
function workbenchUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.port) return null;
    return url.href;
  } catch { return null; }
}
async function checkWorkbench() {
  const url = workbenchUrl(settings.snapshot().workbenchUrl);
  if (!url) return { configured: false, reachable: false };
  try { const result = await fetch(url, { signal: AbortSignal.timeout(2000) }); return { configured: true, reachable: Boolean(result.ok && result.headers.get('content-type')?.includes('text/html') && (await result.text()).includes('Yuki Harness')) }; }
  catch { return { configured: true, reachable: false }; }
}

ipcMain.on('yuki:ready', event => { if (!trusted(event) || rendererReady) return; rendererReady = true; void start(); });
ipcMain.on('yuki:submit', (event, value) => {
  if (!trusted(event) || !value || !validRequestId(value.requestId)) return;
  const identity = { id: value.requestId, requestId: value.requestId, generation: value.generation, origin: value.origin, voiceScope: value.voiceScope };
  try {
    const submitted = submittedTurn(value, settings);
    if (value.generation !== connection.generation || connection.state !== 'ready') { deliver({ type: 'error', ...identity, message: '文字服务尚未连接。' }); return; }
    if (!['typed', 'voice-final'].includes(submitted.origin)) return;
    if (submitted.origin === 'voice-final' && !voice.acceptSubmit(value.voiceScope, value.requestId, submitted.text)) { deliver({ type: 'error', ...identity, message: '语音回合已失效，未提交文字。' }); return; }
    if (submitted.origin === 'typed' && voice.current) {
      // Pending capture/transcription is discarded; output stop never controls engineering.
      if (['preparing', 'listening', 'transcribing', 'awaiting-submit'].includes(voice.state)) voice.cancel(voice.current.scope);
      else voice.stopOutput(voice.current.scope);
    }
    if (smoke) smokeSubmittedThinking = submitted.thinking;
    if (!connection.send(submitted, value.generation)) deliver({ type: 'error', ...identity, message: '文字服务尚未连接。' });
  } catch { deliver({ type: 'error', ...identity, message: '请输入不超过 20000 字的文字。' }); }
});
ipcMain.on('yuki:cancel-model', (event, value) => {
  if (!trusted(event) || !value || !validRequestId(value.requestId)) return;
  if (value.origin === 'voice-final') {
    if (!voice.matches(value.voiceScope) || voice.current.requestId !== value.requestId) return;
    voice.cancel(value.voiceScope);
  }
  const command = { type: 'cancel-model', requestId: value.requestId, origin: value.origin, voiceScope: value.voiceScope };
  if (!connection.send(command, value.generation)) deliver({ ...command, type: 'cancel-ack', generation: value.generation, outcome: 'unknown-after-disconnect' });
});
ipcMain.on('yuki:voice-command', (event, value) => {
  if (!trusted(event) || !value || value.schemaVersion !== 1 || value.generation !== connection.generation || !VOICE_COMMANDS.includes(value.action)) return;
  if (value.action === 'start') {
    const result = voice.start(connection.generation);
    deliver({ type: 'voice-state', generation: connection.generation, ...result });
    if (result.outcome === 'unavailable') deliver({ type: 'notice', text: '语音采集、识别和播放尚未实现，文字聊天仍可使用。' });
    return;
  }
  if (!voice.matches(value.scope)) return;
  if (value.action === 'stop-output') voice.stopOutput(value.scope);
  if (value.action === 'finish') voice.finish(value.scope);
  if (value.action === 'cancel-turn') {
    const result = voice.cancel(value.scope);
    if (result.requestId && !connection.send({ type: 'cancel-model', requestId: result.requestId, origin: 'voice-final', voiceScope: value.scope }, value.generation)) {
      deliver({ type: 'cancel-ack', requestId: result.requestId, origin: 'voice-final', voiceScope: value.scope, generation: value.generation, outcome: 'unknown-after-disconnect' });
    }
  }
  deliver({ type: 'voice-state', generation: connection.generation, scope: value.scope, state: voice.state });
});
ipcMain.on('yuki:memory', (event, value) => {
  if (!trusted(event) || !value || typeof value.id !== 'string' || !['list','remember','correct','forget'].includes(value.action)) return;
  const invalid = () => deliver({ type: 'memory-error', id: value.id, generation: connection.generation, message: '陪伴记忆输入无效，请检查事实和目标。' });
  const command = { type: 'memory', id: value.id, action: value.action };
  if (value.action === 'remember') {
    if (typeof value.text !== 'string' || value.text.length > 300 || !['explicit_chat','selected_user_message'].includes(value.sourceKind)) { invalid(); return; }
    command.text = value.text; command.sourceKind = value.sourceKind;
    if (value.sourceKind === 'selected_user_message') command.sourceRef = value.sourceRef;
  }
  if (value.action === 'correct') { if (typeof value.text !== 'string' || value.text.length > 300) { invalid(); return; } command.text = value.text; }
  if (value.action === 'correct' || value.action === 'forget') { if (typeof value.targetId !== 'string') { invalid(); return; } command.targetId = value.targetId; }
  if (!connection.send(command, value.generation)) deliver({ type: 'memory-error', id: value.id, generation: connection.generation, message: '文字服务尚未连接，记忆操作未完成。' });
});
ipcMain.on('yuki:credential', event => {
  if (!trusted(event) || preview) return;
  void (async () => {
    if (!safeStorage.isEncryptionAvailable()) { deliver({ type: 'notice', text: '此设备的系统凭据加密不可用，未保存 Key。' }); return; }
    const result = await dialog.showOpenDialog(win, { title: '导入 DeepSeek Key 文件', properties: ['openFile'], filters: [{ name: '文本文件', extensions: ['txt', 'key'] }] });
    if (result.canceled || result.filePaths.length !== 1) return;
    const raw = await readFile(result.filePaths[0]);
    if (raw.length > 4096) throw Error('凭据文件过大');
    const value = normalizeCredential(raw.toString('utf8'));
    await writeFile(credentialFile(), safeStorage.encryptString(value), { mode: 0o600 });
    deliver({ type: 'notice', text: '凭据已保存在本机加密存储；尚未通过真实请求验证。' });
    await start();
  })().catch(() => deliver({ type: 'notice', text: '凭据导入失败，请检查所选文件。' }));
});
ipcMain.on('yuki:workbench-save', (event, value) => {
  if (!trusted(event) || typeof value !== 'string') return;
  const url = workbenchUrl(value);
  if (!url) { deliver({ type: 'workbench', configured: false, reachable: false, error: '请输入本机工作台地址，例如 http://127.0.0.1:端口/' }); return; }
  void settings.saveWorkbenchUrl(url).then(async () => deliver({ type: 'workbench', ...await checkWorkbench(), url })).catch(() => deliver({ type: 'workbench', configured: false, reachable: false, error: '工作台地址未能保存。' }));
});
ipcMain.on('yuki:workbench-check', event => { if (trusted(event)) void checkWorkbench().then(value => deliver({ type: 'workbench', ...value, url: settings.snapshot().workbenchUrl })); });
ipcMain.on('yuki:workbench-open', event => {
  if (!trusted(event)) return;
  void checkWorkbench().then(value => value.reachable ? shell.openExternal(settings.snapshot().workbenchUrl) : deliver({ type: 'workbench', ...value, url: settings.snapshot().workbenchUrl, error: '工程工作台当前不可达。' }));
});
ipcMain.on('yuki:persona-load', event => { if (trusted(event)) deliver({ type: 'persona', action: 'load', roleCard: settings.snapshot().roleCard, warning: settings.warning }); });
ipcMain.on('yuki:persona-save', (event, value) => {
  if (!trusted(event)) return;
  void Promise.resolve().then(() => settings.saveRoleCard(value)).then(saved => deliver({ type: 'persona', action: 'save', roleCard: saved.roleCard })).catch(error => deliver({ type: 'persona', action: 'save', error: error.message.startsWith('角色卡') ? error.message : '角色卡未能保存。' }));
});
ipcMain.on('yuki:persona-reset', event => {
  if (!trusted(event)) return;
  void settings.resetRoleCard().then(saved => deliver({ type: 'persona', action: 'reset', roleCard: saved.roleCard })).catch(() => deliver({ type: 'persona', action: 'reset', error: '默认角色卡未能保存。' }));
});
ipcMain.on('yuki:thinking-load', event => { if (trusted(event)) deliver({ type: 'thinking', action: 'load', thinking: settings.snapshot().thinking, warning: settings.warning }); });
ipcMain.on('yuki:thinking-save', (event, value) => {
  if (!trusted(event)) return;
  void Promise.resolve().then(() => settings.saveThinking(value)).then(saved => deliver({ type: 'thinking', action: 'save', thinking: saved.thinking })).catch(error => deliver({ type: 'thinking', action: 'save', error: error.message.startsWith('思考设置') ? error.message : '思考设置未能保存。' }));
});
ipcMain.on('yuki:quit', event => { if (trusted(event)) app.quit(); });

void app.whenReady().then(async () => {
  await mkdir(dataDir(), { recursive: true });
  settings = await SettingsStore.load(settingsFile());
  const root = resolve(here, '..');
  win = new BrowserWindow({ title: 'Yuki Link · Emilia', width: 1120, height: 760, minWidth: 760, minHeight: 540, backgroundColor: '#f7f4ff', show: !smoke,
    webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:yuki-desktop' } });
  await win.webContents.session.protocol.handle('yuki', request => assetResponse(root, request.url));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Yuki Link', submenu: [{ role: 'quit' }] }, { role: 'editMenu' }]));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => { rendererReady = false; voice.disconnect(); void connection.close(); });
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
      if (option('--smoke-phase') === 'first') {
        let composerReady = false;
        while (Date.now() < deadline) {
          composerReady = await win.webContents.executeJavaScript("!document.getElementById('text').disabled && !document.getElementById('send').disabled");
          if (composerReady) break;
          await new Promise(done => setTimeout(done, 100));
        }
        if (!composerReady) throw Error('Composer was not ready for memory command');
        await win.webContents.executeJavaScript("document.getElementById('text').value='记住：喜欢红茶';document.getElementById('form').requestSubmit()");
        let remembered = false;
        while (Date.now() < deadline) {
          remembered = await win.webContents.executeJavaScript("document.getElementById('notice').textContent.includes('已记住')");
          if (remembered) break;
          await new Promise(done => setTimeout(done, 100));
        }
        if (!remembered) throw Error('Memory remember did not commit through renderer');
        await win.webContents.executeJavaScript("document.getElementById('settings-open').click()");
        let listed = false;
        while (Date.now() < deadline) {
          listed = await win.webContents.executeJavaScript("document.getElementById('memory-target').children.length > 1");
          if (listed) break;
          await new Promise(done => setTimeout(done, 100));
        }
        if (!listed) throw Error('Committed memory was not listed');
        await win.webContents.executeJavaScript("const target=document.getElementById('memory-target');target.value=target.children[1].value;document.getElementById('memory-text').value='喜欢绿茶';document.getElementById('memory-correct').click()");
        let corrected = false;
        while (Date.now() < deadline) {
          corrected = await win.webContents.executeJavaScript("document.getElementById('memory-status').textContent.includes('已更正')");
          if (corrected) break;
          await new Promise(done => setTimeout(done, 100));
        }
        if (!corrected) throw Error('Memory correction did not commit through renderer');
        await win.webContents.executeJavaScript("document.getElementById('settings').close()");
      }
      if (option('--smoke-phase') === 'reopen') {
        await win.webContents.executeJavaScript("document.getElementById('settings-open').click()");
        let restoredMemory = false;
        while (Date.now() < deadline) {
          restoredMemory = await win.webContents.executeJavaScript("document.getElementById('memory-target').children.length > 1 && document.getElementById('memory-target').children[1].textContent.includes('喜欢绿茶')");
          if (restoredMemory) break;
          await new Promise(done => setTimeout(done, 100));
        }
        if (!restoredMemory) throw Error('Corrected memory was not restored on reopen');
        await win.webContents.executeJavaScript("const target=document.getElementById('memory-target');target.value=target.children[1].value;document.getElementById('memory-forget').click()");
        let forgotten = false;
        while (Date.now() < deadline) {
          forgotten = await win.webContents.executeJavaScript("document.getElementById('memory-status').textContent.includes('已从本机有效陪伴记忆移除') && document.getElementById('memory-target').children.length === 1");
          if (forgotten) break;
          await new Promise(done => setTimeout(done, 100));
        }
        if (!forgotten) throw Error('Memory forgetting did not commit through renderer');
        await win.webContents.executeJavaScript("document.getElementById('settings').close()");
      }
      if (option('--smoke-phase') === 'first') {
        let loaded = false;
        while (Date.now() < deadline) {
          loaded = await win.webContents.executeJavaScript("!document.getElementById('thinking-quick').disabled");
          if (loaded) break;
          await new Promise(done => setTimeout(done, 150));
        }
        if (!loaded) throw Error('Thinking setting was not loaded');
        await win.webContents.executeJavaScript("const quick=document.getElementById('thinking-quick');quick.value='high';quick.dispatchEvent(new Event('change',{bubbles:true}))");
        let saved = false;
        while (Date.now() < deadline) {
          saved = settings.snapshot().thinking.enabled && settings.snapshot().thinking.effort === 'high' && await win.webContents.executeJavaScript("!document.getElementById('send').disabled");
          if (saved) break;
          await new Promise(done => setTimeout(done, 150));
        }
        if (!saved) throw Error('Quick Thinking selection was not saved');
      }
      if (option('--smoke-phase') === 'reopen') {
        let restored = false;
        while (Date.now() < deadline) {
          restored = await win.webContents.executeJavaScript("!document.getElementById('thinking-quick').disabled && document.getElementById('thinking-quick').value === 'high'");
          if (restored) break;
          await new Promise(done => setTimeout(done, 150));
        }
        if (!restored) throw Error('Quick Thinking selection was not restored');
      }
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
      if (!smokeSubmittedThinking?.enabled || smokeSubmittedThinking.effort !== 'high') throw Error('Submit did not capture saved Thinking effort');
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
  voice.disconnect();
  void connection.close().finally(() => { win?.destroy(); app.quit(); });
});
