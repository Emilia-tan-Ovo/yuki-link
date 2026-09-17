let state, busy = false;
const $ = s => document.querySelector(s);
const messages = { ACTIVE_TASKS: '存在活动任务。停止或重启可能中断任务，任务不会自动重放。', ACTIVITY_UNKNOWN: '当前活动任务不可观测，不能默认空闲。', LEGACY_RUNTIME_LOCK: '发现未受管的旧锁，请先核验并备份处理。', DEPLOYMENT_CONFIRMATION_REQUIRED: '当前为观察模式，正式部署尚待授权。', STARTUP_CONFIRMATION_REQUIRED: '自启配置修改尚待授权。', OBSERVED_UNOWNED: '发现外部启动的实例，仅观察，不接管。', RECOVERY_BUDGET_EXHAUSTED: '10 分钟内已达恢复上限；核查原因后可手动重试。', DEPLOYMENT_NOT_CONFIGURED: '当前未配置受管 YCA deployment。', DEPLOYMENT_SOURCE_CHANGED: '检查与抓取期间远端分支发生变化，本次未切换版本，请重新检查。', DEPLOYMENT_CURRENT_UNKNOWN: '无法可靠确定当前 YCA release，拒绝隐式切换。', DEPLOYMENT_CURRENT_CHANGED: '准备更新期间当前 YCA release 已变化，本次停止。', DEPLOYMENT_SWITCH_UNVERIFIED: '新 release 启动后未通过 commit / 工具摘要核验，已尝试回退。', DEPLOYMENT_ROLLBACK_FAILED: '新版本切换失败且旧 release 未能自动恢复，请保留现场检查。', DEPLOYMENT_ROLLBACK_CONFLICT: '回退时发现并非本次候选的运行实例，已停止自动处理并保留现场。' };
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
    $('#codex-state').textContent = `CLI：${state.codex.cli}${state.codex.refreshed ? '（配置路径失效，已自动重新发现）' : ''} / 账号：${state.codex.account} / 模型：${state.codex.inference} / 最近 Bridge：${latest ? latest.status + ' · ' + latest.at : '无可观测结果'}`;
    const t = state.tools, d = state.units.yca.deployment, remote = d?.latest;
    const remoteText = remote?.commit ? `${remote.commit}${remote.stale ? `（上次结果；本次检查失败：${remote.error ?? '未知错误'}）` : ''}` : remote?.error ? `检查失败：${remote.error}` : '未检查';
    const relation = d?.remoteDiffers === true ? '远端版本与已选版本不同' : d?.remoteDiffers === false ? '远端版本与已选版本一致' : '远端关系未检查';
    const switchState = d?.restartRequired === true ? '已准备版本尚未切换' : d?.restartRequired === false ? '运行中版本与已选版本一致' : '切换状态未知';
    $('#tools').textContent = `运行中 YCA ${t.running?.count ?? '—'} 项 · SHA-256 ${t.running?.sha256 ?? '—'}\n运行中：${d?.running?.commit ?? '未运行'}\n已准备：${d?.target?.commit ?? '未配置'}\n远端：${remoteText}\n${relation} · ${switchState} · 部署核验：${d?.state ?? '未知'}\n最近人工确认：${t.confirmed?.at ?? '暂无'}${t.possibleRefresh ? ' · 可能需要刷新客户端定义' : ''}`;
    $('#events').textContent = state.events.map(e => `${e.at}  ${e.component} / ${e.action}${e.code ? ' / ' + e.code : ''}${e.exitCode !== null ? ' / exit=' + e.exitCode : ''}`).join('\n') || '暂无事件';
    document.querySelectorAll('[data-action]').forEach(b => b.disabled = busy || state.observeOnly || Boolean(state.busy));
    $('#check-update').disabled = busy || Boolean(state.busy);
    $('#prepare-update').disabled = busy || state.observeOnly || Boolean(state.busy);
    $('#update-restart').disabled = busy || state.observeOnly || Boolean(state.busy);
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
$('#check-update').onclick = () => perform(() => post('/api/deployment', { action: 'check' }));
$('#prepare-update').onclick = () => perform(async () => { if (confirm('准备远端默认分支当前版本？这会下载并验证候选 release，但不会停止正在运行的 YCA。')) await post('/api/deployment', { action: 'prepare' }); });
$('#update-restart').onclick = () => perform(async () => {
  const body = { action: 'update-restart' }, active = state.units.yca.activity;
  if (state.units.yca.running !== false && (!active || Object.values(active).some(n => n > 0))) {
    if (!confirm('当前存在活动任务或活动状态未知。若确认继续，准备完成时届时仍在运行的任务（包括准备期间新开始的任务）也可能被中断；切换失败会尝试恢复旧 release。确认继续？')) return;
    body.confirm = true;
  } else if (!confirm('检查、准备并切换远端默认分支当前版本，然后重启 YCA？切换失败会尝试恢复旧 release。')) return;
  try { await post('/api/deployment', body); }
  catch (e) { if (e.code === 'ACTIVE_TASKS' && !body.confirm && confirm(messages.ACTIVE_TASKS + ' 确认继续？')) await post('/api/deployment', { ...body, confirm: true }); else throw e; }
});
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
