import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, History } from 'lucide-react';
import type { ConversationLink, ConversationPage, ConversationUsage } from '../src/harness/presentation-model';
import { api } from './api';
import { ConversationRow, AuxiliaryGroupRow, DisclosureProvider } from './renderers';
import { groupConversation, groupIsOpen, setGroupOpen } from './conversation-reading';
import type { ReadingItem } from './conversation-reading';
import { captureAnchor, mergePage, restoreAnchor } from './conversation-state';
import type { ScrollAnchor } from './conversation-state';
import { Badge, label } from './common';
import { createMessageRevealState, selectRevealMessageIds } from './message-reveal';

export function Conversation({ id, initial, relation, refresh, onUsageChange }: { id: string; initial?: ConversationPage; relation: ConversationLink; refresh: number; onUsageChange?: (usage: ConversationUsage) => void }) {
  const [page, setPage] = useState<ConversationPage | null>(initial ?? null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const scroll = useRef<HTMLDivElement>(null), current = useRef(page), anchor = useRef<ScrollAnchor | null>(null);
  const bottom = useRef(true), loading = useRef(false), abort = useRef(new AbortController());
  const messageReveal = useRef(createMessageRevealState(initial ?? null));
  const previousRows = useRef<ReadingItem[]>([]);
  const rows = useMemo(() => groupConversation(page?.items ?? [], previousRows.current), [page]);
  const [openMembers, setOpenMembers] = useState<Set<string>>(() => new Set());
  const [revealIds, setRevealIds] = useState<Set<string>>(() => new Set());
  current.current = page;
  useEffect(() => { if (page) onUsageChange?.(page.usage); }, [page, onUsageChange]);
  async function load(direction: 'before' | 'after') {
    if (loading.current) return;
    loading.current = true; setBusy(true);
    const signal = abort.current.signal;
    try {
      const old = current.current;
      const cursor = direction === 'before' ? old?.page.first_cursor : old?.page.last_cursor ?? old?.page.high_water_cursor;
      const next = await api.conversation(id, cursor === null || cursor === undefined ? '' : `?${direction}=${cursor}`, signal);
      if (signal.aborted) return;
      if (scroll.current) {
        bottom.current = !old || direction === 'after' && scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100;
        if (!bottom.current) anchor.current = captureAnchor(scroll.current);
      }
      const newlyRevealed = selectRevealMessageIds(messageReveal.current, next, direction);
      if (newlyRevealed.length > 0) {
        setRevealIds(ids => new Set([...ids, ...newlyRevealed]));
      }
      setPage(old ? mergePage(old, next, direction) : next); setError('');
    } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : '记录暂不可用'); }
    finally { if (!signal.aborted) { loading.current = false; setBusy(false); } }
  }
  useEffect(() => {
    // This component is keyed by conversation identity; requests never cross conversations.
    abort.current = new AbortController(); loading.current = false;
    void load('after');
    const timer = setInterval(() => { if (!document.hidden) void load('after'); }, 4000);
    return () => { abort.current.abort(); clearInterval(timer); };
  }, [id, refresh]);
  useLayoutEffect(() => {
    previousRows.current = rows;
    if (!scroll.current) return;
    if (anchor.current) { restoreAnchor(scroll.current, anchor.current); anchor.current = null; }
    else if (bottom.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    bottom.current = false;
  }, [page, rows]);
  return <><div ref={scroll} className="conversation-scroll" tabIndex={0} role="region" aria-label="Conversation 历史">
    <div className="reading-column conversation-history">
      {relation.kind !== 'main' && <div className="context-strip"><span>Main 的独立子会话</span><Badge>{label(relation.isolation ?? 'unknown')}</Badge>
        <span>Participant：{relation.participant ?? '未记录'}</span>{relation.review_id && <span>Review：{relation.review_id}</span>}
        {relation.original_review_id && <span>原 Review：{relation.original_review_id}</span>}{relation.finding_refs.length > 0 && <span>Finding：{relation.finding_refs.join('、')}</span>}</div>}
      {page?.page.has_older && <div className="history-loader"><button className="text-button" disabled={busy} onClick={() => void load('before')}><History size={16} />{busy ? '正在读取…' : '加载更早的记录'}</button></div>}
      {error && <div className="notice warning" role="alert">{error}<button className="text-button" onClick={() => void load('after')}>重试</button></div>}
      {!page && !error && <div className="empty-state">正在读取持久化历史…</div>}
      <DisclosureProvider>{rows.map(row => row.kind === 'item' ? <ConversationRow key={row.id} item={row.item} reveal={revealIds.has(row.item.id)} />
        : <AuxiliaryGroupRow key={row.id} group={row} open={groupIsOpen(row, openMembers)} onOpenChange={open => setOpenMembers(ids => setGroupOpen(row, ids, open))} />)}</DisclosureProvider>
      {page && page.items.length === 0 && <div className="empty-state"><History size={28} /><h2>这里还没有协作记录</h2><p>已有运行产生的可观察事实会出现在这里。</p></div>}
      {page && <div className="conversation-end"><span>已加载 {page.items.length} 条记录</span><button className="text-button" disabled={busy} onClick={() => void load('after')}><ArrowDown size={14} />{page.page.has_newer ? '加载后续记录' : '查看最新'}</button></div>}
    </div></div></>;
}
