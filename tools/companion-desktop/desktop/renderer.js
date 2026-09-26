import { normalizeUserText, sameVoiceScope } from './turn-contract.mjs';
import { RendererVoice } from './voice-ui.mjs';
import { RendererLive2D } from './live2d-ui.mjs';

const $ = id => document.getElementById(id);
let generation = 0, service = 'connecting', busy = false, pendingGeneration = null, messages = [];
let pendingRequest = null;
let voiceScope = null, voiceState = 'idle', voiceFinal = null, voiceFinalConsumed = false;
let personaPending = null;
let memoryPending = null, memorySource = null;
let memoryRefreshId = null;
let cardCurrent = null, cardEntries = [], cardPending = null;
let cardFocusExplicit = false;
const verifiedFocus = card => card?.state !== 'revoked' && card?.content?.resolution?.status === 'verified_existing' && card.content.ticket?.url ? { projectKey: card.content.projectKey, ticket: card.content.ticket } : null;
function currentCardFocus() { const targets = new Set(cardEntries.map(card => verifiedFocus(card)?.ticket.url).filter(Boolean)); return cardFocusExplicit || targets.size === 1 ? verifiedFocus(cardCurrent) : null; }
let thinkingCommitted = null, thinkingPending = null, thinkingDesired = null;
let thinkingDraftVersion = 0;
let thinkingSyncedVersion = 0, thinkingHasSaved = false;
const expandedReasoning = new Set();
let personaDraftVersion = 0, personaPendingVersion = null;
const host = window.yukiDesktop;
const avatarUI = new RendererLive2D({ host, element: $ });
const mediaUI = new RendererVoice({ host, element: $, getGeneration: () => generation, notice, playbackObserver: event => avatarUI.playback(event) });
let startAfterCancel = false;
const label = { connecting: '正在连接', unconfigured: '未配置 DeepSeek', configured: '已配置 · 待验证', verified: 'DeepSeek 已验证', unknown: 'DeepSeek 状态待确认', 'offline-preview': '离线预览 · 非真实回复', disconnected: '服务已断开' };
function state(next) {
  service = next; $('service').dataset.state = next; $('service-label').textContent = label[next] || next;
  $('model-state').textContent = next === 'offline-preview' ? '离线预览：当前使用确定性本地回复，没有发起 DeepSeek 请求。' : next === 'unconfigured' ? 'DeepSeek 凭据未配置；文字发送不可用。' : next === 'configured' ? '凭据已导入，尚未通过真实请求验证。' : next === 'verified' ? '已完成真实 DeepSeek 文字请求。' : '文字服务状态：' + (label[next] || next);
  $('credential').disabled = next === 'offline-preview';
  $('text').disabled = !['offline-preview', 'configured', 'verified', 'unknown'].includes(next) || busy;
  updateSend();
}
function updateSend() { $('send').disabled = $('text').disabled || !thinkingCommitted || !!thinkingPending; $('cancel-reply').disabled = !pendingRequest || pendingRequest.cancelling; }
function matchesRequest(message) { return pendingRequest && message.generation === pendingGeneration && message.requestId === pendingRequest.requestId && (pendingRequest.origin !== 'voice-final' || message.origin === 'voice-final' && sameVoiceScope(message.voiceScope, pendingRequest.voiceScope)); }
function releaseRequest() { if (pendingRequest?.timer) clearTimeout(pendingRequest.timer); busy = false; pendingGeneration = null; pendingRequest = null; }
function appendCommitted(rows) { const ids = new Set(messages.map(row => row.id)); for (const row of rows || []) if (!ids.has(row.id)) { messages.push(row); ids.add(row.id); } render(); }
function maybeDispatchVoiceFinal() {
  if (!voiceFinal || voiceFinalConsumed || !sameVoiceScope(voiceFinal.scope, voiceScope) || voiceScope.connectionGeneration !== generation || !['transcribing', 'awaiting-submit'].includes(voiceState) || pendingRequest || busy || memoryPending || !thinkingCommitted || thinkingPending || $('text').disabled) return;
  // Consume before dispatch so repeated final events never resubmit Memory/model.
  voiceFinalConsumed = true;
  dispatchUserText(voiceFinal.text, 'voice-final', voiceScope);
}
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
function cardCommand(action, details = {}) { if (cardPending) return; const id = crypto.randomUUID(); cardPending = id; $('card-status').textContent = '正在保存工程卡片…'; host.send('engineering-card', { generation, id, action, ...details }); }
function cardFields() { return { original: $('card-original').value, summary: $('card-summary').value, project: $('card-project').value, ticket: $('card-ticket').value, noTicket: $('card-no-ticket').checked, desiredPhase: $('card-phase').value, endpoint: $('card-endpoint').value, mergeRequested: $('card-merge').checked, mergeTarget: $('card-merge-target').value, deployRequested: $('card-deploy').checked, deployTarget: $('card-deploy-target').value }; }
function cardDirty() { return !!cardCurrent && JSON.stringify(cardFields()) !== JSON.stringify({ original: cardCurrent.content.original, summary: cardCurrent.content.summary, project: cardCurrent.content.projectKey || '', ticket: cardCurrent.content.ticket ? '#' + cardCurrent.content.ticket.number : '', noTicket: cardCurrent.content.resolution.status === 'explicit_new_requirement', desiredPhase: cardCurrent.content.desiredPhase || '', endpoint: cardCurrent.content.endpoint || '', mergeRequested: !!cardCurrent.content.extraAuthorization?.merge?.requested, mergeTarget: cardCurrent.content.extraAuthorization?.merge?.target || '', deployRequested: !!cardCurrent.content.extraAuthorization?.deploy?.requested, deployTarget: cardCurrent.content.extraAuthorization?.deploy?.target || '' }); }
function updateCardConfirm() { if (!cardCurrent) return; const content = cardCurrent.content, merge = content.extraAuthorization?.merge, deploy = content.extraAuthorization?.deploy; const mergeTarget = merge?.target?.trim() || '', deployTarget = deploy?.target?.trim() || '', prefix = `https://github.com/${content.repository}/pull/`; $('card-confirm').disabled = Boolean(cardPending || cardDirty() || cardCurrent.state !== 'pending' || !['verified_existing','explicit_new_requirement'].includes(content.resolution.status) || !content.desiredPhase || !content.endpoint || merge?.requested && !(/^PR\s*#[1-9]\d*$/iu.test(mergeTarget) || mergeTarget.startsWith(prefix) && /^[1-9]\d*$/u.test(mergeTarget.slice(prefix.length))) || deploy?.requested && !/^[\w.-]{2,100}$/u.test(deployTarget)); }
function renderCard(card) {
  cardCurrent = card;
  $('card-editor').hidden = !card;
  if (!card) return;
  const content = card.content;
  $('card-select').value = card.cardId;
  $('card-original').value = content.original;
  $('card-summary').value = content.summary;
  $('card-project').value = content.projectKey || '';
  $('card-ticket').value = content.ticket ? '#' + content.ticket.number : '';
  $('card-no-ticket').checked = content.resolution.status === 'explicit_new_requirement';
  $('card-phase').value = content.desiredPhase || '';
  $('card-endpoint').value = content.endpoint || '';
  $('card-merge').checked = !!content.extraAuthorization?.merge?.requested;
  $('card-merge-target').value = content.extraAuthorization?.merge?.target || '';
  $('card-deploy').checked = !!content.extraAuthorization?.deploy?.requested;
  $('card-deploy-target').value = content.extraAuthorization?.deploy?.target || '';
  $('card-identity').textContent = `卡片 ${card.cardId} · revision ${card.revision}`;
  $('card-target').textContent = `目标：${content.repository || '项目待明确'} · ${content.ticket ? content.ticket.title + ' (' + content.ticket.url + ')' : '尚无已核验 Ticket'} · ${content.resolution.status}：${content.resolution.reason} · 来源 ${content.resolution.source || '暂无'} · 观察于 ${content.resolution.observedAt || '未知'}${content.candidates?.length ? ' · 候选：' + content.candidates.map(item => item.title + ' (' + item.url + ')').join('；') : ''}`;
  const choices = $('card-candidate'); choices.replaceChildren();
  const candidates = content.resolution.status === 'ambiguous' ? content.candidates ?? [] : [];
  for (const item of candidates) { const option = document.createElement('option'); option.value = item.url; option.textContent = `${item.routeKey || item.title} · ${item.title} · #${item.number}`; choices.append(option); }
  $('card-clarify').hidden = candidates.length === 0;
  const workflow = card.observedWorkflow;
  $('card-workflow').textContent = workflow ? `Workflow 观察：${workflow.phase || '未知'} · revision ${workflow.revision ?? '未知'} · ${workflow.assessment || 'unknown'} · ${workflow.observedAt || '时间未知'}` : 'Workflow 观察：暂无；这不影响 Ticket 目标核验状态。';
  const authorization = ['merge','deploy'].map(kind => `${kind}：${content.extraAuthorization?.[kind]?.requested ? content.extraAuthorization[kind].target ? '显式请求 ' + content.extraAuthorization[kind].target : '已请求，对象待澄清' : '未请求'}`).join('；');
  $('card-state').textContent = `${card.state === 'confirmed' ? `已确认 revision ${card.confirmation.revision}` : card.state === 'revoked' ? '已撤销' : '待确认'}，尚未派发。${authorization}。`;
  updateCardConfirm();
  $('card-edit').disabled = card.state === 'revoked'; $('card-revoke').disabled = card.state === 'revoked';
}
function renderCardList(entries) {
  cardEntries = entries; const selected = cardCurrent?.cardId; const select = $('card-select'); select.replaceChildren();
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = '选择卡片'; select.append(blank);
  for (const card of entries) { const option = document.createElement('option'); option.value = card.cardId; option.textContent = `${card.content.summary || card.content.original} · ${card.state}`; select.append(option); }
  renderCard(entries.find(card => card.cardId === selected) || entries.find(card => verifiedFocus(card)) || entries[0] || null);
}
host.subscribe(message => {
  if (message.generation !== undefined && message.generation < generation) { if (message.wav instanceof Uint8Array) message.wav.fill(0); return; }
  if (message.type === 'connection') generation = message.generation;
  void mediaUI.receive(message);
  avatarUI.receive(message);
  if (message.type === 'connection') { generation = message.generation; voiceScope = null; voiceFinal = null; memoryPending = null; memoryRefreshId = null; memoryBusy(false); renderMemories([]); $('memory-target').disabled = true; $('memory-status').textContent = '有效记忆待重新读取。'; state('connecting'); $('workbench-url').value = message.workbenchUrl || ''; host.send('workbench-check'); }
  if (message.type !== 'ready' && message.generation !== undefined && message.generation !== generation) return;
  if (message.type === 'voice-state' && message.scope?.connectionGeneration === generation) {
    if (voiceScope && message.scope.voiceEpoch < voiceScope.voiceEpoch) return;
    if (!sameVoiceScope(message.scope, voiceScope)) { voiceScope = message.scope; voiceFinal = null; voiceFinalConsumed = false; }
    voiceState = message.state;
    if (['cancelling', 'cancelled', 'error', 'unknown'].includes(message.state)) { voiceFinal = null; voiceFinalConsumed = true; }
  }
  if (message.type === 'voice-final' && sameVoiceScope(message.scope, voiceScope) && !voiceFinalConsumed) {
    try { voiceFinal ??= { scope: message.scope, text: normalizeUserText(message.text) }; $('voice-transcript').value = voiceFinal.text; $('voice-transcript').hidden = true; notice('已识别：' + voiceFinal.text); maybeDispatchVoiceFinal(); }
    catch (error) { notice(error.message); }
  }
  if (message.type === 'ready') { if (pendingRequest && pendingGeneration === message.generation) return; const interrupted = busy && pendingGeneration !== message.generation; if (generation !== message.generation) { voiceScope = null; voiceFinal = null; cardCurrent = null; cardEntries = []; cardFocusExplicit = false; } generation = message.generation; messages = message.history; render(); if (interrupted) releaseRequest(); state(message.status.service); notice(interrupted ? '连接已更新，上一条结果请以已保存历史为准；草稿仍保留。' : ''); if ($('memory-target').disabled) { memoryRefreshId = crypto.randomUUID(); host.send('memory', { generation, id: memoryRefreshId, action: 'list' }); } cardPending = null; host.send('engineering-card', { generation, id: crypto.randomUUID(), action: 'list' }); maybeDispatchVoiceFinal(); }
  if (message.type === 'reply') {
    if (message.committed === true) appendCommitted(message.messages);
    if (!matchesRequest(message) || pendingRequest.cancelling) return;
    const pending = pendingRequest; releaseRequest();
    if (pending.origin === 'typed' && $('text').value === pending.draft) $('text').value = '';
    state(message.status.service); notice(''); $('text').focus();
    maybeDispatchVoiceFinal();
  }
  if (message.type === 'error') { if (!matchesRequest(message) || pendingRequest.cancelling) return; releaseRequest(); state(message.status?.service || service); notice(message.message); maybeDispatchVoiceFinal(); }
  if (message.type === 'cancel-ack') {
    if (message.outcome === 'alreadyCommitted') appendCommitted(message.messages);
    if (!matchesRequest(message) || !pendingRequest.cancelling) return;
    if (['cancelled', 'alreadyCommitted', 'notCommitted'].includes(message.outcome)) {
      releaseRequest(); state(message.status?.service || service);
      notice(message.outcome === 'alreadyCommitted' ? '文字已提交，历史保留；本轮下游语音已禁止。' : message.outcome === 'cancelled' ? '当前回复已取消，未写入历史。' : '本轮未提交，草稿保留。');
      maybeDispatchVoiceFinal();
      if (startAfterCancel) { startAfterCancel = false; void mediaUI.start(); }
    } else { notice('回复取消结果未知，请重连后核对历史；不会自动重试。'); }
  }
  if (message.type === 'disconnected') { const uncertain = !!pendingRequest; voiceScope = null; voiceFinal = null; releaseRequest(); state('disconnected'); notice(uncertain ? '连接已断开，本轮提交或取消结果未知，请重新打开应用核对历史。' : '文字服务已断开，请重新打开应用。'); }
  if (message.type === 'notice') notice(message.text);
  if (message.type === 'engineering-card' || message.type === 'engineering-card-error') {
    if (message.action === 'list' && message.type === 'engineering-card') renderCardList(message.cards);
    else if (message.id === cardPending) {
      cardPending = null;
      if (message.type === 'engineering-card-error') $('card-status').textContent = message.message;
      else { if (message.card) { cardFocusExplicit = !!verifiedFocus(message.card); renderCard(message.card); const index = cardEntries.findIndex(card => card.cardId === message.card.cardId); if (index < 0) cardEntries.unshift(message.card); else cardEntries[index] = message.card; renderCardList(cardEntries); } $('card-status').textContent = message.conflict ? '卡片已变化，请核对最新 revision 后重试。' : message.invalid ? '项目、Ticket、期望阶段或授权终点尚未明确，不能确认。' : '工程卡片已保存；尚未派发。'; }
    }
  }
  if (message.type === 'memory' || message.type === 'memory-error') {
    if (message.action === 'list' && message.type === 'memory') { if (!$('memory-target').disabled || message.id === memoryRefreshId) { renderMemories(message.entries); $('memory-target').disabled = false; memoryRefreshId = null; if (!memoryPending) $('memory-status').textContent = message.entries.length ? '当前有效记忆已读取。' : '暂无有效陪伴记忆。'; } }
    else if (memoryPending && message.id === memoryPending.id && message.generation === memoryPending.generation && (message.type === 'memory-error' || message.action === memoryPending.action)) {
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
      maybeDispatchVoiceFinal();
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
      maybeDispatchVoiceFinal();
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
      maybeDispatchVoiceFinal();
    }
  }
});
function dispatchUserText(value, origin = 'typed', voiceScope) {
  if (busy || memoryPending || $('text').disabled || !thinkingCommitted || thinkingPending) return false;
  let text; try { text = normalizeUserText(value); } catch (error) { notice(error.message); return false; }
  if (origin === 'typed' && mediaUI.scope) {
    if (['preparing','listening','transcribing','awaiting-submit'].includes(mediaUI.state)) mediaUI.command('cancel-turn');
    else if (['synthesizing','playback-pending','speaking'].includes(mediaUI.state)) mediaUI.command('stop-output');
  }
  if (/^记住\s*[:：]/u.test(text)) { const fact = text.replace(/^记住\s*[:：]/u, '').trim(); if ((!fact || fact.length > 300) && origin === 'typed') { notice('请在“记住：”后填写不超过 300 字的简短事实。'); return; } memoryCommand('remember', { text: fact, sourceKind: 'explicit_chat', ...(origin === 'voice-final' ? { voiceScope, voiceResult: 'remember' } : {}) }, origin === 'typed'); return; }
  if (/记住|忘记记忆|更正记忆|(?:忘掉|忘记).*(?:我|记忆|偏好|喜欢)|(?:纠正|更正).*(?:记忆|偏好|喜欢)|(?:偏好|记忆|喜欢).*(?:忘掉|忘记|纠正|更正)/u.test(text)) { $('settings').showModal(); host.send('memory', { generation, id: crypto.randomUUID(), action: 'list', ...(origin === 'voice-final' ? { voiceScope, voiceResult: 'management-opened' } : {}) }); notice('请在陪伴记忆管理区明确填写事实或选择目标后提交。'); return; }
  if (/(?:继续|处理|完成|做|设计|实现|审查|做到\s*PR|合并|部署)/iu.test(text) && /(?:#\d+|\b0?\d{3}\b|yuki.link|新需求|Ticket)/iu.test(text)) {
    if (cardPending) { notice('上一张工程卡片仍在保存，请稍后重试。'); return false; }
    $('engineering-card-panel').open = true;
    $('card-original').value = text;
    cardCommand('create', { original: text, focus: currentCardFocus(), ...(origin === 'voice-final' ? { voiceScope } : {}) });
    if (origin === 'typed' && $('text').value === text) $('text').value = '';
    notice('工程要求正在整理为待确认卡片。');
    return true;
  }
  const requestId = crypto.randomUUID();
  busy = true; pendingGeneration = generation; pendingRequest = { requestId, origin, voiceScope, draft: $('text').value, cancelling: false };
  state(service); notice('正在等待 Emilia 回复…'); host.send('submit', { generation, id: requestId, requestId, text, origin, voiceScope }); return true;
}
$('form').addEventListener('submit', event => { event.preventDefault(); void mediaUI.dispose(); dispatchUserText($('text').value); });
$('engineering-card-panel').addEventListener('toggle', () => { if ($('engineering-card-panel').open) host.send('engineering-card', { generation, id: crypto.randomUUID(), action: 'list' }); });
$('card-create').onclick = () => { if ($('card-original').value.trim()) cardCommand('create',{ original: $('card-original').value, focus: currentCardFocus() }); else $('card-status').textContent = '请先填写工作要求。'; };
$('card-select').onchange = () => { renderCard(cardEntries.find(card => card.cardId === $('card-select').value) || null); cardFocusExplicit = !!verifiedFocus(cardCurrent); };
$('card-choose').onclick = () => { if (!cardCurrent || cardPending || cardCurrent.content.resolution.status !== 'ambiguous') return; const selected = cardCurrent.content.candidates?.find(item => item.url === $('card-candidate').value); if (!selected) return; const fields = cardFields(); fields.project = cardCurrent.content.projectKey || 'yuki-link'; fields.ticket = `#${selected.number}`; fields.noTicket = false; cardCommand('edit', { cardId: cardCurrent.cardId, expectedRevision: cardCurrent.revision, fields }); updateCardConfirm(); };
$('card-edit').onclick = () => { if (!cardCurrent) return; cardCommand('edit',{ cardId: cardCurrent.cardId, expectedRevision: cardCurrent.revision, fields: cardFields() }); updateCardConfirm(); };
$('card-confirm').onclick = () => { if (cardCurrent && !cardPending && !cardDirty() && !$('card-confirm').disabled) cardCommand('confirm',{ cardId: cardCurrent.cardId, expectedRevision: cardCurrent.revision }); };
for (const id of ['card-original','card-summary','card-project','card-ticket','card-no-ticket','card-phase','card-endpoint','card-merge','card-merge-target','card-deploy','card-deploy-target']) { $(id).addEventListener('input', updateCardConfirm); $(id).addEventListener('change', updateCardConfirm); }
$('card-revoke').onclick = () => { if (cardCurrent) cardCommand('revoke',{ cardId: cardCurrent.cardId, expectedRevision: cardCurrent.revision }); };
$('cancel-reply').onclick = () => {
  if (!pendingRequest || pendingRequest.cancelling) return;
  if (pendingRequest.origin === 'voice-final') void mediaUI.dispose();
  const pending = pendingRequest; pending.cancelling = true; updateSend();
  notice('正在等待后端确认取消结果…');
  pending.timer = setTimeout(() => { if (pendingRequest === pending) notice('回复取消结果待核实，请等待确认或重连核对历史；不会自动重试。'); }, 2000);
  host.send('cancel-model', { generation, requestId: pending.requestId, origin: pending.origin, voiceScope: pending.voiceScope });
};
$('text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit(); } });
$('credential').onclick = () => host.send('credential');
$('voice-start').onclick = () => { if (pendingRequest) { startAfterCancel = true; $('cancel-reply').onclick(); } else void mediaUI.start(); };
$('voice-finish').onclick = () => mediaUI.command('finish');
$('voice-cancel').onclick = () => { startAfterCancel = false; mediaUI.queuedStart = false; if (pendingRequest?.origin === 'voice-final') $('cancel-reply').onclick(); else mediaUI.command('cancel-turn'); };
$('voice-stop').onclick = () => mediaUI.command('stop-output');
$('voice-play').onclick = () => { void mediaUI.resumePlayback(); };
$('voice-save').onclick = () => mediaUI.save();
$('voice-credential').onclick = () => host.send('voice-credential');
$('voice-refresh').onclick = () => { void mediaUI.dispose().then(() => { mediaUI.event('devices-changed'); return mediaUI.devices(); }); host.send('voice-load'); };
$('voice-settings-open').onclick = () => { $('voice-settings').showModal(); host.send('voice-load'); void mediaUI.devices(); };
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
host.send('voice-load');
host.send('live2d-load');
