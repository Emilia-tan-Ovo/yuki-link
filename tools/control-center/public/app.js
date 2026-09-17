let state, busy = false;
const $ = s => document.querySelector(s);
const messages = { ACTIVE_TASKS: '存在活动任务。停止或重启可能中断任务，任务不会自动重放。', ACTIVITY_UNKNOWN: '当前活动任务不可观测，不能默认空闲。', LEGACY_RUNTIME_LOCK: '发现未受管的旧锁，请先核验并备份处理。', DEPLOYMENT_CONFIRMATION_REQUIRED: '当前为观察模式，正式部署尚待授权。', STARTUP_CONFIRMATION_REQUIRED: '自启配置修改尚待授权。', OBSERVED_UNOWNED: '发现外部启动的实例，仅观察，不接管。', RECOVERY_BUDGET_EXHAUSTED: '10 分钟内已达恢复上限；核查原因后可手动重试。' };
async function post(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify(body) });
  const result = await r.json(); if (!r.ok) throw result; return result;
}
async function refresh() {
  try {
    const r = await fetch('/api/status'); if (!r.ok) throw Error(); state = await r.json();
    if (state.initializing) return;
    $('#overall').textContent = state.observeOnly ? '本地观察模式 · 正式启停待授权' : state.busy ? '正在执行服务操作…' : '本地状态 · 以各层证据为准';
    $('#checked').textContent = '最近检测：' + new Date(state.at).toLocaleTimeString();
    for (const id of ['yca', 'tunnel']) {
      const o = state.units[id], card = $('#' + id);
      card.querySelector('.status').textContent = o.status; card.querySelector('.status').dataset.status = o.status;
      card.querySelector('.evidence').textContent = `期望${o.desired === 'running' ? '运行' : '停止'} · ${o.owned ? '由控制中心管理' : o.running ? '观察到外部实例' : '未发现受管进程'} · ${messages[o.blocked ?? o.code] ?? o.blocked ?? o.code ?? (o.stale ? '证据已过期' : id === 'tunnel' && o.healthy && o.status === '降级' ? '本地就绪；远端通信证据不足，不等于断线' : '已取得本地证据')}`;
      card.querySelector('pre').textContent = JSON.stringify(o, null, 2);
    }
    $('#official').hidden = !state.units.tunnel.ui; if (state.units.tunnel.ui) $('#official').href = state.units.tunnel.ui;
    $('#recovery').checked = state.autoRecovery; $('#recovery').disabled = busy || state.observeOnly;
    $('#autostart').checked = state.startup.enabled === true; $('#autostart').disabled = busy || !state.startup.changesAllowed;
    $('#uninstall').disabled = busy || !state.startup.changesAllowed || !state.startup.installed;
    $('#startup-state').textContent = '自启：' + state.startup.state;
    const latest = state.units.yca.lastBridge;
    $('#codex-state').textContent = `CLI：${state.codex.cli} / 账号：${state.codex.account} / 模型：${state.codex.inference} / 最近 Bridge：${latest ? latest.status + ' · ' + latest.at : '无可观测结果'}`;
    const t = state.tools, d = state.units.yca.deployment;
    $('#tools').textContent = `运行中 YCA ${t.running?.count ?? '—'} 项 · SHA-256 ${t.running?.sha256 ?? '—'}\n源码 commit：${d?.running?.commit ?? '未知'} · 部署核验：${d?.state ?? '未知'}\n已准备目标：${d?.target?.commit ?? '未配置'}\n最近人工确认：${t.confirmed?.at ?? '暂无'}${t.possibleRefresh ? ' · 可能需要刷新定义' : ''}`;
    $('#events').textContent = state.events.map(e => `${e.at}  ${e.component} / ${e.action}${e.code ? ' / ' + e.code : ''}${e.exitCode !== null ? ' / exit=' + e.exitCode : ''}`).join('\n') || '暂无事件';
    document.querySelectorAll('[data-action]').forEach(b => b.disabled = busy || state.observeOnly || Boolean(state.busy));
  } catch { $('#overall').textContent = '面板连接中断 · 展示数据已过期'; document.querySelectorAll('.status').forEach(e => { e.textContent = '未知'; e.dataset.status = '未知'; }); }
}
async function perform(fn) { if (busy) return; busy = true; $('#notice').textContent = ''; try { await fn(); } catch (e) { $('#notice').textContent = messages[e.code] ?? e.code ?? '操作未完成，请重新检测。'; } finally { busy = false; await refresh(); } }
document.querySelectorAll('[data-action]').forEach(b => b.onclick = () => perform(async () => {
  const body = { id: b.dataset.id, action: b.dataset.action };
  if (['stop', 'restart'].includes(body.action)) {
    const active = state.units.yca.activity;
    if (state.units.yca.running !== false && (!active || Object.values(active).some(n => n > 0))) {
      if (!confirm('存在活动任务或活动状态未知。操作可能中断请求，且不会自动重放任务。确认继续？')) return;
      body.confirm = true;
    }
  }
  try { await post('/api/action', body); }
  catch (e) {
    if (e.code === 'ACTIVE_TASKS' && !body.confirm && confirm(messages.ACTIVE_TASKS + ' 确认继续？')) await post('/api/action', { ...body, confirm: true }); else throw e;
  }
}));
$('#recheck').onclick = () => perform(() => post('/api/recheck'));
$('#codex').onclick = () => perform(() => post('/api/codex-check'));
$('#recovery').onchange = e => perform(() => post('/api/recovery', { enabled: e.target.checked }));
$('#autostart').onchange = e => perform(async () => { const action = e.target.checked ? state.startup.installed ? 'Enable' : 'Install' : 'Disable'; if (confirm('确认修改当前用户的登录自启配置？')) await post('/api/startup', { action }); });
$('#uninstall').onclick = () => perform(async () => { if (confirm('卸载本控制中心的登录自启？服务和历史会保留。')) await post('/api/startup', { action: 'Uninstall' }); });
$('#confirm-tools').onclick = () => perform(async () => { if (confirm('你已在 ChatGPT 客户端人工核对当前工具定义？这里只记录你的确认。')) await post('/api/confirm-tools'); });
$('#copy').onclick = () => perform(async () => {
  const r = await fetch('/api/diagnostic'); if (!r.ok) throw Error(); const text = JSON.stringify(await r.json(), null, 2);
  $('#diagnostic textarea').value = text;
  try { await navigator.clipboard.writeText(text); $('#notice').textContent = '诊断已复制。'; }
  catch { $('#diagnostic').open = true; $('#diagnostic textarea').select(); $('#notice').textContent = '请复制下方已选中的诊断文本。'; }
});
refresh(); setInterval(refresh, 5000);
