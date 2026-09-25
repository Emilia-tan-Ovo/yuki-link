import { BrowserCapture, BrowserPlayback } from './media/devices.mjs';
import { sameVoiceScope } from './turn-contract.mjs';
import { DEFAULT_VOICE } from './voice-config.mjs';
// Renderer owns device resources, while main remains the only turn/cancellation owner.
export class RendererVoice {
  constructor({ host, element, getGeneration, notice, mediaDevices = globalThis.navigator?.mediaDevices, AudioContext = globalThis.AudioContext }) {
    Object.assign(this, { host, element, getGeneration, notice, mediaDevices, AudioContext }); this.scope = null; this.state = 'idle'; this.ready = null; this.settings = { ...DEFAULT_VOICE }; this.revision = null; this.queuedStart = false; this.played = false;
    this.mediaDevices?.addEventListener?.('devicechange', () => { void this.dispose().then(() => { this.event('devices-changed'); return this.devices(); }); });
    globalThis.addEventListener?.('beforeunload', () => { void this.dispose(); });
  }
  event(event, extra = {}, scope = this.scope) { this.host.send('voice-event', { schemaVersion: 1, generation: this.getGeneration(), scope, requestId: scope?.requestId, event, ...extra }); }
  command(action) { this.host.send('voice-command', { schemaVersion: 1, generation: this.getGeneration(), scope: this.scope, action }); }
  update() {
    const $ = this.element;
    $('voice-start').disabled = !this.ready?.voice.canAttempt || this.queuedStart;
    $('voice-finish').disabled = this.state !== 'listening';
    $('voice-cancel').disabled = !this.scope || ['idle','cancelled','error','cancelling'].includes(this.state);
    $('voice-stop').disabled = !['synthesizing','playback-pending','speaking'].includes(this.state);
    $('voice-play').disabled = !this.retryAudio || this.state !== 'playback-pending';
    const states = { idle:'空闲', preparing:'正在准备麦克风', listening:'正在录音', transcribing:'正在识别', 'awaiting-submit':'已识别，等待提交', thinking:'正在回复', synthesizing:'正在合成声音', 'playback-pending':'正在准备播放', speaking:'正在播放', cancelling:'取消结果待确认', cancelled:'已取消', error:'语音未完成' };
    $('voice-state').textContent = states[this.state] ?? this.state;
  }
  async dispose() { const capture = this.capture, playback = this.playback; this.capture = null; this.playback = null; this.retryAudio?.wav.fill(0); this.retryAudio = null; await Promise.all([capture?.cancel(), playback?.stop()]); }
  async resumePlayback() { const message = this.retryAudio; if (!message || !sameVoiceScope(message.scope, this.scope) || this.state !== 'playback-pending') return; this.retryAudio = null; await this.playAudio(message); }
  resumeQueuedStart() { if (this.queuedStart && this.cleaned && ['cancelled','idle','error'].includes(this.state)) { this.queuedStart = false; this.command('start'); } }
  async start() {
    if (!this.ready?.voice.canAttempt || this.queuedStart) return;
    await this.dispose();
    if (this.scope && !['cancelled','error'].includes(this.state)) { this.queuedStart = true; this.cleaned = false; this.command('cancel-turn'); }
    else this.command('start');
    this.update();
  }
  async receive(message) {
    const scope = message.scope;
    if (message.type === 'connection' || message.type === 'disconnected') { this.queuedStart = false; this.scope = null; this.state = 'idle'; this.ready = null; this.update(); await this.dispose(); return; }
    if (message.type === 'voice-settings') {
      this.ready = message.readiness; this.settings = message.voice;
      if (this.revision !== this.ready.voice.configRevision) {
        this.revision = this.ready.voice.configRevision;
        for (const key of ['provider','region','asrModel','ttsModel','voice','inputDevice','outputDevice']) this.element('voice-' + key).value = message.voice[key];
        this.element('voice-enabled').checked = message.voice.enabled;
        void this.devices();
      }
      const v = this.ready.voice;
      this.element('voice-readiness').textContent = `实现：${v.implemented ? '已实现' : '未实现'}；配置：${v.configured ? '已配置' : '未配置/停用'}；独立凭据：${message.credentialConfigured ? '已导入' : '未导入'}；ASR：${v.provider.asr.state}；TTS：${v.provider.tts.state}；权限：${v.device.permission}；采集：${v.device.capture}；播放：${v.playback.state}；可尝试：${v.canAttempt ? '是' : '否'}。缺项：${v.missing.join('、') || '无'}。保存不代表已验证。`;
      this.update(); return;
    }
    if (message.generation !== undefined && message.generation !== this.getGeneration()) { message.wav?.fill(0); return; }
    if (message.type === 'voice-state' && scope) {
      if (this.scope && scope.voiceEpoch < this.scope.voiceEpoch) return;
      if (!sameVoiceScope(scope, this.scope)) { this.scope = scope; this.played = false; }
      this.state = message.state; if (message.error) this.notice(message.error.code === 'AUDIO_LIMIT' ? '录音或合成音频超限，请缩短内容后重试；已提交文字保留。' : `语音未完成：${message.error.stage} / ${message.error.code}。文字历史保留，不会自动重试。`);
      this.resumeQueuedStart();
      this.update(); return;
    }
    if (message.type === 'voice-teardown') {
      if (this.scope && !sameVoiceScope(scope, this.scope)) return;
      try { await this.dispose(); this.event('cleaned', {}, scope); this.cleaned = true; this.resumeQueuedStart(); }
      catch { this.queuedStart = false; this.notice('本地音频清理未确认，请重新打开应用。'); }
      this.update(); return;
    }
    if (!sameVoiceScope(scope, this.scope)) { message.wav?.fill(0); return; }
    if (message.type === 'voice-capture') {
      if (this.capture || this.state !== 'preparing') return;
      const capture = new BrowserCapture({ mediaDevices: this.mediaDevices, AudioContext: this.AudioContext, emit: event => { if (this.capture !== capture || !sameVoiceScope(scope, this.scope)) return; if (event.type === 'listening') this.event('capture-ready', {}, scope); else if (event.type === 'error') this.event('device-error', { code: event.code }, scope); } }); this.capture = capture;
      try { await capture.start({ inputDevice: message.inputDevice }); } catch (e) { if (this.capture === capture && e.message !== 'CANCELLED') this.event('device-error', { code: e.message }, scope); } return;
    }
    if (message.type === 'voice-finish' && this.capture) {
      const capture = this.capture; this.state = 'transcribing'; this.update();
      try { const wav = await capture.finish(); try { if (this.capture === capture && sameVoiceScope(scope, this.scope)) this.event('capture-finished', { wav }, scope); } finally { wav.fill(0); } }
      catch (e) { if (this.capture === capture && e.message !== 'CANCELLED') this.event('device-error', { code: e.message }, scope); }
      finally { await capture.cancel(); if (this.capture === capture) this.capture = null; } return;
    }
    if (message.type === 'voice-play') {
      if (this.played || this.state !== 'playback-pending') { message.wav?.fill(0); return; } this.played = true;
      await this.playAudio(message); return;
    }
  }
  async playAudio(message) {
      const scope = message.scope, retryBytes = message.wav.slice();
      const playback = new BrowserPlayback({ AudioContext: this.AudioContext, emit: event => {
        if (this.playback !== playback || !sameVoiceScope(scope, this.scope)) return;
        if (event.type === 'started') this.event('playback-started', { requestId: message.requestId }, scope);
        if (event.type === 'ended') { this.event('playback-ended', { requestId: message.requestId }, scope); void playback.stop(); }
        if (event.type === 'error') this.event('device-error', { code: event.code, requestId: message.requestId }, scope);
        if (event.type === 'amplitude') this.onAmplitude?.({ scope, requestId: message.requestId, value: event.value });
        if (event.type === 'default-output') this.notice('当前版本不支持指定输出，使用系统默认扬声器。');
      } }); this.playback = playback;
      let retained = false;
      try { await playback.play(message); }
      catch (e) {
        if (this.playback === playback && sameVoiceScope(scope, this.scope) && e.message === 'PLAYBACK_BLOCKED') { this.retryAudio = { ...message, wav: retryBytes }; retained = true; this.event('playback-blocked', { requestId: message.requestId }, scope); this.notice('声音播放被阻止，请点击“播放声音”继续；不会重新调用 TTS。'); }
        else if (this.playback === playback && e.message !== 'CANCELLED') this.event('device-error', { code: e.message }, scope);
      } finally { if (!retained) retryBytes.fill(0); this.update(); }
  }
  save() { const value = { ...DEFAULT_VOICE, enabled: this.element('voice-enabled').checked }; for (const key of ['provider','region','asrModel','ttsModel','voice','inputDevice','outputDevice']) value[key] = this.element('voice-' + key).value; this.host.send('voice-save', value); }
  async devices() {
    if (!this.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await this.mediaDevices.enumerateDevices();
      for (const [key, kind] of [['inputDevice','audioinput'],['outputDevice','audiooutput']]) {
        const select = this.element('voice-' + key), selected = this.settings[key]; select.replaceChildren();
        const add = (value, text) => { const option = select.ownerDocument.createElement('option'); option.value = value; option.textContent = text; select.append(option); };
        add('default', '系统默认');
        if (key === 'outputDevice' && !this.AudioContext?.prototype?.setSinkId) { select.value = 'default'; select.disabled = true; this.element('voice-device-status').textContent = '不支持指定输出；使用系统默认扬声器。'; continue; }
        for (const device of devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default')) add(device.deviceId, device.label || '设备名称待授权');
        if (selected !== 'default' && !devices.some(d => d.kind === kind && d.deviceId === selected)) { add(selected, '所选设备未找到'); this.element('voice-device-status').textContent = '所选设备未找到，请明确重新选择。'; }
        select.value = selected;
      }
    } catch { this.element('voice-device-status').textContent = '设备列表暂不可用；未请求麦克风权限。'; }
  }
}
