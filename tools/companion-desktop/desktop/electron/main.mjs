// Adapted from AAAAGENT desktop/electron/main.mjs at
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. See THIRD_PARTY_NOTICES.md.
import { app, BrowserWindow, ipcMain, protocol, Menu, dialog, safeStorage, shell, utilityProcess } from 'electron';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { assetResponse } from './assets.mjs';
import { normalizeCredential } from './credential.mjs';
import { SettingsStore } from './settings-store.mjs';
import { submittedTurn } from './submit-snapshot.mjs';
import { validRequestId, VOICE_COMMANDS } from '../turn-contract.mjs';
import { VoiceTurnCoordinator } from './voice-turn.mjs';
import { VoiceRuntime } from './voice-runtime.mjs';
import { VoiceReadiness } from './voice-readiness.mjs';
import { Live2DResources } from './live2d-runtime.mjs';
import { VoiceCredentialStore, privateVoiceDirectory } from './voice-credential.mjs';

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

let win, rendererReady = false, currentStatus, settings, quitting = false, smokeSubmittedThinking, startRevision = 0;
const dataDir = () => app.getPath('userData');
const deliver = message => { if (rendererReady && win && !win.isDestroyed()) win.webContents.send('yuki:delivery', message); };
const readiness = new VoiceReadiness();
const avatar = new Live2DResources({ settings: { snapshot: () => settings.snapshot(), saveLive2D: value => settings.saveLive2D(value) } });
readiness.live2d = () => avatar.snapshot();
const publishAvatar = () => { deliver({ type: 'live2d-settings', readiness: avatar.snapshot() }); media.publish(); };
const voice = new VoiceTurnCoordinator({ canAttempt: () => readiness.snapshot(!preview && connection.state === 'ready', currentStatus?.service).voice.canAttempt });
let voiceCredentials;
const connection = new BackendConnection({ worker: resolve(here, '../../backend/worker.mjs'), fork: (...args) => utilityProcess.fork(...args), onMessage: (message, generation) => {
  currentStatus = message?.status ?? currentStatus;
  if (media.backend(message, generation)) return;
  if (message.type === 'disconnected') { media.invalidate(); readiness.reset(readiness.configured); }
  if (message.type === 'cancel-ack') voice.acknowledge(message);
  if (message.type === 'reply' || message.type === 'error') voice.complete(message.requestId);
  const memoryTerminal = voice.completeMemory(message, generation);
  if (memoryTerminal) deliver(memoryTerminal);
  deliver({ ...message, generation });
  if (['ready','reply','error','disconnected','cancel-ack'].includes(message.type)) { media.state(); media.publish(); }
} });
const media = new VoiceRuntime({ voice, connection, deliver, settings: { snapshot: () => settings.snapshot() }, readiness, status: () => currentStatus, preview });
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'yuki://app/index.html';
const settingsFile = () => join(dataDir(), 'settings.json');
const credentialFile = () => join(dataDir(), 'credential.bin');
async function key() {
  try { return safeStorage.decryptString(await readFile(credentialFile())); }
  catch { return ''; }
}
async function start() {
  const revision = ++startRevision;
  media.invalidate(); void connection.close();
  deliver({ type: 'connection', state: 'connecting', generation: connection.generation, workbenchUrl: settings.snapshot().workbenchUrl });
  while (revision === startRevision && !quitting) {
    const epoch = media.configurationEpoch;
    await media.configurationQueue;
    const voiceKey = preview ? '' : await voiceCredentials.read();
    const textKey = preview ? '' : await key();
    if (revision !== startRevision || quitting) return;
    // Reconfiguration can replace the queue while either credential read is pending.
    if (epoch !== media.configurationEpoch || media.pendingConfigurations) continue;
    media.configure(!!voiceKey);
    connection.start({ directory: dataDir(), key: textKey, preview, voiceConfig: settings.snapshot().voice, voiceKey, configRevision: readiness.revision });
    deliver({ type: 'connection', state: 'connecting', generation: connection.generation, workbenchUrl: settings.snapshot().workbenchUrl });
    return;
  }
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
      media.stopResources(voice.current.scope);
    }
    if (smoke) smokeSubmittedThinking = submitted.thinking;
    if (!connection.send(submitted, value.generation)) deliver({ type: 'error', ...identity, message: '文字服务尚未连接。' });
    else media.activeModel ??= value.requestId;
  } catch { deliver({ type: 'error', ...identity, message: '请输入不超过 20000 字的文字。' }); }
});
ipcMain.on('yuki:cancel-model', (event, value) => {
  if (!trusted(event) || !value || !validRequestId(value.requestId)) return;
  if (value.origin === 'voice-final') {
    if (!voice.matches(value.voiceScope) || voice.current.requestId !== value.requestId) return;
    voice.cancel(value.voiceScope);
    media.stopResources(value.voiceScope);
  }
  const command = { type: 'cancel-model', requestId: value.requestId, origin: value.origin, voiceScope: value.voiceScope };
  if (!connection.send(command, value.generation)) deliver({ ...command, type: 'cancel-ack', generation: value.generation, outcome: 'unknown-after-disconnect' });
});
ipcMain.on('yuki:voice-command', (event, value) => {
  if (!trusted(event) || !value || value.schemaVersion !== 1 || value.generation !== connection.generation || !VOICE_COMMANDS.includes(value.action)) return;
  media.command(value);
});
ipcMain.on('yuki:voice-event', (event, value) => {
  if (!trusted(event) || !value || value.schemaVersion !== 1 || value.generation !== connection.generation && value.event !== 'cleaned') { if (value?.wav instanceof Uint8Array) value.wav.fill(0); return; }
  media.event(value);
});
ipcMain.on('yuki:voice-load', event => { if (trusted(event)) media.publish(); });
ipcMain.on('yuki:live2d-load', event => { if (trusted(event)) { publishAvatar(); void avatar.refresh().then(publishAvatar); } });
ipcMain.on('yuki:live2d-refresh', event => { if (trusted(event)) { const pending = avatar.refresh(); publishAvatar(); void pending.then(publishAvatar); } });
ipcMain.on('yuki:live2d-reset', event => { if (trusted(event)) { avatar.invalidate(); publishAvatar(); } });
ipcMain.on('yuki:live2d-select', event => {
  if (!trusted(event)) return;
  void (async () => {
    const epoch = avatar.epoch;
    const result = await dialog.showOpenDialog(win, { title: '选择自备的 Live2D model3 文件（仅引用，不复制）', properties: ['openFile'], filters: [{ name: 'Live2D model3', extensions: ['json'] }] });
    if (result.canceled || result.filePaths.length !== 1 || avatar.epoch !== epoch) return;
    const pending = avatar.select(result.filePaths[0]); publishAvatar(); if (!await pending) return;
    deliver({ type: 'notice', text: '模型候选引用已保存；SDK、实际模型加载、绘制与嘴型仍待验证。' });
  })().catch(() => deliver({ type: 'notice', text: '模型候选未能保存，请查看 Live2D 资源状态。' })).finally(publishAvatar);
});
ipcMain.on('yuki:live2d-disable', event => {
  if (!trusted(event)) return;
  void avatar.disable().catch(() => deliver({ type: 'notice', text: 'Live2D 设置未能保存，原配置保留。' })).finally(publishAvatar);
});
ipcMain.on('yuki:voice-save', (event, value) => {
  if (!trusted(event)) return;
  void media.reconfigure(() => settings.saveVoice(value), () => voiceCredentials.read()).then(() => deliver({ type: 'notice', text: '语音设置已保存；服务和设备尚待明确使用验证。' })).catch(() => deliver({ type: 'notice', text: '语音设置未能保存，原设置继续生效。' }));
});
ipcMain.on('yuki:voice-credential', event => {
  if (!trusted(event) || preview) return;
  void (async () => { const result = await dialog.showOpenDialog(win, { title: '导入独立语音服务 Key 文件', properties: ['openFile'], filters: [{ name: '文本文件', extensions: ['txt','key'] }] });
    if (result.canceled || result.filePaths.length !== 1) return;
    await media.reconfigure(() => voiceCredentials.importFile(result.filePaths[0]), () => voiceCredentials.read()); deliver({ type: 'notice', text: '语音凭据已加密保存；尚未验证服务。' });
  })().catch(() => deliver({ type: 'notice', text: '语音凭据导入失败或受限加密存储不可用。' }));
});
ipcMain.on('yuki:memory', (event, value) => {
  if (!trusted(event) || !value || value.generation !== connection.generation || typeof value.id !== 'string' || !['list','remember','correct','forget'].includes(value.action)) return;
  if (value.voiceScope || value.voiceResult) {
    if (value.generation !== connection.generation || !voice.acceptMemory(value)) return;
    if (value.voiceResult === 'management-opened') deliver({ type: 'voice-state', generation: connection.generation, scope: value.voiceScope, state: voice.state, outcome: 'management-opened' });
  }
  const fail = message => {
    const error = { type: 'memory-error', id: value.id, generation: connection.generation, message };
    const terminal = voice.completeMemory(error, connection.generation);
    if (terminal) deliver(terminal);
    deliver(error);
  };
  const invalid = () => fail('陪伴记忆输入无效，请检查事实和目标。');
  const command = { type: 'memory', id: value.id, action: value.action };
  if (value.action === 'remember') {
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 300 || !['explicit_chat','selected_user_message'].includes(value.sourceKind)) { invalid(); return; }
    command.text = value.text; command.sourceKind = value.sourceKind;
    if (value.sourceKind === 'selected_user_message') command.sourceRef = value.sourceRef;
  }
  if (value.action === 'correct') { if (typeof value.text !== 'string' || value.text.length > 300) { invalid(); return; } command.text = value.text; }
  if (value.action === 'correct' || value.action === 'forget') { if (typeof value.targetId !== 'string') { invalid(); return; } command.targetId = value.targetId; }
  if (!connection.send(command, value.generation)) fail('文字服务尚未连接，记忆操作未完成。');
});
ipcMain.on('yuki:engineering-card', (event, value) => {
  if (!trusted(event) || !value || value.generation !== connection.generation || !validRequestId(value.id) || !['list','create','edit','confirm','revoke','refresh'].includes(value.action)) return;
  const command = { type: 'engineering-card', id: value.id, action: value.action };
  if (value.action === 'create') { if (typeof value.original !== 'string' || !value.original.trim() || value.original.length > 20000) return; command.original = value.original; command.focus = value.focus; }
  if (['edit','confirm','revoke','refresh'].includes(value.action)) { if (typeof value.cardId !== 'string' || value.cardId.length > 100) return; command.cardId = value.cardId; }
  if (['edit','confirm','revoke'].includes(value.action)) { if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) return; command.expectedRevision = value.expectedRevision; }
  if (value.action === 'edit') { if (!value.fields || typeof value.fields !== 'object') return; command.fields = value.fields; }
  if (!connection.send(command,value.generation)) deliver({ type: 'engineering-card-error', id: value.id, generation: value.generation, message: '工程卡片后端尚未连接。' });
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
  voiceCredentials = new VoiceCredentialStore(dataDir(), safeStorage, privateVoiceDirectory({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }));
  const root = resolve(here, '..');
  win = new BrowserWindow({ title: 'Yuki Link · Emilia', width: 1120, height: 760, minWidth: 760, minHeight: 540, backgroundColor: '#f7f4ff', show: !smoke,
    webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:yuki-desktop' } });
  await win.webContents.session.protocol.handle('yuki', request => assetResponse(root, request.url));
  const permission = (wc, kind, details, origin, check) => {
    if (kind === 'speaker-selection') return !preview && wc === win?.webContents && wc?.mainFrame?.url === 'yuki://app/index.html' && details?.isMainFrame === true && (check ? ['yuki://app','yuki://app/'].includes(origin) : details.requestingUrl === 'yuki://app/index.html') && voice.state === 'playback-pending' && voice.current?.outputAllowed === true;
    return media.microphonePermission({ webContents: wc, expected: win?.webContents, permission: kind, details, origin, check });
  };
  win.webContents.session.setPermissionCheckHandler((wc, kind, origin, details) => permission(wc, kind, details, origin, true));
  win.webContents.session.setPermissionRequestHandler((wc, kind, callback, details) => callback(permission(wc, kind, details, undefined, false)));
  win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Yuki Link', submenu: [{ role: 'quit' }] }, { role: 'editMenu' }]));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => { rendererReady = false; media.invalidateRendererGone(); void connection.close(); });
  win.webContents.on('render-process-gone', () => avatar.invalidate());
  win.on('closed', () => app.quit());
  await win.loadURL('yuki://app/index.html');
  if (smoke) {
    try {
      if (option('--smoke-phase') === 'voice-credential') {
        if (!smokeData || !isAbsolute(smokeData) || !app.isPackaged) throw Error('Isolated packaged smoke required');
        const source = join(dataDir(), 'smoke-voice-input.txt');
        const fake = 'fixture-packaged-voice-key';
        try {
          await writeFile(source, fake + '\n', { flag: 'wx', mode: 0o600 });
          await voiceCredentials.importFile(source);
          const restored = await voiceCredentials.read();
          if (restored !== fake || (await readFile(voiceCredentials.file)).includes(fake)) throw Error('Credential round trip failed');
          // verify asserts protected DACL, exactly current-user FullControl and inheritance.
          await voiceCredentials.protect(voiceCredentials.directory, 'verify');
        } catch { throw Error('Packaged voice credential verification failed'); }
        finally { await unlink(source).catch(() => {}); }
        console.log('YUKI_PACKAGED_SMOKE_OK phase=voice-credential');
        app.quit(); return;
      }
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline) {
        ready = await win.webContents.executeJavaScript("document.getElementById('service').dataset.state === 'offline-preview'");
        if (ready) break;
        await new Promise(done => setTimeout(done, 150));
      }
      if (!ready) throw Error('Renderer/backend did not become ready');
      const voiceFailureReady = await win.webContents.executeJavaScript("document.getElementById('voice-start').disabled && document.getElementById('voice-readiness').textContent.includes('还需要：')");
      if (!voiceFailureReady) throw Error('Voice unconfigured readiness was not projected');
      const live2dPending = await win.webContents.executeJavaScript("document.getElementById('live2d-status').dataset.ready === 'false' && document.getElementById('live2d-status').textContent.includes('SDK 未配置') && document.getElementById('live2d-status').textContent.includes('模型未配置') && document.getElementById('live2d-canvas').hidden");
      if (!live2dPending || media.publish().live2d.ready) throw Error('Missing Live2D resources were not honestly pending');
      const live2dModules = await win.webContents.executeJavaScript("Promise.all(['live2d-ui.mjs','live2d-loader.mjs','live2d-mouth.mjs'].map(name => fetch('yuki://app/' + name).then(r => r.ok && r.headers.get('content-type') === 'text/javascript'))).then(values => values.every(Boolean))");
      if (!live2dModules) throw Error('Packaged Live2D wiring modules were not served');
      console.log('YUKI_LIVE2D_ACTUAL_PENDING sdk/model/draw/talking; missing-resource wiring only');
      const workletMime = await win.webContents.executeJavaScript("fetch('yuki://app/media/recorder-worklet.mjs').then(r => r.ok && r.headers.get('content-type') === 'text/javascript')");
      if (!workletMime) throw Error('Packaged audio worklet was not served');
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
  media.invalidate();
  avatar.invalidate();
  void connection.close().finally(() => { win?.destroy(); app.quit(); });
});
