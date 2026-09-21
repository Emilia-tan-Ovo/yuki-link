import { ArrowUpRight, CircleCheck, FileCode2, Files, FolderOpen, Layers, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import type { ChangeFileDto, TicketDto } from '../src/harness/presentation-model';
import { Advanced, Badge, label, short } from './common';

export function Workbench({ data, openDiff, navigate, control, busy }: { data: TicketDto; openDiff: (file: ChangeFileDto) => void; navigate: (id: string) => void; control: (action: string) => void; busy: boolean }) {
  const w = data.workflow, c = data.changes;
  const phases = ['design', 'implementation', 'review', 'acceptance', 'closeout'];
  return <div className="workbench-content">
    <section className="side-section workflow"><div className="side-title"><h2><Layers size={17} />Workflow</h2><span>{w.revision === null ? '待记录' : 'rev. ' + w.revision}</span></div>
      <ol>{phases.map(phase => <li key={phase} className={w.phase.toLowerCase() === phase ? 'current' : ''}><span className="step-icon">{w.phase.toLowerCase() === phase ? '•' : '·'}</span><span>{phase === 'implementation' ? 'Implement' : phase[0].toUpperCase() + phase.slice(1)}</span>{w.phase.toLowerCase() === phase && <Badge>当前</Badge>}</li>)}</ol>
      <div className="workflow-caption"><CircleCheck size={15} />{w.accepted ? '当前版本已接受' : '尚未确认当前版本被接受'}</div><div className="summary-line"><span>适用性</span><span>{label(w.assessment)}</span></div><div className="summary-line"><span>Acceptance</span><span>{label(w.acceptance)}</span></div>
    </section>
    <section className="side-section changes"><div className="side-title"><h2><Files size={17} />Changes</h2><Badge>{label(c.freshness)}</Badge></div>
      <div className="change-stats">{[[c.files.length, 'files'], [c.commits.length, 'commits'], [c.run_count, 'runs']].map(([count, name]) => <div key={name}><strong>{count}</strong><span>{name}</span></div>)}</div>
      <div className="change-range"><span>固定基线 → 当前工作树</span></div><div className="baseline-range"><code>{short(c.baseline)}</code><span>→</span><code>{short(c.current_head)}</code></div>
      <div className="file-list">{c.files.slice(0, 12).map(f => <button key={f.file_id} className="file-row" title={f.path} onClick={() => openDiff(f)}><FileCode2 size={16} className="file-icon" /><span className="file-name">{f.path.split('/').at(-1)}</span><span>{f.change_kind === 'added' ? 'A' : f.change_kind === 'deleted' ? 'D' : f.change_kind === 'renamed' ? 'R' : 'M'}</span></button>)}</div>
      {c.files.length > 0 ? <button className="browse-changes" onClick={() => openDiff(c.files[0])}>浏览全部变更<ArrowUpRight size={16} /></button> : <p className="side-footnote">{c.state === 'available' ? '当前没有文件净变化。' : '尚无可用的变更来源。'}</p>}
      <p className="side-footnote">完整性：{label(c.completeness)}。Git 净变化不证明修改归属。</p>
      {c.evidence_gaps.length > 0 && <details className="evidence-gaps"><summary>来源与证据缺口 · {c.evidence_gaps.length}</summary>{c.evidence_gaps.map((g, i) => <p key={i}>{g.impact}</p>)}</details>}
    </section>
    <section className="side-section review-summary"><div className="side-title"><h2><ShieldCheck size={17} />Review</h2><Badge>{w.reviews.length} 轮</Badge></div>
      <div className="review-stat"><strong>{w.findings.filter(f => f.status !== 'verified').length}<span>待处理 / 复核</span></strong></div>
      {w.reviews.map(r => <div key={r.id} className="review-card"><strong>{r.mode === 'focused' ? 'Focused Review' : 'Review'} · {r.id}</strong><Badge kind={r.status === 'passed' && r.applicability === 'verified' ? 'success' : ''}>{label(r.status)}</Badge>
        <div className="summary-line"><span>Standards</span><span>{label(r.standards)}</span></div><div className="summary-line"><span>Spec</span><span>{label(r.spec)}</span></div><p className="side-footnote">适用性：{label(r.applicability)}</p></div>)}
      {!w.reviews.length && <p className="side-footnote">还没有已记录的 Review。</p>}
      {data.conversations.filter(c => c.kind !== 'main').map(c => <button key={c.id} className="review-link" onClick={() => navigate(c.id)}>{c.label}<ArrowUpRight size={15} /></button>)}
      {w.findings.map(f => <div key={f.identity} className="finding-row"><span>{f.title}<br /><small>Review · {f.origin_review_id}</small></span><Badge>{label(f.status)}</Badge></div>)}
    </section>
    <section className="side-section"><div className="side-title"><h2>已有运行与控制</h2></div><div className="control-buttons"><button disabled={busy} onClick={() => control('refresh')}><RefreshCw size={15} />刷新状态</button><button disabled={busy} onClick={() => control('worktree/open')}><FolderOpen size={15} />打开 worktree</button></div>
      {data.controls.map(t => <div key={t.kind + t.id} className="control-target"><span>{t.kind === 'run' ? '工程运行' : '受管任务'} <code>{short(t.id)}</code></span><span>{label(t.status)} · {label(t.observation)}</span>{t.manageable && <button disabled={busy} onClick={() => control(`${t.kind === 'run' ? 'runs' : 'tasks'}/${encodeURIComponent(t.id)}/stop`)}><Square size={13} />停止</button>}</div>)}
    </section><Advanced value={data.rawEvidence} title="Ticket facts" />
  </div>;
}
