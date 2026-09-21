import type { Harness } from './harness.ts';
import { HarnessError } from './model.ts';
import type { RecordEntry } from './model.ts';
import type { PageQuery } from './conversations.ts';
import { protectedCopy } from './content-policy.ts';
import type { ConversationItem, ConversationPage, Participant, OverviewDto, TicketDto, WorkflowDto, SourceRef, AuxiliaryMetadata } from './presentation-model.ts';

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
const text = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback;
const system: Participant = { id: 'harness', role: 'system', label: 'Harness' };
const fieldText = (v: unknown): string | null => typeof v === 'string' ? v : null;
const flag = (v: unknown): boolean | 'unknown' => typeof v === 'boolean' ? v : 'unknown';
const identity = (v: unknown): string | null => typeof v === 'string' && v.trim() && !v.includes('[REDACTED') ? v : null;
const issueList = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.filter((issue): issue is string => typeof issue === 'string' && issue.length > 0))]
  : [];
function executionIssues(status: string, payload: Record<string, unknown>): string[] {
  return [...new Set([
    ...(['failed', 'turn.failed', 'error', 'diagnostic', 'collection-failed', 'cancelled', 'timed-out', 'interrupted'].includes(status) ? [status] : []),
    ...(payload.error != null || payload.isError === true ? ['报告错误'] : []),
    ...(typeof payload.exit_code === 'number' && payload.exit_code !== 0 ? ['退出码 ' + payload.exit_code] : []),
    ...(typeof payload.stderr === 'string' && payload.stderr.length > 0 ? ['stderr 诊断'] : []),
  ])];
}

// Only this mapper knows the currently persisted source format. Unknown facts remain visible.
export function projectRecord(record: RecordEntry): ConversationItem {
  const protectedRecord = protectedCopy(record), safe = protectedRecord.value, d = safe.data;
  const sourceRefs: SourceRef[] = [{ kind: 'record', id: safe.event_id }, { kind: 'source', id: safe.source_id }];
  const base: Pick<ConversationItem, 'id' | 'timestamp' | 'cursor' | 'participant' | 'sourceRefs' | 'integrity' | 'rawEvidence' | 'auxiliary'> = { id: safe.event_id, timestamp: safe.observed_at, cursor: safe.cursor, participant: system,
    sourceRefs, integrity: { redacted: protectedRecord.redacted, truncated: 'unknown' as boolean | 'unknown', incomplete: 'unknown' as boolean | 'unknown' }, rawEvidence: safe };
  const event = (kind: 'lifecycle' | 'workflow' | 'control' | 'task' | 'unknown', title: string, body = '', status: string | null = null): ConversationItem =>
    ({ ...base, kind, content: { title, text: body, status } });
  const integrity = (v: unknown) => {
    const i = object(v);
    base.integrity = { redacted: base.integrity.redacted || i.redacted === true,
      truncated: i.truncated === 'source-output-limit' ? true : flag(i.truncated), incomplete: flag(i.incomplete) };
  };
  const auxiliary = (family: string, category: AuxiliaryMetadata['category'], source: string, scope: string | null,
    operationId: string | null, status: string, issues: string[]) => {
    base.auxiliary = { family, category, source: safe.source_id + ':' + source, scope, operationId,
      observedAt: base.timestamp, status, issues };
  };
  switch (d.kind) {
    case 'registered': return event('lifecycle', 'Ticket 已登记', d.ticket.title);
    case 'attached':
      sourceRefs.push({ kind: 'session', id: d.binding.session_id }, { kind: 'binding', id: d.binding.id });
      return event('lifecycle', d.previous_session_id && d.previous_session_id !== d.binding.session_id ? '切换到新的工程会话' : '工程会话已关联', 'Conversation 保留连续历史；执行上下文独立。');
    case 'child_conversation_associated': return event('lifecycle', '独立 Conversation 已关联', '与主 Conversation 关联，不继承其上下文。', d.association.isolation.state);
    case 'workflow_snapshot': return event('workflow', 'Workflow 已更新', '当前阶段：' + d.workflow.snapshot.phase, d.workflow.assessment.state);
    case 'workflow_observation': return event('workflow', 'Workflow 事实已刷新', '', d.workflow.assessment.state);
    case 'control_action': {
      base.timestamp = d.control.occurred_at;
      integrity(d.control.integrity);
      const label = { refresh: '刷新工程状态', 'run.stop': '停止已有运行', 'task.stop': '停止受管任务', 'worktree.open': '打开工作目录' }[d.control.action];
      auxiliary('control:' + d.control.action, 'control', 'control', JSON.stringify([d.control.action, d.control.target]),
        identity(d.control.control_id), d.control.outcome, [...executionIssues(d.control.outcome, object(d.control.source_status)),
          ...(d.control.integrity.capture === 'recording-failed' ? ['采集失败'] : [])]);
      return event('control', label, d.control.stage === 'requested' ? '已记录请求' : '控制结果已记录', d.control.outcome);
    }
    case 'owned_task': {
      base.timestamp = d.task.source_at ?? base.timestamp;
      integrity(d.task.integrity);
      const payload = object(d.task.payload);
      const status = text(object(d.task.snapshot).status, 'unknown');
      const taskScope = JSON.stringify([d.task.binding.service_epoch, d.task.binding.binding_id, d.task.binding.task_id]);
      const taskCategory = d.task.category === 'output' ? 'output' : d.task.category === 'observation' ? 'observation' : 'task';
      const taskFamily = d.task.category === 'output' ? 'task-output' : d.task.category === 'observation' ? 'owned-task-observation' : 'owned-task-lifecycle';
      auxiliary(taskFamily, taskCategory, d.task.source, taskScope, null, status === 'unknown' ? d.task.kind : status,
        [...executionIssues(status, object(d.task.snapshot)), ...(payload.stream === 'stderr' ? ['stderr 诊断'] : []),
          ...(d.task.integrity.capture === 'collection-failed' ? ['采集失败'] : [])]);
      return event('task', d.task.category === 'output' ? '任务输出 · ' + text(payload.stream, 'output') : '受管任务 · ' + d.task.kind,
        d.task.category === 'output' ? text(payload.text, '来源未提供文本输出') : d.task.binding.task_id,
        text(object(d.task.snapshot).status, 'unknown'));
    }
    case 'computer_call': {
      integrity(d.call.integrity);
      const input = object(d.call.input), result = object(d.call.result);
      const category = d.call.tool === 'powershell' || d.call.tool === 'powershell_execute' ? 'command' : 'tool';
      auxiliary(category, category, d.call.source + ':' + d.call.tool, d.call.conversation_id, identity(d.call.call_id), d.call.outcome,
        [...executionIssues(d.call.outcome, { ...result, error: d.call.error ?? result.error }),
          ...(d.call.capture === 'collection-failed' ? ['采集失败'] : []),
          ...(object(d.call.attribution).state === 'attribution mismatch' ? ['归属不匹配'] : [])]);
      return { ...base, kind: 'tool', content: { title: d.call.tool, status: d.call.outcome,
        command: fieldText(input.command) ?? fieldText(input.script), output: fieldText(result.stdout) ?? fieldText(result.content) ?? fieldText(d.call.result) } };
    }
    case 'event': {
      const e = d.event, p = object(e.payload), item = object(p.item);
      integrity(e.integrity);
      base.timestamp = e.source_at ?? base.timestamp;
      sourceRefs.push({ kind: 'binding', id: e.binding_id }, { kind: 'session', id: e.session_id });
      if (e.run_id) sourceRefs.push({ kind: 'run', id: e.run_id });
      if (e.thread_id) sourceRefs.push({ kind: 'thread', id: e.thread_id });
      if (e.kind === 'message.sent') return { ...base, participant: { id: 'caller:' + text(p.sender, 'caller'), role: 'coordinator', label: text(p.sender, '协作请求') }, kind: 'message', content: { text: text(p.text, '来源未提供消息正文') } };
      if (e.kind === 'source.snapshot') {
        const run = object(p.run), attributionState = object(p.attribution).state;
        auxiliary('run-observation', 'observation', 'engineer', e.run_id ? JSON.stringify([e.binding_id, e.session_id, e.run_id, e.thread_id]) : null,
          null, text(run.status, 'unknown'), [...executionIssues(text(run.status), run),
            ...(attributionState === 'attribution mismatch' ? ['归属不匹配'] : attributionState === 'unknown' ? ['归属未知'] : [])]);
        return event('lifecycle', '运行状态 · ' + text(run.status, 'unknown'), [text(run.model), text(run.reasoning)].filter(Boolean).join(' · '), text(object(p.attribution).state, 'unknown'));
      }
      if (e.kind === 'stderr') {
        auxiliary('engineer-diagnostic', 'output', 'engineer', null, null, 'diagnostic', ['stderr 诊断']);
        return event('lifecycle', '运行诊断', text(p.text), 'diagnostic');
      }
      if (e.kind === 'thread.switched') return event('lifecycle', '执行上下文已切换');
      if (e.kind === 'recovery.observed') {
        auxiliary('recovery', 'recovery', 'engineer', e.run_id ? JSON.stringify([e.binding_id, e.session_id, e.run_id, e.thread_id]) : null,
          null, 'observed', [...executionIssues('observed', p), ...issueList(p.gaps)]);
        return event('lifecycle', '已恢复历史观察', '保留记录与来源缺口；未自动续跑。');
      }
      if (e.kind === 'codex') {
        base.participant = { id: 'engineer:' + e.session_id, role: 'engineer', label: '工程 Agent', provider: 'Codex' };
        if (item.type === 'agent_message' && typeof item.text === 'string') return { ...base, kind: 'message', content: { text: item.text } };
        if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
          const category = item.type === 'command_execution' ? 'command' : 'tool';
          auxiliary(category, category, 'engineer',
          e.run_id ? JSON.stringify([e.binding_id, e.session_id, e.run_id, e.thread_id]) : null,
          identity(item.id), text(item.status, text(p.type, 'unknown')), executionIssues(text(item.status, text(p.type)), { ...object(item.result), ...item }));
        }
        if (item.type === 'command_execution') return { ...base, kind: 'tool', content: { title: '执行命令',
          status: text(item.status, text(p.type)), command: fieldText(item.command), output: fieldText(item.aggregated_output) } };
        if (item.type === 'mcp_tool_call') return { ...base, kind: 'tool', content: { title: text(item.tool, '工具调用'),
          status: text(item.status, text(p.type)), command: null, output: fieldText(item.result) } };
        const lifecycle: Record<string, string> = { 'thread.started': '工程上下文已建立', 'turn.started': '开始执行', 'turn.completed': '本轮执行已结束', 'turn.failed': '本轮执行失败', error: '执行报告错误' };
        if (typeof p.type === 'string' && lifecycle[p.type]) {
          auxiliary('engineer-lifecycle', 'lifecycle', 'engineer', e.run_id ? JSON.stringify([e.binding_id, e.session_id, e.run_id, e.thread_id]) : null,
            null, p.type, executionIssues(p.type, p));
          return event('lifecycle', lifecycle[p.type], text(p.message), p.type);
        }
      }
      return event('unknown', '其他来源事件', '此记录尚无专用阅读视图，可在 Advanced 查看已保护的原始证据。', e.kind);
    }
    default: return event('unknown', '其他记录', '原始证据已保留。');
  }
}

export class Presentation {
  constructor(privateHarness: Harness) { this.harness = privateHarness; }
  private harness: Harness;
  overview(): OverviewDto {
    const source = this.harness.overview();
    return protectedCopy({ recording: source.recording, projects: source.projects.map(p => ({ id: p.id, key: p.key, name: p.name,
      tickets: p.tickets.map(t => {
        const w = t.workflow;
        const accepted = w.acceptance?.accepted === true;
        return { id: t.id, key: t.key, title: t.title, phase: w.phase ?? 'unknown', accepted,
          findings: w.findings?.filter(f => f.status !== 'verified').length ?? 0,
          review_status: w.reviews?.at(-1)?.status ?? 'pending', changes_state: t.changes.freshness,
          file_count: t.changes.file_count, attention: t.changes.completeness !== 'complete'
            || ['stale', 'mismatch'].includes(w.assessment?.state ?? '') || ['failed', 'incomplete'].includes(w.acceptance?.status ?? '')
            || !!w.findings?.some(f => f.status !== 'verified') };
      }) })) }).value;
  }
  conversation(id: string, query: PageQuery = {}): ConversationPage {
    const h = this.harness;
    const ticket = [...h.tickets.values()].find(t => t.main_conversation_id === id);
    const ticketId = ticket?.id ?? h.conversations.conversations.get(id)?.ticket_id;
    if (!ticketId) throw new HarnessError('CONVERSATION_NOT_FOUND');
    const page = h.conversations.page(id, query);
    return { id, ticket_id: ticketId, items: page.records.map(projectRecord), page: {
      first_cursor: page.first_cursor, last_cursor: page.last_cursor, high_water_cursor: page.high_water_cursor,
      has_older: page.has_older, has_newer: page.has_newer } };
  }
  ticket(id: string): TicketDto {
    const d = this.harness.detail(id), w = d.workflow.current, summary = this.harness.workflowHistory.summary(id);
    const workflow: WorkflowDto = { phase: w?.phase ?? 'unknown', revision: w?.revision ?? null,
      assessment: w?.assessment.state ?? 'unknown', acceptance: w?.acceptance.status ?? 'pending',
      accepted: summary.acceptance?.accepted === true, closeout: w?.closeout.status ?? 'pending',
      reviews: w?.reviews.map(r => ({ id: r.review_id, mode: r.mode, status: r.status, applicability: r.applicability,
        standards: r.standards.status, spec: r.spec.status, original_review_id: r.original_review_id ?? null })) ?? [],
      findings: w?.findings.map(f => ({ id: f.finding_id, origin_review_id: f.origin_review_id,
        identity: JSON.stringify([f.origin_review_id, f.finding_id]), status: f.status, title: text(object(f).summary, f.finding_id) })) ?? [] };
    return protectedCopy({ ticket: { id: d.ticket.id, key: d.ticket.key, title: d.ticket.title, reference: d.ticket.reference,
      main_conversation_id: d.ticket.main_conversation_id },
      conversation: this.conversation(d.ticket.main_conversation_id),
      conversations: [{ id: d.ticket.main_conversation_id, label: 'Main', kind: 'main' as const, isolation: null, original_review_id: null, finding_refs: [], review_id: null, participant: null },
        ...d.child_conversations.map(c => {
          const relation = c.relation;
          const review = relation.kind === 'review' ? w?.reviews.find(r => r.review_id === relation.review_id) : null;
          return { id: c.conversation_id, label: c.relation.kind === 'review'
            ? (review?.mode === 'focused' ? 'Focused Review' : 'Review') + ' · ' + c.relation.participant : 'Acceptance',
            kind: c.relation.kind === 'review' ? review?.mode === 'focused' ? 'focused' as const : 'review' as const : 'acceptance' as const,
            review_id: relation.kind === 'review' ? relation.review_id : null, participant: relation.kind === 'review' ? relation.participant : null,
            isolation: c.isolation.state, original_review_id: review?.original_review_id ?? (relation.kind === 'review' ? relation.original_review_id : null),
            finding_refs: (review?.finding_refs ?? (relation.kind === 'review' ? relation.finding_refs : [])).map(f => f.origin_review_id + '/' + f.finding_id) };
        })], workflow, changes: { state: d.changes.state, baseline: d.changes.baseline?.commit_oid ?? null,
        current_head: d.changes.current_head, checked_at: d.changes.checked_at, freshness: d.changes.freshness,
        completeness: d.changes.completeness, files: d.changes.files.map(f => ({ file_id: f.file_id, revision: f.revision,
          path: f.path, old_path: f.old_path, change_kind: f.change_kind, content_state: f.content.state,
          content_type: f.content.content_type, start_relation: f.start_relation })), commits: d.changes.commits,
        run_count: d.changes.runs.length, evidence_gaps: d.changes.evidence_gaps },
      controls: [...d.controls.runs.map(r => { const value = object(r); return { kind: 'run' as const, id: text(value.run_id),
        status: text(object(value.execution).status, 'unknown'), observation: text(object(value.observation).state, 'unknown'), manageable: value.manageable === true }; }),
        ...d.controls.tasks.map(t => ({ kind: 'task' as const, id: t.task_id, status: t.execution.status,
          observation: t.observation.state, manageable: t.manageable }))], recording: d.recording,
      rawEvidence: { workflow: d.workflow, changes: { sources: d.changes.sources, evidence_gaps: d.changes.evidence_gaps },
        controls: d.controls, source_gaps: d.source_gaps } }).value;
  }
}
