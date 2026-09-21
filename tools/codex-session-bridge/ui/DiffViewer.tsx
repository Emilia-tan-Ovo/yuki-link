import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Diff, Hunk, Decoration, parseDiff } from 'react-diff-view';
import { ArrowLeft, ArrowRight, Columns2, FileCode2, Files, GitCommitHorizontal, List, Search, X } from 'lucide-react';
import type { ChangeFileDto, ChangesDto, PatchDto } from '../src/harness/presentation-model';
import { api } from './api';
import { Advanced, Badge, label, short } from './common';

const notices: Record<PatchDto['state'], string> = {
  available: '', binary: '这是二进制文件，不提供文本 diff。', deleted: '文件已删除。本票保留删除状态，不展开已删除正文。',
  protected: '该路径受保护，不读取其内容。', 'too-large': '文件超出安全读取大小，不展开正文。',
  truncated: '完整 patch 超出读取限制，不展示片段代替完整结果。', stale: '文件已经变化。请刷新 Ticket 后重新打开。',
  unavailable: '目前无法安全取得文件变更，请稍后刷新。',
};
export default function DiffViewer({ ticketId, changes, file, select, close, returnFocus, fallbackFocus }: {
  ticketId: string; changes: ChangesDto; file: ChangeFileDto | null; select: (file: ChangeFileDto) => void; close: () => void;
  returnFocus: RefObject<HTMLElement | null>; fallbackFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [view, setView] = useState<'split' | 'unified'>(() => innerWidth < 760 ? 'unified' : 'split');
  const [query, setQuery] = useState(''), [result, setResult] = useState<PatchDto | null>(null), [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const filtered = changes.files.filter(f => f.path.toLowerCase().includes(query.toLowerCase().trim()));
  const index = filtered.findIndex(f => f.file_id === file?.file_id);
  useEffect(() => {
    setResult(null); setError(''); scroll.current?.scrollTo({ top: 0, left: 0 });
    if (!file) { setQuery(''); return; }
    const abort = new AbortController();
    api.patch(ticketId, file.file_id, file.revision, abort.signal).then(value => { if (!abort.signal.aborted) setResult(value); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '读取失败'); });
    return () => abort.abort();
  }, [ticketId, file?.file_id, file?.revision]);
  const parsed = useMemo(() => {
    if (!result?.patch || result.state !== 'available' || result.file_id !== file?.file_id || result.revision !== file.revision) return { files: [], error: '' };
    try { return { files: parseDiff(result.patch, { nearbySequences: 'zip' }), error: '' }; }
    catch { return { files: [], error: '这份 patch 无法解析；受保护的来源证据仍可查看。' }; }
  }, [result, file]);
  const relative = (offset: number) => { const next = filtered[index + offset]; if (next) select(next); };
  return <Dialog.Root open={!!file} onOpenChange={open => !open && close()}><Dialog.Portal><div aria-hidden="true" data-state={file ? 'open' : 'closed'} className="modal-overlay" onClick={close} />
    <Dialog.Content className="diff-dialog" onOpenAutoFocus={e => { e.preventDefault(); search.current?.focus(); }} onCloseAutoFocus={e => {
      e.preventDefault(); const target = returnFocus.current;
      (target?.isConnected && !target.closest('[inert], [data-state="closed"]') && target.getClientRects().length ? target : fallbackFocus.current)?.focus();
    }}>
      <header className="diff-heading"><div className="dialog-heading-icon"><Files size={21} /></div><div className="diff-heading-text"><Dialog.Title>变更阅读器 <Badge>Git diff</Badge></Dialog.Title>
        <Dialog.Description>Ticket 固定基线 → 当前工作树 · {changes.files.length} 个文件</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="关闭变更阅读器"><X size={20} /></Dialog.Close></header>
      <div className="diff-workspace"><aside className="diff-files" aria-label="变更文件目录"><div className="file-search"><Search size={16} /><input ref={search} value={query} onChange={e => setQuery(e.target.value)} placeholder="筛选文件…" aria-label="筛选变更文件" />
        {query && <button className="search-clear" aria-label="清除筛选" onClick={() => setQuery('')}><X size={14} /></button>}</div>
        <div className="diff-file-list" tabIndex={0} role="region" aria-label="变更文件列表">{filtered.map(f => <button key={f.file_id} className="diff-file-button" aria-current={file?.file_id === f.file_id ? 'true' : undefined} onClick={() => select(f)} title={f.path}>
          <FileCode2 size={17} className="file-icon" /><span className="diff-file-name"><strong>{f.path.split('/').at(-1)}</strong><span>{f.path.split('/').slice(0, -1).join('/') || '/'}</span></span><span className="file-status">{{ added: 'A', deleted: 'D', renamed: 'R', copied: 'C' }[f.change_kind] ?? 'M'}</span></button>)}
          {!filtered.length && <div className="file-empty"><Search size={24} /><strong>没有匹配文件</strong><button className="text-button" onClick={() => setQuery('')}>清除筛选</button></div>}</div>
        <p className="diff-sample-note">文件状态来自当前 Git；不代表修改归属。</p></aside>
        <section className="diff-document" aria-label={file?.path ?? '文件变更'}><div className="diff-toolbar"><div className="diff-current"><FileCode2 size={17} /><strong>{file?.path.split('/').at(-1)}</strong></div>
          <div className="segmented" role="group" aria-label="Diff 显示模式"><button aria-pressed={view === 'split'} onClick={() => setView('split')}><Columns2 size={15} />Split</button><button aria-pressed={view === 'unified'} onClick={() => setView('unified')}><List size={15} />Unified</button></div></div>
          <div className="diff-path"><span>{file?.old_path ? file.old_path + ' → ' : ''}{file?.path}</span><Badge>{file?.change_kind}</Badge></div>
          <div className={'diff-column-labels ' + view} aria-hidden="true">{view === 'split' ? <><span>变更前 <code>{short(changes.baseline)}</code></span><span>变更后 · 工作树 <code>{short(changes.current_head)}</code></span></> : <span>统一视图 <code>{short(changes.baseline)} → 工作树</code></span>}</div>
          <div className="diff-scroll" ref={scroll} tabIndex={0} role="region" aria-label={`${file?.path} 的 ${view} diff`}>
            {!result && !error && <div className="empty-state">正在读取文件变更…</div>}
            {(error || parsed.error) && <div className="notice warning" role="alert">{error || parsed.error}</div>}
            {result && result.state !== 'available' && <div className="empty-state"><FileCode2 size={30} /><h2>{label(result.state)}</h2><p>{notices[result.state]}</p></div>}
            {result?.integrity.redacted && <div className="notice">敏感内容已脱敏。</div>}
            {result?.state === 'available' && !parsed.files.some(f => f.hunks.length) && !parsed.error && <div className="empty-state">仅文件身份或模式变化，没有文本行差异。</div>}
            <div className="diff-render" key={file?.file_id + view}>{parsed.files.map((f, i) => <Diff key={i} viewType={view} diffType={f.type} hunks={f.hunks} gutterType="default">
              {hunks => hunks.flatMap((hunk, index) => [<Decoration key={'header' + index}><div className="hunk-header">{hunk.content}</div></Decoration>, <Hunk key={index} hunk={hunk} />])}</Diff>)}</div>
            {result && <Advanced value={result} title="Patch identity & integrity" />}
          </div><footer className="diff-navigation"><span aria-live="polite">{index >= 0 ? `${index + 1} / ${filtered.length} 个文件` : '当前文件不在筛选结果中'}</span><div>
            <button className="icon-button" aria-label="上一个变更文件" disabled={index <= 0} onClick={() => relative(-1)}><ArrowLeft size={17} /></button><button className="icon-button" aria-label="下一个变更文件" disabled={index < 0 || index >= filtered.length - 1} onClick={() => relative(1)}><ArrowRight size={17} /></button></div></footer>
        </section></div><footer className="diff-footer"><span><GitCommitHorizontal size={15} /><code>{short(changes.baseline)} → {short(changes.current_head)}</code></span><span>{label(changes.freshness)} · 只读</span><span className="esc-hint"><kbd>Esc</kbd> 关闭</span></footer>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
