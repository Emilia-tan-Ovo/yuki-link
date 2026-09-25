const $ = id => document.getElementById(id);
let generation = 0, service = 'connecting', busy = false, pendingGeneration = null, messages = [];
let personaPending = null;
let memoryPending = null, memorySource = null;
let thinkingCommitted = null, thinkingPending = null, thinkingDesired = null;
let thinkingDraftVersion = 0;
let thinkingSyncedVersion = 0, thinkingHasSaved = false;
const expandedReasoning = new Set();
let personaDraftVersion = 0, personaPendingVersion = null;
const host = window.yukiDesktop;
const label = { connecting: '正在连接', unconfigured: '未配置 DeepSeek', configured: '已配置 · 待验证', verified: 'DeepSeek 已验证', unknown: 'DeepSeek 状态待确认', 'offline-preview': '离线预览 · 非真实回复', disconnected: '服务已断开' };
function state(next) {
  service = next; $('service').dataset.state = next; $('service-label').textContent = label[next] || next;
  $('model-state').textContent = next === 'offline-preview' ? '离线预览：当前使用确定性本地回复，没有发起 DeepSeek 请求。' : next === 'unconfigured' ? 'DeepSeek 凭据未配置；文字发送不可用。' : next === 'configured' ? '凭据已导入，尚未通过真实请求验证。' : next === 'verified' ? '已完成真实 DeepSeek 文字请求。' : '文字服务状态：' + (label[next] || next);
  $('credential').disabled = next === 'offline-preview';
  $('text').disabled = !['offline-preview', 'configured', 'verified', 'unknown'].includes(next) || busy;
  updateSend();
}
function updateSend() { $('send').disabled = $('text').disabled || !thinkingCommitted || !!thinkingPending; }
function thinkingTarget(value) { return { schemaVersion: 1, enabled: value !== 'off', effort: value === 'off' ? thinkingCommitted.effort : value }; }
function thinkingValue(value) { return value.enabled ? value.effort : 'off'; }
function thinkingLabel(value) { return value.enabled ? value.effort.toUpperCase() : '关闭'; }
function sameThinking(a, b) { return a.enabled === b.enabled && a.effort === b.effort; }
function syncThinkingDraft() {
  $('thinking-enabled').checked = thinkingCommitted.enabled;
  $('thinking-effort').value = thinkingCommitted.effort;
  $('thinking-effort').disabled = !thinkingCommitted.enabled;
  thinkingSyncedVersion = thinkingDraftVersion;
}
function showThinkingCommitted() {
  $('thinking-quick').value = thinkingValue(thinkingCommitted);
  $('thinking-quick').disabled = false;
  updateSend();
}
function saveThinking(target, source) {
  thinkingPending = { target, source, version: thinkingDraftVersion };
  $('thinking-save').disabled = true;
  $('thinking-quick-status').textContent = `正在保存思考设置…当前生效：${thinkingLabel(thinkingCommitted)}`;
  $('thinking-status').textContent = '正在保存思考设置…';
  updateSend();
  host.send('thinking-save', target);
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
    if (row.role === 'user') {
      const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'memory-pick'; pick.textContent = '从此消息新增记忆';
      pick.onclick = () => { memorySource = row.id; $('memory-source').textContent = '来源：已保存的用户消息；请填写要保存的简短事实。'; $('memory-text').value = ''; $('settings').showModal(); host.send('memory', { generation, id: crypto.randomUUID(), action: 'list' }); };
      content.append(pick);
    }
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
function memoryBusy(value) { for (const id of ['memory-add','memory-correct','memory-forget']) $(id).disabled = value; }
function memoryCommand(action, details = {}, fromChat = false) {
  if (memoryPending) return;
  const id = crypto.randomUUID(); memoryPending = { id, action, generation, draft: $('text').value, memoryDraft: $('memory-text').value, fromChat };
  memoryBusy(true); $('memory-status').textContent = '正在提交陪伴记忆操作…';
  host.send('memory', { generation, id, action, ...details });
}
function renderMemories(entries) {
  const target = $('memory-target'), selected = target.value; target.replaceChildren();
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = '选择一条记忆'; target.append(blank);
  for (const entry of entries) { const option = document.createElement('option'); option.value = entry.id; option.textContent = `${entry.text} · ${entry.sourceKind === 'selected_user_message' ? '用户消息' : '显式操作'} · ${entry.updatedAt || ''}`; target.append(option); }
  target.value = entries.some(entry => entry.id === selected) ? selected : '';
}
host.subscribe(message => {
  if (message.type === 'connection') { generation = message.generation; memoryPending = null; memoryBusy(false); $('memory-status').textContent = '连接已更新，请重新读取有效记忆。'; state('connecting'); $('workbench-url').value = message.workbenchUrl || ''; host.send('workbench-check'); }
  if (message.type !== 'ready' && message.generation !== undefined && message.generation !== generation) return;
  if (message.type === 'ready') { const interrupted = busy && pendingGeneration !== message.generation; generation = message.generation; messages = message.history; render(); if (interrupted) { busy = false; pendingGeneration = null; } state(message.status.service); notice(interrupted ? '连接已更新，上一条未完成的发送已中断，请重新发送。' : ''); }
  if (message.type === 'reply') { messages.push(...message.messages); render(); busy = false; pendingGeneration = null; $('text').value = ''; state(message.status.service); notice(''); $('text').focus(); }
  if (message.type === 'error') { busy = false; pendingGeneration = null; state(message.status?.service || service); notice(message.message); }
  if (message.type === 'disconnected') { busy = false; pendingGeneration = null; state('disconnected'); notice('文字服务已断开，请重新打开应用。'); }
  if (message.type === 'notice') notice(message.text);
  if (message.type === 'memory' || message.type === 'memory-error') {
    if (message.action === 'list' && message.type === 'memory') { renderMemories(message.entries); if (!memoryPending) $('memory-status').textContent = message.entries.length ? '当前有效记忆已读取。' : '暂无有效陪伴记忆。'; }
    else if (memoryPending && (!message.id || message.id === memoryPending.id)) {
      const pending = memoryPending; memoryPending = null; memoryBusy(false);
      if (message.type === 'memory-error') { $('memory-status').textContent = message.message; if (pending.action === 'remember') notice(message.message); }
      else {
        renderMemories(message.entries);
        const success = pending.action === 'remember' ? '已记住，后续相关对话会参考。' : pending.action === 'correct' ? '已更正，旧记忆和旧近期上下文不再用于后续对话。' : '已从本机有效陪伴记忆移除；旧聊天仍可回看。';
        $('memory-status').textContent = success;
        if (pending.action === 'remember' && pending.fromChat) { if ($('text').value === pending.draft) $('text').value = ''; notice(success); }
        if ($('memory-text').value === pending.memoryDraft) $('memory-text').value = '';
        memorySource = null; $('memory-source').textContent = '来源：新建的显式操作';
      }
    }
  }
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
    if (message.action === 'load' && !thinkingPending && !thinkingHasSaved) {
      thinkingCommitted = message.thinking;
      if (thinkingDraftVersion === thinkingSyncedVersion) syncThinkingDraft();
      showThinkingCommitted();
      $('thinking-quick-status').textContent = message.warning || '';
      $('thinking-status').textContent = message.warning || '正在使用已保存的思考设置。';
    } else if (message.action === 'save' && thinkingPending) {
      const completed = thinkingPending;
      thinkingPending = null;
      if (message.error) {
        thinkingDesired = null;
        $('thinking-quick-status').textContent = message.error;
        $('thinking-status').textContent = message.error + ' 草稿仍保留，原设置继续生效。';
      } else {
        thinkingCommitted = message.thinking;
        thinkingHasSaved = true;
        if (thinkingDraftVersion === thinkingSyncedVersion || (completed.source === 'settings' && thinkingDraftVersion === completed.version)) syncThinkingDraft();
        const dirty = thinkingDraftVersion !== thinkingSyncedVersion;
        $('thinking-status').textContent = dirty ? '提交时的思考设置已保存，将从下一条发送开始生效；当前草稿未保存。' : '思考设置已保存，将从下一条发送开始生效。';
        $('thinking-quick-status').textContent = '思考设置已保存。';
      }
      if (thinkingDesired && !message.error && !sameThinking(thinkingTarget(thinkingDesired), thinkingCommitted)) {
        const next = thinkingTarget(thinkingDesired); thinkingDesired = null; saveThinking(next, 'quick');
      } else {
        thinkingDesired = null;
        $('thinking-save').disabled = false;
        showThinkingCommitted();
      }
    }
  }
});
$('form').addEventListener('submit', event => { event.preventDefault(); const text = $('text').value.trim(); if (!text || busy || memoryPending || $('text').disabled || !thinkingCommitted || thinkingPending) return;
  if (/^记住\s*[:：]/u.test(text)) { const fact = text.replace(/^记住\s*[:：]/u, '').trim(); if (!fact || fact.length > 300) { notice('请在“记住：”后填写不超过 300 字的简短事实。'); return; } memoryCommand('remember', { text: fact, sourceKind: 'explicit_chat' }, true); return; }
  if (/记住|忘记记忆|更正记忆/u.test(text)) { $('settings').showModal(); host.send('memory', { generation, id: crypto.randomUUID(), action: 'list' }); notice('请在陪伴记忆管理区明确填写事实或选择目标后提交。'); return; }
  busy = true; pendingGeneration = generation; $('send').disabled = true; $('text').disabled = true; notice('正在等待 Emilia 回复…'); host.send('submit', { generation, id: crypto.randomUUID(), text }); });
$('text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit(); } });
$('credential').onclick = () => host.send('credential');
$('workbench-save').onclick = () => host.send('workbench-save', $('workbench-url').value.trim());
$('workbench-open').onclick = () => host.send('workbench-open');
for (const id of ['settings', 'about']) { $(id + '-open').onclick = () => { $(id).showModal(); if (id === 'settings') { host.send('memory', { generation, id: crypto.randomUUID(), action: 'list' }); host.send('persona-load'); host.send('thinking-load'); } }; }
$('memory-add').onclick = () => memoryCommand('remember', { text: $('memory-text').value, sourceKind: memorySource ? 'selected_user_message' : 'explicit_chat', sourceRef: memorySource || undefined });
$('memory-correct').onclick = () => { if (!$('memory-target').value) { $('memory-status').textContent = '请先选择要更正的记忆。'; return; } memoryCommand('correct', { targetId: $('memory-target').value, text: $('memory-text').value }); };
$('memory-forget').onclick = () => { if (!$('memory-target').value) { $('memory-status').textContent = '请先选择要忘记的记忆。'; return; } memoryCommand('forget', { targetId: $('memory-target').value }); };
$('thinking-enabled').onchange = () => { thinkingDraftVersion++; $('thinking-effort').disabled = !$('thinking-enabled').checked; $('thinking-status').textContent = '草稿尚未保存。'; };
$('thinking-effort').onchange = () => { thinkingDraftVersion++; $('thinking-status').textContent = '草稿尚未保存。'; };
$('thinking-save').onclick = () => { if (thinkingPending || !thinkingCommitted) return; saveThinking({ schemaVersion: 1, enabled: $('thinking-enabled').checked, effort: $('thinking-effort').value }, 'settings'); };
$('thinking-quick').onchange = () => {
  if (!thinkingCommitted) return;
  const target = thinkingTarget($('thinking-quick').value);
  if (thinkingPending) { thinkingDesired = $('thinking-quick').value; return; }
  if (!sameThinking(target, thinkingCommitted)) saveThinking(target, 'quick');
};
$('role-card').addEventListener('input', () => { personaDraftVersion++; roleCardCount(); personaStatus('草稿尚未保存。'); });
$('role-card-save').onclick = () => { if (personaPending !== null) return; personaPending = $('role-card').value; personaBusy(true); personaStatus('正在保存角色卡…'); host.send('persona-save', { schemaVersion: 1, text: personaPending }); };
$('role-card-reset').onclick = () => { if (personaPending !== null) return; personaPending = $('role-card').value; personaPendingVersion = personaDraftVersion; personaBusy(true); personaStatus('正在恢复默认角色卡…'); host.send('persona-reset'); };
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('about-open').addEventListener('click', async () => { try { $('license').textContent = await (await fetch('yuki://app/AAAAGENT-LICENSE.txt')).text(); } catch { $('license').textContent = '许可文件暂时无法读取。'; } });
host.send('ready');
host.send('thinking-load');
