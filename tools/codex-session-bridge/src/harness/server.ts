import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Harness } from './harness.ts';
import { HarnessError } from './model.ts';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));
const css = 'body{font:16px system-ui;margin:0;background:#f5f3fa;color:#262034}main{max-width:1040px;margin:3rem auto;padding:0 1.5rem}a{color:#6240a0}section,article,aside{background:white;border:1px solid #ded7ec;border-radius:12px;padding:1rem;margin:1rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}small{color:#645c70}.warning{border-left:4px solid #ad6b21}h1{font-size:28px}';
const page = (title: string, body: string) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>' + escape(title) + '</title><link rel="stylesheet" href="/style.css"></head><body><main>'
  + '<nav><a href="/">Yuki Harness · Projects</a></nav><h1>' + escape(title) + '</h1>' + body + '</main></body></html>';
const equal = (value: string | undefined, secret: string) => {
  const bytes = Buffer.from(value ?? ''), expected = Buffer.from(secret);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
};
export function createHarnessServer(harness: Harness) {
  const session = randomBytes(32).toString('hex');
  return http.createServer((req, res) => {
    const origin = 'http://127.0.0.1:' + req.socket.localPort;
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    const send = (status: number, value: unknown, html = false, cookie = false) =>
      res.writeHead(status, { ...headers, 'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        ...(cookie ? { 'set-cookie': 'yuki_harness=' + session + '; HttpOnly; SameSite=Strict; Path=/' } : {}) })
        .end(html ? String(value) : JSON.stringify(value));
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
      || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'] ?? '')) return send(403, { code: 'FORBIDDEN' });
    if (req.method !== 'GET') return send(405, { code: 'READ_ONLY' });
    let url: URL;
    try { url = new URL(req.url ?? '/', origin); }
    catch { return send(400, { code: 'INVALID_URL' }); }
    if (url.pathname === '/style.css') {
      res.writeHead(200, { ...headers, 'content-type': 'text/css; charset=utf-8' }); return res.end(css);
    }
    const cookie = /(?:^|;\s*)yuki_harness=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    if (url.pathname !== '/' && !equal(cookie, session)) return send(403, { code: 'SESSION_REQUIRED' });
    try {
      // Explicit UI refresh asks for current facts. The independent background
      // collector is still responsible for capture while no browser is present.
      harness.scan(true);
      const summary = harness.overview();
      if (url.pathname === '/api/projects') return send(200, summary);
      if (url.pathname === '/') {
        const groups = summary.projects.map(p => '<section><h2>' + escape(p.name) + '</h2><ul>' +
          p.tickets.map(t => {
            const workflow = t.workflow as { phase?: string; assessment?: { state: string }; reviews?: Array<{ status: string }>;
              findings?: Array<{ status: string }>; acceptance?: { status: string; accepted: boolean };
              closeout?: { status: string } };
            const findings = workflow.findings?.filter(value => value.status !== 'verified').length ?? 0;
            const reviews = workflow.reviews?.map(value => value.status).join('/') || 'none';
            const anomaly: string[] = [];
            if (['stale', 'mismatch'].includes(workflow.assessment?.state ?? '')) anomaly.push('applicability ' + workflow.assessment!.state);
            if (['failed', 'incomplete'].includes(workflow.acceptance?.status ?? '')) anomaly.push('Acceptance ' + workflow.acceptance!.status);
            for (const status of ['open', 'fixed', 'fixed-unverified']) {
              const count = workflow.findings?.filter(value => value.status === status).length ?? 0;
              if (count) anomaly.push('finding ' + status + ' ' + count);
            }
            return '<li' + (anomaly.length ? ' class="warning"' : '') + '><a href="/tickets/' + t.id + '">' + escape(t.key + ' · ' + t.title) + '</a>'
              + (anomaly.length ? ' · <strong>异常待处理：' + escape(anomaly.join(' · ')) + '</strong>' : '')
              + (workflow.acceptance ? ' · Workflow ' + escape(workflow.phase) + ' · Acceptance ' + escape(workflow.acceptance.status)
                + (workflow.acceptance.accepted ? '（当前 accepted）' : '（未确认 accepted）')
                + ' · Review ' + escape(reviews) + ' · 待处理/复核 finding ' + findings
                + ' · closeout ' + escape(workflow.closeout?.status ?? 'unknown')
                + ' · applicability ' + escape(workflow.assessment?.state ?? 'unknown') : ' · Workflow 尚未记录') + '</li>';
          }).join('') + '</ul></section>').join('');
        return send(200, page('工程协作历史', '<p>只读观察 · <a href="/">刷新</a></p><aside>Recording: ' + escape(summary.recording.state)
          + '<br>Changes / 服务状态：unavailable（尚未接入）</aside>'
          + (groups || '<p>尚未登记 Project / Ticket。由 Emilia 通过 YCA 显式登记。</p>')), true, true);
      }
      const conversationRoute = /^\/(api\/)?conversations\/([0-9a-f-]+)$/.exec(url.pathname);
      const route = /^\/(api\/)?tickets\/([0-9a-f-]+)$/.exec(url.pathname);
      if (!conversationRoute && !route) return send(404, { code: 'NOT_FOUND' });
      const afterText = url.searchParams.get('after') ?? '0';
      if (!/^\d+$/.test(afterText)) throw new HarnessError('INVALID_CURSOR');
      if (conversationRoute) {
        const detail = harness.conversationDetail(conversationRoute[2], Number(afterText));
        if (conversationRoute[1]) return send(200, detail);
        const records = detail.records.map(record => '<article><strong>' + escape(record.data.kind)
          + '</strong><small> · ' + escape(record.observed_at) + ' · cursor ' + record.cursor + '</small><pre>'
          + escape(JSON.stringify(record.data, null, 2)) + '</pre></article>').join('');
        return send(200, page('子 Conversation', '<p><a href="/tickets/' + detail.ticket_id
          + '">返回 Ticket 主 Conversation</a></p><aside>relation: ' + escape(JSON.stringify(detail.relation))
          + '<br>isolation: ' + escape(detail.isolation.state) + '</aside>' + records
          + (detail.has_more ? '<a href="?after=' + detail.next_cursor + '">后续记录</a>' : '')), true);
      }
      if (!route) return send(404, { code: 'NOT_FOUND' });
      const detail = harness.detail(route[2], Number(afterText));
      if (route[1]) return send(200, detail);
      const records = detail.records.map(r => {
        const d = r.data;
        let label = d.kind === 'attached' ? (d.previous_session_id && d.previous_session_id !== d.binding.session_id ? 'session 切换边界' : 'session/run 显式关联')
          : d.kind === 'event' ? d.event.kind : 'Ticket 登记';
        let text = '';
        if (d.kind === 'computer_call') {
          label = '同步电脑调用 · ' + d.call.tool + ' · ' + d.call.stage + ' · ' + d.call.outcome;
          text = JSON.stringify({ input: d.call.input, result: d.call.result, error: d.call.error,
            capture: d.call.capture, integrity: d.call.integrity }, null, 2);
        }
        if (d.kind === 'owned_task') {
          label = '受管任务 · ' + d.task.kind;
          text = JSON.stringify({ task_id: d.task.binding.task_id, payload: d.task.payload,
            snapshot: d.task.snapshot, integrity: d.task.integrity }, null, 2);
        }
        if (d.kind === 'workflow_snapshot') {
          label = 'Workflow 快照 · revision ' + d.workflow.workflow_revision + ' · ' + d.workflow.snapshot.phase;
          text = JSON.stringify({ subject: d.workflow.snapshot.subject, reviews: d.workflow.snapshot.reviews,
            findings: d.workflow.snapshot.findings, acceptance: d.workflow.snapshot.acceptance,
            closeout: d.workflow.snapshot.closeout, assessment: d.workflow.assessment }, null, 2);
        }
        if (d.kind === 'workflow_observation') {
          label = 'Workflow 事实刷新 · revision ' + d.workflow.workflow_revision;
          text = JSON.stringify(d.workflow.assessment, null, 2);
        }
        if (d.kind === 'event' && d.event.payload && typeof d.event.payload === 'object') {
          const payload = d.event.payload as Record<string, unknown>;
          if (d.event.kind === 'message.sent') { label = '任务 · ' + String(payload.sender ?? 'caller'); text = String(payload.text ?? 'unknown'); }
          else if (d.event.kind === 'stderr') { label = 'stderr'; text = String(payload.text ?? 'unknown'); }
          else if (d.event.kind === 'source.snapshot') {
            const attribution = payload.attribution as { state?: string } | undefined;
            const run = payload.run as { status?: string; model?: string; reasoning?: string } | undefined;
            label = '配置与归属 · ' + (attribution?.state ?? 'unknown');
            text = 'run: ' + (run?.status ?? 'unknown') + ' · model: ' + (run?.model ?? 'unknown') + ' · reasoning: ' + (run?.reasoning ?? 'unknown');
          } else if (d.event.kind === 'codex') {
            const item = payload.item as Record<string, unknown> | undefined;
            if (item?.type === 'agent_message') { label = 'Agent 回复'; text = String(item.text ?? 'unknown'); }
            else if (item?.type === 'command_execution') {
              label = '工具 · command_execution';
              text = String(item.command ?? 'unknown') + '\n' + String(item.aggregated_output ?? 'unavailable / source-not-provided');
            } else { label = String(payload.type ?? 'Codex 事件'); text = String(payload.message ?? ''); }
          }
        }
        return '<article><strong>' + escape(label) + '</strong><small> · ' + escape(r.observed_at) + ' · cursor ' + r.cursor
          + '</small>' + (text ? '<pre>' + escape(text) + '</pre>' : '')
          + '<details><summary>来源记录与完整性</summary><pre>' + escape(JSON.stringify(d, null, 2)) + '</pre></details></article>';
      }).join('');
      const workflow = detail.workflow.current;
      const workflowPanel = workflow ? '<aside><strong>Workflow · ' + escape(workflow.phase) + '</strong><br>revision '
        + escape(workflow.revision) + ' · applicability ' + escape(workflow.assessment.state)
        + '<br>Acceptance: ' + escape(workflow.acceptance.status) + ' · ' + escape(workflow.acceptance.reason ?? '未提供说明')
        + '<details><summary>Workflow 证据</summary><pre>' + escape(JSON.stringify(workflow, null, 2)) + '</pre></details></aside>'
        : '<aside>Workflow：尚未记录；run completed 不代表验收通过。</aside>';
      const childPanel = detail.child_conversations.length ? '<aside><strong>子 Conversations</strong><ul>'
        + detail.child_conversations.map(child => '<li><a href="/conversations/' + child.conversation_id + '">'
          + escape(child.relation.kind === 'review' ? child.relation.review_id + ' · ' + child.relation.participant : child.relation.acceptance_id)
          + '</a> · isolation ' + escape(child.isolation.state) + '</li>').join('') + '</ul></aside>' : '';
      return send(200, page(detail.ticket.title, '<p>Conversation: ' + escape(detail.ticket.main_conversation_id)
        + '</p><p><a href="/tickets/' + detail.ticket.id + '">刷新历史</a></p><aside class="warning">Recording: '
        + escape(detail.recording.state) + '<br>Changes：unavailable；Workflow 记录不自动执行或验收。<br>'
        + detail.source_gaps.map(escape).join('<br>') + '</aside>' + workflowPanel + childPanel
        + (detail.computer_calls.length ? '<aside>同步调用状态（历史观察，不代表当前进程状态；stdout/stderr 无跨流顺序保证）<pre>'
          + escape(JSON.stringify(detail.computer_calls, null, 2)) + '</pre></aside>' : '')
        + (detail.owned_tasks.length ? '<aside>受管任务：stdout/stderr 的 seq 表示已公开行发布顺序，非两管道实际写入全局顺序；本地 cursor 仅为保存顺序。脚本正文：source-not-provided。历史终态不代表当前进程状态。<pre>'
          + escape(JSON.stringify(detail.owned_tasks, null, 2)) + '</pre></aside>' : '') + records
        + (detail.has_more ? '<a href="?after=' + detail.next_cursor + '">后续记录</a>' : '')), true);
    } catch (e) {
      const code = e instanceof HarnessError ? e.code : 'READ_FAILED';
      return send(code === 'TICKET_NOT_FOUND' || code === 'CONVERSATION_NOT_FOUND' ? 404 : code === 'INVALID_CURSOR' ? 400 : 503, { code });
    }
  });
}
