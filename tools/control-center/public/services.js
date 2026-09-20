let state, busy = false;
const $ = selector => document.querySelector(selector);
const value = input => input === true ? 'true' : input === false ? 'false' : 'unknown';
const commit = input => input?.commit ?? 'unknown';
const activity = input => !input ? 'unknown' : Object.values(input).some(count => count > 0) ? 'active' : 'idle';
const messages = {
  ACTIVE_TASKS: '存在活动任务；本次动作需要明确确认影响。', ACTIVITY_UNKNOWN: '活动状态未知，不能默认空闲。',
  OBSERVED_UNOWNED: '观察到外部实例，Control Center 不会接管。', DEPLOYMENT_CONFIRMATION_REQUIRED: '当前为 observeOnly，动作已拒绝。',
  DEPLOYMENT_CURRENT_UNKNOWN: '无法确认当前 release，拒绝重启或切换。', DEPLOYMENT_CURRENT_CHANGED: '准备期间运行 release 或进程身份已变化。',
  DEPLOYMENT_SWITCH_UNVERIFIED: '候选 release 未通过运行 commit / 工具摘要核验。', DEPLOYMENT_ROLLBACK_FAILED: '切换失败且旧 release 未恢复。',
  DEPLOYMENT_ROLLBACK_CONFLICT: '回退发现其他实例，已停止自动处理并保留现场。',
};
function freshness(observation) {
  if (!observation?.at) return 'freshness unknown';
  return `${observation.stale ? 'stale' : 'current'} · ${observation.source ?? 'source unknown'} · ${new Date(observation.at).toLocaleTimeString()}`;
}
function operationLines(events) {
  const operations = events.filter(event => event.operation_id);
  const terminal = new Set(operations.filter(event => event.outcome !== 'requested').map(event => event.operation_id));
  return operations.map(event => `${event.at}  ${event.operation_id}  ${event.action}/${event.target}  ${event.outcome === 'requested' && !terminal.has(event.operation_id) ? 'unknown' : event.outcome}${event.code ? ' / ' + event.code : ''}`);
}
function operationOutcome(ok, receipt, operationId) {
  if (receipt?.operation_id !== operationId || !['succeeded', 'failed'].includes(receipt.outcome)) return 'unknown';
  if ((ok && receipt.outcome !== 'succeeded') || (!ok && receipt.outcome !== 'failed')) return 'unknown';
  return receipt.outcome;
}
function render(next) {
  state = next;
  $('#overall').textContent = state.observeOnly ? 'observeOnly · 日常动作不可用' : state.busy ? 'Supervisor 正在执行操作…' : '本地状态 · 以当前观察证据为准';
  $('#checked').textContent = 'snapshot observed_at：' + (state.at ? new Date(state.at).toLocaleString() : 'unknown');
  $('#auto-recovery').textContent = `自动恢复：${value(state.autoRecovery)}（只读；打开或刷新本页不会更改）`;
  const yca = state.units.yca, tunnel = state.units.tunnel;
  for (const [id, observation] of Object.entries({ yca, tunnel })) {
    const card = $('#' + id);
    card.querySelector('.status').textContent = observation.status ?? '未知';
    card.querySelector('.status').dataset.status = observation.status ?? '未知';
    card.querySelector('.evidence').textContent = `running=${value(observation.running)} · healthy=${value(observation.healthy)} · owned=${value(observation.owned)} · desired=${observation.desired ?? 'unknown'} · activity=${activity(observation.activity)} · blocked/code=${observation.blocked ?? observation.code ?? 'none'} · ${freshness(observation)}`;
    card.querySelector('.details').textContent = JSON.stringify(observation, null, 2);
  }
  const deployment = yca.deployment ?? {}, remote = deployment.latest;
  $('#yca .versions').textContent = `软件版本：YCA ${state.versions?.yca ?? 'unknown'} / Control Center ${state.versions?.controlCenter ?? 'unknown'} / Node ${state.versions?.node ?? 'unknown'}\nrelease running=${commit(deployment.running)}\nrelease selected=${commit(deployment.target)}\nrelease remote=${remote?.stale === false ? commit(remote) : remote?.commit ? `${remote.commit} (stale${remote.error ? ' / ' + remote.error : ''})` : 'unknown'}\nrestartRequired=${value(deployment.restartRequired)} · remoteDiffers=${value(deployment.remoteDiffers)}`;
  $('#tunnel .versions').textContent = `软件版本：${state.versions?.tunnel ?? 'unknown'}\nlocal ready=${value(tunnel.ready)} · control-plane=${tunnel.controlPlane?.state ?? 'unknown'} · communication=${tunnel.communication?.state ?? 'unknown'}\n上述本地/代理证据不等于 ChatGPT 端到端可用。`;
  $('#operations').textContent = operationLines(state.events ?? []).join('\n') || '暂无操作';
  document.querySelectorAll('[data-action],[data-deployment-action]').forEach(button => { button.disabled = busy || state.observeOnly || Boolean(state.busy); });
}
async function refresh() {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error('STATUS_UNAVAILABLE');
  render(await response.json());
}
function needsImpactConfirmation(target) {
  if (target === 'tunnel' && state.units.yca.running === false) return false;
  const current = state.units.yca;
  return current.running !== false && (!current.activity || Object.values(current.activity).some(count => count > 0));
}
async function requestOperation(url, body) {
  if (busy) return;
  busy = true;
  const operationId = crypto.randomUUID();
  $('#notice').textContent = `操作已请求：${operationId}；等待 Supervisor 终态。`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify({ operation_id: operationId, ...body }) });
    const receipt = await response.json();
    const outcome = operationOutcome(response.ok, receipt, operationId);
    if (outcome === 'succeeded') $('#notice').textContent = `操作已完成：${operationId}`;
    else if (outcome === 'failed') $('#notice').textContent = `操作失败：${operationId} · ${messages[receipt.code] ?? receipt.code ?? 'ACTION_FAILED'}`;
    else $('#notice').textContent = `操作结果未知：${operationId}。终态回执缺失或不匹配；请刷新状态与事件核对，本页不会自动重试。`;
  } catch {
    $('#notice').textContent = `操作结果未知：${operationId}。连接在终态前中断；请刷新状态与事件核对，本页不会自动重试。`;
  } finally {
    busy = false;
    try { await refresh(); } catch { $('#overall').textContent = '服务状态 unavailable · 已显示的证据可能过期'; }
  }
}
document.querySelectorAll('[data-action]').forEach(button => button.onclick = async () => {
  const body = { id: button.dataset.id, action: button.dataset.action };
  if (['stop', 'restart'].includes(body.action) && needsImpactConfirmation(body.id)) {
    if (!confirm('存在活动任务或活动状态未知。动作可能中断请求，且不会自动重放。确认仅针对本次操作，是否继续？')) return;
    body.confirm = true;
  }
  await requestOperation('/api/action', body);
});
$('[data-deployment-action]').onclick = async () => {
  const body = { action: 'update-restart' }, impact = needsImpactConfirmation('yca');
  const prompt = impact ? '存在活动任务或活动状态未知。更新会准备候选，再次核验 activity、release、进程身份与 ownership 后才切换；失败会按既有规则有限回退。确认仅针对本次操作，是否继续？'
    : '检查、准备并切换远端默认分支当前版本，然后重启 YCA？这不同于“仅重启当前版本”，失败会按既有规则有限回退。';
  if (!confirm(prompt)) return;
  if (impact) body.confirm = true;
  await requestOperation('/api/deployment', body);
};
$('#refresh').onclick = () => refresh().catch(() => { $('#overall').textContent = '服务状态 unavailable · 已显示的证据可能过期'; });
refresh().catch(() => { $('#overall').textContent = '服务状态 unavailable'; });
setInterval(() => refresh().catch(() => { $('#overall').textContent = '服务状态 unavailable · 已显示的证据可能过期'; }), 5000);
