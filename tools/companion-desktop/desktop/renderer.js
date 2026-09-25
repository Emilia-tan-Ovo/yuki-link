const $ = id => document.getElementById(id);
let generation = 0, service = 'connecting', busy = false, pendingGeneration = null, messages = [];
let personaPending = null;
let thinkingPending = false;
let thinkingDraftVersion = 0, thinkingPendingVersion = null;
const expandedReasoning = new Set();
let personaDraftVersion = 0, personaPendingVersion = null;
const host = window.yukiDesktop;
const label = { connecting: '正在连接', unconfigured: '未配置 DeepSeek', configured: '已配置 · 待验证', verified: 'DeepSeek 已验证', unknown: 'DeepSeek 状态待确认', 'offline-preview': '离线预览 · 非真实回复', disconnected: '服务已断开' };
function state(next) {
  service = next; $('service').dataset.state = next; $('service-label').textContent = label[next] || next;
  $('model-state').textContent = next === 'offline-preview' ? '离线预览：当前使用确定性本地回复，没有发起 DeepSeek 请求。' : next === 'unconfigured' ? 'DeepSeek 凭据未配置；文字发送不可用。' : next === 'configured' ? '凭据已导入，尚未通过真实请求验证。' : next === 'verified' ? '已完成真实 DeepSeek 文字请求。' : '文字服务状态：' + (label[next] || next);
  $('credential').disabled = next === 'offline-preview';
  $('text').disabled = !['offline-preview', 'configured', 'verified', 'unknown'].includes(next) || busy;
  $('send').disabled = $('text').disabled;
}
function render() {
  const log = $('messages'); log.replaceChildren();
  const dateMap = new Map();
  for (const row of messages) {
    const day = new Date(row.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    if (!dateMap.has(day)) { const section = document.createElement('div'); section.className = 'day-divider'; section.textContent = day; section.id = 'day-' + dateMap.size; log.append(section); dateMap.set(day, section.id); }
    const item = document.createElement('article'); item.className = 'message ' + row.role;
    const avatar = document.createElement('div'); avatar.className = 'message-avatar'; avatar.textContent = row.role === 'assistant' ? 'E' : '你';
    const content = document.createElement('div'); const name = document.createElement('div'); name.className = 'message-name'; name.textContent = row.role === 'assistant' ? 'Emilia' : '你';
    const body = document.createElement('div'); body.className = 'message-text'; body.textContent = row.text;
    content.append(name, body);
    if (row.role === 'assistant') {
      const meta = row.metadata;
      if (meta && (meta.requestedThinking || Number.isFinite(meta.fullResponseMs))) {
        const info = document.createElement('div'); info.className = 'message-meta';
        const requested = meta.requestedThinking === 'off' ? '关闭' : meta.requestedThinking;
        info.textContent = [requested ? `请求档位：${requested}` : null, Number.isFinite(meta.fullResponseMs) ? `完整回复耗时：${(meta.fullResponseMs / 1000).toFixed(1)} 秒` : null].filter(Boolean).join(' · ');
        content.append(info);
      }
      if (typeof row.reasoningContent === 'string' && row.reasoningContent.trim()) {
        const details = document.createElement('details'); details.className = 'reasoning'; details.open = expandedReasoning.has(row.id);
        details.addEventListener('toggle', () => { if (details.open) expandedReasoning.add(row.id); else expandedReasoning.delete(row.id); });
        const summary = document.createElement('summary'); summary.textContent = '查看思考内容';
        const reasoning = document.createElement('div'); reasoning.className = 'reasoning-text'; reasoning.textContent = row.reasoningContent;
        details.append(summary, reasoning);
        if (meta?.reasoningTruncated) { const note = document.createElement('p'); note.className = 'reasoning-truncated'; note.textContent = '思考未完整保存'; details.append(note); }
        content.append(details);
      }
    }
    item.append(avatar, content); log.append(item);
  }
  const dates = $('dates'); dates.replaceChildren();
  if (!dateMap.size) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '还没有对话'; dates.append(p); }
  for (const [day, id] of [...dateMap].reverse()) { const button = document.createElement('button'); button.type = 'button'; button.className = 'date-button'; button.textContent = '◷  ' + day; button.onclick = () => $(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); dates.append(button); }
  $('conversation').scrollTop = $('conversation').scrollHeight;
}
function notice(text) { $('notice').textContent = text || ''; }
function roleCardCount() { $('role-card-count').textContent = `${$('role-card').value.length} / 8000 字`; }
function personaStatus(text) { $('role-card-status').textContent = text; }
function personaBusy(value) { $('role-card-save').disabled = value; $('role-card-reset').disabled = value; }
host.subscribe(message => {
  if (message.type === 'connection') { generation = message.generation; state('connecting'); $('workbench-url').value = message.workbenchUrl || ''; host.send('workbench-check'); }
  if (message.type === 'ready') { const interrupted = busy && pendingGeneration !== message.generation; generation = message.generation; messages = message.history; render(); if (interrupted) { busy = false; pendingGeneration = null; } state(message.status.service); notice(interrupted ? '连接已更新，上一条未完成的发送已中断，请重新发送。' : ''); }
  if (message.type === 'reply') { messages.push(...message.messages); render(); busy = false; pendingGeneration = null; $('text').value = ''; state(message.status.service); notice(''); $('text').focus(); }
  if (message.type === 'error') { busy = false; pendingGeneration = null; state(message.status?.service || service); notice(message.message); }
  if (message.type === 'disconnected') { busy = false; pendingGeneration = null; state('disconnected'); notice('文字服务已断开，请重新打开应用。'); }
  if (message.type === 'notice') notice(message.text);
  if (message.type === 'workbench') { const text = message.error || (!message.configured ? '尚未设置本机入口' : message.reachable ? '本机工作台可访问' : '已设置，当前不可达'); $('workbench-state').textContent = text; $('workbench-detail').textContent = text; }
  if (message.type === 'persona') {
    if (message.action === 'load') {
      if (personaPending === null) { $('role-card').value = message.roleCard.text; roleCardCount(); }
      personaStatus(message.warning || '正在使用已保存的角色卡。');
    } else {
      personaBusy(false);
      if (message.error) personaStatus(message.error + ' 草稿仍保留，原角色卡继续生效。');
      else {
        const resetDraftChanged = message.action === 'reset' && personaDraftVersion !== personaPendingVersion;
        if (!resetDraftChanged && (message.action === 'reset' || $('role-card').value === personaPending)) $('role-card').value = message.roleCard.text;
        roleCardCount();
        personaStatus(resetDraftChanged ? '默认卡已保存，将用于下一条；当前草稿未保存。' : message.action === 'reset' ? '已恢复并保存默认角色卡。' : '角色卡已保存，将从下一条发送开始生效。');
      }
      personaPending = null;
      personaPendingVersion = null;
    }
  }
  if (message.type === 'thinking') {
    if (message.action === 'load' && !thinkingPending) {
      $('thinking-enabled').checked = message.thinking.enabled;
      $('thinking-effort').value = message.thinking.effort;
      $('thinking-effort').disabled = !message.thinking.enabled;
      $('thinking-status').textContent = message.warning || '正在使用已保存的思考设置。';
    } else if (message.action === 'save') {
      thinkingPending = false; $('thinking-save').disabled = false;
      $('thinking-status').textContent = message.error ? message.error + ' 草稿仍保留，原设置继续生效。' : thinkingDraftVersion !== thinkingPendingVersion ? '提交时的思考设置已保存，将从下一条发送开始生效；当前草稿未保存。' : '思考设置已保存，将从下一条发送开始生效。';
      thinkingPendingVersion = null;
    }
  }
});
$('form').addEventListener('submit', event => { event.preventDefault(); const text = $('text').value.trim(); if (!text || busy || $('text').disabled) return; busy = true; pendingGeneration = generation; $('send').disabled = true; $('text').disabled = true; notice('正在等待 Emilia 回复…'); host.send('submit', { generation, id: crypto.randomUUID(), text }); });
$('text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit(); } });
$('credential').onclick = () => host.send('credential');
$('workbench-save').onclick = () => host.send('workbench-save', $('workbench-url').value.trim());
$('workbench-open').onclick = () => host.send('workbench-open');
for (const id of ['settings', 'about']) { $(id + '-open').onclick = () => { $(id).showModal(); if (id === 'settings') { host.send('persona-load'); host.send('thinking-load'); } }; }
$('thinking-enabled').onchange = () => { thinkingDraftVersion++; $('thinking-effort').disabled = !$('thinking-enabled').checked; $('thinking-status').textContent = '草稿尚未保存。'; };
$('thinking-effort').onchange = () => { thinkingDraftVersion++; $('thinking-status').textContent = '草稿尚未保存。'; };
$('thinking-save').onclick = () => { if (thinkingPending) return; thinkingPending = true; thinkingPendingVersion = thinkingDraftVersion; $('thinking-save').disabled = true; $('thinking-status').textContent = '正在保存思考设置…'; host.send('thinking-save', { schemaVersion: 1, enabled: $('thinking-enabled').checked, effort: $('thinking-effort').value }); };
$('role-card').addEventListener('input', () => { personaDraftVersion++; roleCardCount(); personaStatus('草稿尚未保存。'); });
$('role-card-save').onclick = () => { if (personaPending !== null) return; personaPending = $('role-card').value; personaBusy(true); personaStatus('正在保存角色卡…'); host.send('persona-save', { schemaVersion: 1, text: personaPending }); };
$('role-card-reset').onclick = () => { if (personaPending !== null) return; personaPending = $('role-card').value; personaPendingVersion = personaDraftVersion; personaBusy(true); personaStatus('正在恢复默认角色卡…'); host.send('persona-reset'); };
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('about-open').addEventListener('click', async () => { try { $('license').textContent = await (await fetch('yuki://app/AAAAGENT-LICENSE.txt')).text(); } catch { $('license').textContent = '许可文件暂时无法读取。'; } });
host.send('ready');
