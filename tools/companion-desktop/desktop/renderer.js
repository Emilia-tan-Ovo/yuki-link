const $ = id => document.getElementById(id);
let generation = 0, service = 'connecting', busy = false, messages = [];
const host = window.yukiDesktop;
const label = { connecting: '正在连接', unconfigured: '未配置 DeepSeek', configured: '已配置 · 待验证', verified: 'DeepSeek 已验证', 'offline-preview': '离线预览 · 非真实回复', disconnected: '服务已断开' };
function state(next) {
  service = next; $('service').dataset.state = next; $('service-label').textContent = label[next] || next;
  $('model-state').textContent = next === 'offline-preview' ? '离线预览：当前使用确定性本地回复，没有发起 DeepSeek 请求。' : next === 'unconfigured' ? 'DeepSeek 凭据未配置；文字发送不可用。' : next === 'configured' ? '凭据已导入，尚未通过真实请求验证。' : next === 'verified' ? '已完成真实 DeepSeek 文字请求。' : '文字服务状态：' + (label[next] || next);
  $('credential').disabled = next === 'offline-preview';
  $('text').disabled = !['offline-preview', 'configured', 'verified'].includes(next) || busy;
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
    content.append(name, body); item.append(avatar, content); log.append(item);
  }
  const dates = $('dates'); dates.replaceChildren();
  if (!dateMap.size) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '还没有对话'; dates.append(p); }
  for (const [day, id] of [...dateMap].reverse()) { const button = document.createElement('button'); button.type = 'button'; button.className = 'date-button'; button.textContent = '◷  ' + day; button.onclick = () => $(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); dates.append(button); }
  $('conversation').scrollTop = $('conversation').scrollHeight;
}
function notice(text) { $('notice').textContent = text || ''; }
host.subscribe(message => {
  if (message.type === 'connection') { generation = message.generation; state('connecting'); $('workbench-url').value = message.workbenchUrl || ''; host.send('workbench-check'); }
  if (message.type === 'ready') { generation = message.generation; messages = message.history; render(); state(message.status.service); notice(''); }
  if (message.type === 'reply') { messages.push(...message.messages); render(); busy = false; $('text').value = ''; state(message.status.service); notice(''); $('text').focus(); }
  if (message.type === 'error') { busy = false; state(service); notice(message.message); }
  if (message.type === 'disconnected') { busy = false; state('disconnected'); notice('文字服务已断开，请重新打开应用。'); }
  if (message.type === 'notice') notice(message.text);
  if (message.type === 'workbench') { const text = message.error || (!message.configured ? '尚未设置本机入口' : message.reachable ? '本机工作台可访问' : '已设置，当前不可达'); $('workbench-state').textContent = text; $('workbench-detail').textContent = text; }
});
$('form').addEventListener('submit', event => { event.preventDefault(); const text = $('text').value.trim(); if (!text || busy || $('text').disabled) return; busy = true; $('send').disabled = true; $('text').disabled = true; notice('正在等待 Emilia 回复…'); host.send('submit', { generation, id: crypto.randomUUID(), text }); });
$('text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit(); } });
$('credential').onclick = () => host.send('credential');
$('workbench-save').onclick = () => host.send('workbench-save', $('workbench-url').value.trim());
$('workbench-open').onclick = () => host.send('workbench-open');
for (const id of ['settings', 'about']) { $(id + '-open').onclick = () => $(id).showModal(); }
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('about-open').addEventListener('click', async () => { try { $('license').textContent = await (await fetch('yuki://app/AAAAGENT-LICENSE.txt')).text(); } catch { $('license').textContent = '许可文件暂时无法读取。'; } });
host.send('ready');
