import { host, useValue, useQuery, queryClient, Button, Badge, LogView } from '@hermes/plugin-sdk';
import { createElement as h, useState, useEffect, useRef } from 'react';

const terminal = new Set(['completed', 'failed', 'stopped', 'timed_out', 'interrupted']);
const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const block = (title, children) => h('section', { className: 'space-y-2 border-b border-(--ui-stroke-tertiary) pb-3' },
  h('h3', { className: 'font-medium' }, title), children);
const log = children => h(LogView, { className: 'max-h-72' }, text(children));
const button = (label, onClick, disabled = false) => h(Button, { size: 'sm', variant: 'outline', onClick, disabled }, label);
const scopeKey = scope => [scope.connection, scope.profile, scope.chat, scope.project];
const abort = signal => { if (signal?.aborted) throw new DOMException('Observation cancelled', 'AbortError'); };

export async function rest(ctx, path, options = {}, signal) {
  abort(signal);
  // This SDK has timeoutMs but no native AbortSignal argument. Cancellation
  // discards in-flight results and prevents the next page; each IPC is bounded.
  const result = await ctx.rest(path, { timeoutMs: 20000, ...options });
  abort(signal);
  if (result?.error) {
    const error = new Error(result.error.code);
    Object.assign(error, result.error); throw error;
  }
  return result;
}
export function mergeEventPage(previous, page) {
  if (previous && previous.source_id !== page.source_id) throw new Error('SOURCE_CHANGED');
  if (previous && page.next_cursor < previous.cursor) throw new Error('INVALID_CURSOR');
  const map = new Map((previous?.events ?? []).map(event => [event.event_id, event]));
  for (const event of page.events) {
    if (event.source_id !== page.source_id || event.cursor > page.next_cursor) throw new Error('SOURCE_CHANGED');
    map.set(event.event_id, event);
  }
  const all = [...map.values()].sort((left, right) => left.cursor - right.cursor);
  return { source_id: page.source_id, events: all.slice(-1000), cursor: page.next_cursor,
    has_more: page.has_more, high_water_cursor: page.high_water_cursor,
    truncated: previous?.truncated || all.length > 1000 };
}
export async function readEventPage(ctx, ticketId, sourceId, previous, highWater, conversationId, signal) {
  const query = new URLSearchParams({ source_id: sourceId, after: String(previous?.cursor ?? 0), limit: '100' });
  if (!previous?.history_complete) query.set('until', String(previous?.high_water_cursor ?? highWater));
  if (conversationId) query.set('conversation_id', conversationId);
  const page = await rest(ctx, '/tickets/' + ticketId + '/events?' + query, {}, signal);
  return { ...mergeEventPage(previous, page), history_complete: previous?.history_complete || !page.has_more };
}

function Pane({ ctx }) {
  const connection = useValue(host.state.connectionId);
  const profile = useValue(host.state.profile);
  const focusedOwner = useValue(host.state.focusedSessionOwner);
  const chat = useValue(host.state.focusedStoredSessionId);
  const visible = useValue(host.paneVisibility('yer-engineering:pane'));
  const base = ['yer-engineering', connection, profile, chat];
  const ready = Boolean(visible && connection && profile && chat &&
    (!focusedOwner || focusedOwner.connectionId === connection && focusedOwner.profile === profile));
  const selectionKey = JSON.stringify(base);
  const [selection, setSelection] = useState(() => ({ key: selectionKey, value: ctx.storage.get(selectionKey, null) }));
  const [mode, setMode] = useState('current');
  const [file, setFile] = useState(null);
  const [conversation, setConversation] = useState('');
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelection({ key: selectionKey, value: ctx.storage.get(selectionKey, null) });
    setFile(null); setPreview(null); setConversation(''); setNotice('');
  }, [selectionKey, ctx]);
  const connectionQuery = useQuery({ queryKey: [...base, 'connection'], enabled: ready,
    queryFn: ({ signal }) => rest(ctx, '/connection', {}, signal), refetchInterval: 60000, retry: false });
  const backend = connectionQuery.data;
  const connected = ready && backend?.connection_id === connection && backend?.profile === profile;
  const tickets = useQuery({ queryKey: [...base, backend?.source_id, 'tickets'], enabled: Boolean(connected),
    queryFn: ({ signal }) => rest(ctx, '/tickets', {}, signal), retry: false });
  const ticketId = selection?.key === selectionKey && selection.value && backend?.source_id
    && selection.value.source_id === backend.source_id ? selection.value.ticket_id : null;
  const key = [...base, backend?.source_id, ticketId];
  const currentKey = useRef(''); currentKey.current = JSON.stringify(key);
  const snapshot = useQuery({ queryKey: [...key, 'snapshot'], enabled: Boolean(connected && ticketId),
    queryFn: ({ signal }) => rest(ctx, '/tickets/' + ticketId, {}, signal),
    refetchInterval: query => query.state.data?.runs?.some(run => !terminal.has(run.status)) ? 5000 : 15000, retry: false });
  const data = snapshot.data;
  const scope = { connection, profile, chat, project: data?.ticket.project_id ?? '' };
  const eventsKey = [...key, 'events', conversation];
  const events = useQuery({ queryKey: eventsKey, enabled: Boolean(connected && data),
    queryFn: async ({ signal }) => {
      try {
        const previous = queryClient.getQueryData(eventsKey);
        return await readEventPage(ctx, ticketId, backend.source_id, previous, data.high_water_cursor, conversation, signal);
      } catch (error) {
        if (/INVALID_CURSOR|SOURCE_CHANGED/.test(error.code ?? error.message)) {
          queryClient.removeQueries({ queryKey: eventsKey, exact: true });
          queryClient.invalidateQueries({ queryKey: [...key, 'snapshot'] });
          queryClient.invalidateQueries({ queryKey: [...base, 'connection'] });
        }
        throw error;
      }
    },
    refetchInterval: query => query.state.data?.has_more ? 200
      : data?.runs?.some(run => !terminal.has(run.status)) ? 1500 : 10000,
    retry: false });
  const patch = useQuery({ queryKey: [...key, 'patch', mode, file?.file_id, file?.revision],
    enabled: Boolean(connected && file), retry: false,
    queryFn: ({ signal }) => rest(ctx, '/tickets/' + ticketId + '/patch?' + new URLSearchParams({
      file_id: file.file_id, revision: file.revision, mode }), {}, signal) });
  useEffect(() => {
    if (patch.data?.state === 'stale') queryClient.invalidateQueries({ queryKey: [...key, 'snapshot'] });
  }, [patch.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const control = async (kind, body) => {
    if (!connected || !data || connectionQuery.isError || snapshot.isError) return;
    const capturedKey = JSON.stringify(key), capturedScope = scopeKey(scope);
    setBusy(true); setNotice('');
    try {
      const result = await rest(ctx, '/tickets/' + ticketId + '/' + kind,
        { method: 'POST', body: { ...body, scope, csrf: backend.csrf } });
      if (capturedKey !== currentKey.current || host.state.connectionId.get() !== connection
          || host.state.profile.get() !== profile || host.state.focusedStoredSessionId.get() !== chat) return;
      if (kind === 'preview') setPreview({ ...result, ui_scope: capturedScope, ui_key: capturedKey });
      else { setPreview(null); setNotice('已收到执行回执；过程会继续更新。'); refresh(); }
    } catch (error) {
      setNotice(error.reconciliation_required ? '响应未知。请查询原操作；不会自动重派。' : error.message);
      if (/CONFLICT|STALE|EXPIRED/.test(error.code ?? error.message)) { setPreview(null); refresh(); }
    } finally { setBusy(false); }
  };
  const choose = event => {
    const next = event.target.value ? { source_id: backend.source_id, ticket_id: event.target.value } : null;
    ctx.storage.set(selectionKey, next); setSelection({ key: selectionKey, value: next }); setFile(null); setPreview(null); setConversation('');
  };
  const changes = data?.changes[mode];
  const workflow = data?.workflow.current;
  const stale = snapshot.isError || events.isError || connectionQuery.isError;
  return h('div', { className: 'h-full overflow-auto space-y-4 p-3 text-sm' },
    h('div', { className: 'flex items-center gap-2' }, h('strong', null, 'YER 工程'),
      h(Badge, { variant: 'outline' }, stale ? '连接过期 / 状态未知' : data ? '已连接' : '未选择工作项'),
      button('刷新', () => { connectionQuery.refetch(); refresh(); }, busy)),
    !ready && h('p', null, '在当前连接与 profile 下打开持久会话后，可关联工程 Ticket。'),
    ready && connectionQuery.error && log(connectionQuery.error.message),
    ready && backend && !connected && h('p', null, '宿主连接身份不匹配，请核对插件配置。'),
    h('select', { value: ticketId ?? '', onChange: choose, disabled: !connected, 'aria-label': '工程 Ticket',
      className: 'w-full rounded border bg-transparent p-2' },
      h('option', { value: '' }, '选择已登记的 Ticket'),
      ...(tickets.data?.tickets ?? []).map(ticket => h('option', { key: ticket.id, value: ticket.id }, ticket.key + ' · ' + ticket.title))),
    data && block('工作与运行', h('div', { className: 'space-y-2' },
      h('p', null, data.ticket.key + ' · ' + data.ticket.title),
      h('p', { className: 'break-all text-xs' }, data.ticket.expected_worktree),
      ...data.work_items.map(item => h('div', { key: item.work_item_id },
        h(Badge, { variant: 'outline' }, item.purpose + ' · ' + item.state),
        h('span', { className: 'ml-2 text-xs' }, '会话代 ' + item.generation))),
      ...data.runs.map(run => {
        const item = data.work_items.find(item => item.generations.some(gen => gen.session_id === run.session_id));
        return h('div', { key: run.run_id, className: 'rounded border p-2 space-y-1' },
          h('p', null, [run.backend_kind, run.model ?? '模型未知', run.reasoning, run.service_tier, run.status].filter(Boolean).join(' · ')),
          h('p', { className: 'text-xs' }, '权限：' + (run.permissions?.sandbox_mode ?? 'unknown') + ' · 来源：' + (run.permissions?.source ?? 'unknown')),
          h('details', null, h('summary', null, '运行引用'), log(run.source_ref)),
          item && !terminal.has(run.status) && button('停止此运行', () => control('actions', { action: { action: 'stop',
            input: { ticket_id: ticketId, work_item: { work_item_id: item.work_item_id, revision: item.revision },
              session_id: run.session_id, run_id: run.run_id } } }), busy || stale));
      }),
      data.runs.length === 0 && h('p', null, '尚无已绑定的运行。'))),
    data && block('工程计划', h('div', { className: 'space-y-2' },
      ...data.plans.map(plan => h('div', { key: plan.plan_id, className: 'flex flex-wrap gap-2 items-center' },
        h('span', null, plan.label),
        plan.receipt ? h(Badge, { variant: 'outline' }, plan.receipt.effective_state ?? plan.receipt.state)
          : button('预览计划', () => control('preview', { plan_id: plan.plan_id }), busy || stale),
        button('查询原操作', async () => {
          try {
            const receipt = await rest(ctx, '/tickets/' + ticketId + '/operations?' + new URLSearchParams({ request_id: plan.request_id }));
            setNotice(text(receipt.receipt)); refresh();
          } catch (error) { setNotice(error.message); }
        }, busy))),
      data.plans.length === 0 && h('p', null, 'Emilia 提出工程计划后，可在此预览与确认。已有授权的执行直接返回回执。'),
      preview?.ui_key === JSON.stringify(key) && h('div', { className: 'rounded border p-3 space-y-2' },
        h('strong', null, '确认此工程计划'),
        h('p', null, (preview.plan.input.action ?? preview.plan.input.label) + ' · ' + preview.worktree),
        h('p', null, '模型：' + [preview.profile?.model ?? preview.state.policy?.model,
          preview.profile?.reasoning ?? preview.state.policy?.reasoning, preview.profile?.service_tier].filter(Boolean).join(' · ')),
        h('p', null, '权限：' + (preview.permissions?.sandbox_mode ?? '工程验证进程') + ' · ' + (preview.permissions?.source ?? '受管测试计划')),
        h('p', null, '确认仅适用于当前内容与职责；Review 和 Acceptance 保持各自门禁。'),
        preview.plan.agent_criterion && h('p', null, 'Agent 验收要求：' + preview.plan.agent_criterion.requirement),
        preview.plan.kind === 'verification' ? log(preview.plan.input.script)
          : log(preview.plan.input.current_delta ?? preview.plan.input.references),
        button('确认执行', () => control('confirm', { preview_id: preview.preview_id,
          payload_digest: preview.payload_digest }), busy || stale || JSON.stringify(preview.ui_scope) !== JSON.stringify(scopeKey(scope))),
        button('取消', () => setPreview(null), busy)),
      notice && log(notice))),
    data && block('修改', h('div', { className: 'space-y-2' },
      h('div', { className: 'flex gap-2' }, button('当前修改', () => { setMode('current'); setFile(null); }),
        button('累计修改', () => { setMode('cumulative'); setFile(null); })),
      h('p', { className: 'text-xs' }, mode === 'current' ? 'HEAD → 暂存区 → 工作区，以及未跟踪文件' : 'Ticket fixed point → 当前净内容；包含已提交改动'),
      changes?.state !== 'available' && h('p', null, '修改事实暂不可用'),
      ...(changes?.files ?? []).map(value => h('div', { key: value.file_id },
        button((value.layer ?? value.change_kind) + ' · ' + value.path, () => setFile(value)),
        h('span', { className: 'ml-2 text-xs' }, value.start_relation === 'pre-existing-at-start' ? '开始前已有'
          : value.start_relation === 'pre-existing-overlap' ? '与已有修改重叠' : '修改归属未证明'))),
      mode === 'cumulative' && h('details', null, h('summary', null, '提交记录'), log(changes?.commits ?? [])),
      file && h('div', null, h('p', null, file.path), patch.isLoading ? '读取中…' : patch.error ? log(patch.error.message)
        : patch.data?.state === 'available' ? log(patch.data.patch)
          : h('p', null, 'Patch：' + (patch.data?.state ?? 'unknown') + ' · ' + (patch.data?.integrity?.reason ?? ''))),
      h('details', null, h('summary', null, '完整性与来源'), log(changes?.evidence_gaps ?? [])))),
    data && block('Review / finding / Acceptance', h('div', { className: 'space-y-2' },
      h('p', null, '当前阶段：' + (workflow?.phase ?? 'unknown')),
      ...data.child_conversations.map(child => h('p', { key: child.conversation_id },
        [child.relation?.kind, child.relation?.review_id ?? child.relation?.acceptance_id,
          '隔离：' + (child.isolation?.state ?? 'unknown')].filter(Boolean).join(' · '))),
      ...(workflow?.reviews ?? []).map(review => h('div', { key: review.review_id },
        h('p', null, review.review_id + ' · ' + review.status), log(review.reports ?? review.report_ref ?? review))),
      ...(workflow?.findings ?? []).map(finding => h('p', { key: finding.finding_id },
        finding.finding_id + ' · ' + finding.status + ' · ' + (finding.summary ?? finding.report_ref ?? ''))),
      h('p', null, 'Acceptance：' + (workflow?.acceptance?.status ?? 'unknown')),
      h('details', null, h('summary', null, '验收证据与报告引用'), log({ assessment: workflow?.assessment, acceptance: workflow?.acceptance, artifacts: workflow?.artifacts })))),
    data && h('details', null, h('summary', { className: 'font-medium' }, '公开过程与工具 / 命令'),
      h('select', { value: conversation, onChange: event => setConversation(event.target.value), className: 'my-2 border bg-transparent p-1' },
        h('option', { value: '' }, '全部工程会话'), h('option', { value: data.main_conversation.conversation_id }, 'Ticket Main'),
        ...data.child_conversations.map(child => h('option', { key: child.conversation_id, value: child.conversation_id },
          child.relation?.kind + ' · ' + child.conversation_id.slice(0, 8)))),
      events.isError && h('p', null, '增量读取失败，保留上次过程。'),
      events.data?.truncated && h('p', null, '面板仅保留最近 1000 条；完整分页记录保存在 YER。'),
      ...(events.data?.events ?? []).map(event => h('details', { key: event.event_id, className: 'border-t py-1' },
        h('summary', null, event.observed_at + ' · ' + event.category),
        log(event.payload), h('p', { className: 'text-xs' }, event.source_ref))),
      h('p', { className: 'text-xs' }, '只显示已采集的公开内容；内部推理与未采集正文不会补造。')),
    data && h('details', null, h('summary', null, '能力与缺口'), log({ capabilities: data.capabilities, gaps: data.gaps }))
  );
}

export default {
  id: 'yer-engineering', name: 'YER 工程', defaultEnabled: false,
  register(ctx) {
    ctx.register({ id: 'pane', area: 'panes', title: 'YER 工程',
      data: { placement: 'right', width: '440px' }, render: () => h(Pane, { ctx }) });
  },
};
