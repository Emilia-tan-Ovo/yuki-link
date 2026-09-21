import { useEffect, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowRight, ArrowUpRight, ChevronRight, CircleCheck, Folder, FolderOpen, LayoutDashboard, LockKeyhole, MessageSquare, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw, Sparkles } from 'lucide-react';
import type { ChangeFileDto, OverviewDto, SessionDto, TicketDto, TicketSummary } from '../src/harness/presentation-model';
import { api } from './api';
import { Badge, label, short, SideDrawer, useMedia } from './common';
import { Conversation } from './Conversation';
import { Workbench } from './Workbench';
import DiffViewer from './DiffViewer';

function TicketCard({ ticket, select, active }: { ticket: TicketSummary; select: () => void; active?: boolean }) {
  return <button className={'ticket-link' + (ticket.attention ? ' needs-attention' : '')} aria-current={active ? 'page' : undefined} onClick={select}>
    <span className="ticket-link-top"><CircleCheck size={15} /><strong>{ticket.key}</strong></span><span className="ticket-link-title">{ticket.title}</span>
    <span className="ticket-link-status">{ticket.accepted ? '已接受' : label(ticket.phase)} · {ticket.file_count} files{ticket.findings > 0 ? ` · ${ticket.findings} 待处理` : ''}</span>
    {ticket.attention && <span className="attention-label">有待确认的证据或状态</span>}</button>;
}
function Navigation({ overview, selected, navigate }: { overview: OverviewDto | null; selected?: string; navigate: (url: string) => void }) {
  const [filter, setFilter] = useState('all');
  return <div className="project-navigation"><div className="rail-label">WORKSPACE<span>{String(overview?.projects.length ?? 0).padStart(2, '0')}</span></div>
    <button className="overview-button" onClick={() => navigate('/')}><LayoutDashboard size={17} />项目概览<ArrowUpRight size={14} /></button>
    <div className="ticket-filters" role="group" aria-label="筛选 Ticket">{[['all', '全部'], ['active', '进行中'], ['accepted', '已接受']].map(([value, name]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{name}</button>)}</div>
    {overview?.projects.map(project => <Collapsible.Root key={project.id} defaultOpen className="project-tree"><Collapsible.Trigger className="tree-trigger project-root"><ChevronRight size={14} className="chevron" /><span className="project-symbol">{project.name[0]}</span><strong>{project.name}</strong><span className="tree-count">{project.tickets.length}</span></Collapsible.Trigger>
      <Collapsible.Content className="collapse-content"><div className="tree-branch">{project.tickets.filter(t => filter === 'all' || (filter === 'accepted' ? t.accepted : !t.accepted)).map(t => <TicketCard key={t.id} ticket={t} active={selected === t.id} select={() => navigate('/tickets/' + t.id)} />)}</div></Collapsible.Content></Collapsible.Root>)}
    <div className="nav-bottom"><span className="workspace-icon"><Folder size={18} /></span><div><strong>本地工程空间</strong><span>{overview?.projects.length ?? 0} 个项目 · 真实协作历史</span></div><LockKeyhole size={14} /></div></div>;
}
function Overview({ data, navigate }: { data: OverviewDto | null; navigate: (url: string) => void }) {
  return <div className="conversation-scroll"><div className="reading-column overview-page"><span className="eyebrow">YOUR ENGINEERING WORKSPACE</span><h1>工程协作，一处回看。</h1><p className="overview-intro">从项目进入 Ticket，阅读协作过程、查看变更与独立复核。</p>
    {data?.projects.map(project => <section className="overview-project" key={project.id}><h2><FolderOpen size={21} />{project.name}<Badge>{project.tickets.length} Tickets</Badge></h2><div className="overview-tickets">{project.tickets.map(t => <TicketCard key={t.id} ticket={t} select={() => navigate('/tickets/' + t.id)} />)}</div></section>)}
    {data?.projects.length === 0 && <div className="empty-state"><FolderOpen size={34} /><h2>还没有登记项目</h2><p>通过现有协作入口登记 Project / Ticket 后，历史会显示在这里。</p></div>}
  </div></div>;
}
export default function App() {
  const [session, setSession] = useState<SessionDto | null>(null), [overview, setOverview] = useState<OverviewDto | null>(null);
  const [route, setRoute] = useState(location.pathname), [data, setData] = useState<TicketDto | null>(null), [conversationId, setConversationId] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [leftOpen, setLeftOpen] = useState(true), [rightOpen, setRightOpen] = useState(true), [drawer, setDrawer] = useState<'left' | 'right' | null>(null), [file, setFile] = useState<ChangeFileDto | null>(null);
  const narrowNav = useMedia('(max-width: 1199px)'), narrowWorkbench = useMedia('(max-width: 899px)');
  const leftVisible = !narrowNav && leftOpen, rightVisible = !!data && !narrowWorkbench && rightOpen;
  const leftToggle = useRef<HTMLButtonElement>(null), rightToggle = useRef<HTMLButtonElement>(null), diffReturn = useRef<HTMLElement | null>(null);
  const activeRoute = useRef(route); activeRoute.current = route;
  useEffect(() => { const pop = () => setRoute(location.pathname); addEventListener('popstate', pop); return () => removeEventListener('popstate', pop); }, []);
  useEffect(() => { setDrawer(null); }, [narrowNav, narrowWorkbench]);
  useEffect(() => {
    let alive = true;
    api.session().then(s => { if (alive) setSession(s); }).catch(e => { if (alive) { setError(String(e.message)); setLoading(false); } });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!session) return;
    const abort = new AbortController();
    setLoading(true); setError(''); setNotice(''); setFile(null);
    async function load() {
      const overview = await api.overview(abort.signal);
      if (abort.signal.aborted) return;
      setOverview(overview);
      if (route === '/') { setData(null); setConversationId(''); return; }
      const parts = route.split('/');
      const conversation = parts[1] === 'conversations' ? await api.conversation(parts[2], '', abort.signal) : null;
      const ticket = await api.ticket(conversation?.ticket_id ?? parts[2], abort.signal);
      if (abort.signal.aborted) return;
      setData(ticket); setConversationId(conversation?.id ?? ticket.ticket.main_conversation_id);
    }
    load().catch(e => { if (!abort.signal.aborted) { setData(null); setError(String(e.message)); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [route, session]);
  function navigate(url: string) { if (url !== route) { history.pushState(null, '', url); setRoute(url); } setDrawer(null); }
  function selectConversation(id: string) { navigate(id === data?.ticket.main_conversation_id ? '/tickets/' + data.ticket.id : '/conversations/' + id); }
  function openDiff(next: ChangeFileDto) { diffReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setFile(next); }
  async function control(action: string) {
    if (!data || !session || busy) return;
    const expectedRoute = route; setBusy(true); setNotice('');
    try {
      const result = await api.control(data.ticket.id, action, session.csrf);
      const [next, overview] = await Promise.all([api.ticket(data.ticket.id), api.overview()]);
      if (activeRoute.current !== expectedRoute) return;
      setData(next); setOverview(overview); setFile(null); setRefresh(v => v + 1);
      setNotice(action === 'refresh' ? '当前工程事实已刷新。' : '控制结果：' + label(result.outcome));
    } catch (e) { if (activeRoute.current === expectedRoute) setNotice('操作未完成：' + (e instanceof Error ? e.message : 'unknown')); }
    finally { setBusy(false); }
  }
  const nav = <Navigation overview={overview} selected={data?.ticket.id} navigate={navigate} />;
  const workbench = data ? <Workbench data={data} openDiff={openDiff} navigate={selectConversation} control={a => void control(a)} busy={busy} /> : null;
  const relation = data?.conversations.find(c => c.id === conversationId);
  const recording = data?.recording ?? overview?.recording;
  return <><a className="skip-link" href="#conversation">跳到 Conversation</a><div className="app-shell">
    <header className="topbar"><div className="topbar-brand"><button className="brand" onClick={() => navigate('/')} aria-label="Yuki Harness 项目概览"><span className="brand-mark"><Sparkles size={19} strokeWidth={1.6} /></span><strong>yuki</strong><span>harness</span></button></div>
      <div className="breadcrumb"><Folder size={15} /><span>Workspace</span>{data && <><ChevronRight size={13} /><strong>{data.ticket.key}</strong></>}</div><div className="topbar-end"><span className="local-label"><span className="local-dot" />Local workspace</span><Badge>只读工作台</Badge></div></header>
    <div className={`workspace-grid ${leftVisible ? '' : 'left-collapsed'} ${rightVisible ? '' : 'right-collapsed'}`}>
      <aside className="nav-rail" id="project-navigation" aria-label="项目导航" inert={!leftVisible}><div className="rail-heading"><span>项目</span><button className="icon-button" aria-label="收起项目目录" onClick={() => { setLeftOpen(false); leftToggle.current?.focus(); }}><PanelLeftClose size={17} /></button></div>{nav}</aside>
      <main className="main-pane" id="conversation" tabIndex={-1}><div className="pane-toolbar"><button ref={leftToggle} className="icon-button" aria-label={leftVisible ? '收起项目目录' : '展开项目目录'} aria-expanded={leftVisible || drawer === 'left'} onClick={() => narrowNav ? setDrawer('left') : setLeftOpen(!leftOpen)}>{leftVisible ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}</button><span><MessageSquare size={15} />{data ? 'Conversation' : '项目概览'}</span>
        <div className="pane-toolbar-end">{data && <button className="icon-button" title="刷新当前工程事实" aria-label="刷新当前工程事实" disabled={busy} onClick={() => void control('refresh')}><RefreshCw size={16} /></button>}<span className="read-only"><LockKeyhole size={13} />只读</span><button ref={rightToggle} className="icon-button" disabled={!data} aria-label={rightVisible ? '收起工作台' : '展开工作台'} aria-expanded={rightVisible || drawer === 'right'} onClick={() => narrowWorkbench ? setDrawer('right') : setRightOpen(!rightOpen)}>{rightVisible ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button></div></div>
        {notice && <div className="notice" role="status">{notice}</div>}
        {loading ? <div className="empty-state"><Sparkles size={28} /><p>正在读取工程事实…</p></div> : error ? <div className="empty-state" role="alert"><h2>暂时无法打开工作台</h2><p>{error}</p><button className="text-button" onClick={() => location.reload()}>重新载入<ArrowRight size={16} /></button></div>
          : data && relation && session ? <><header className="ticket-heading live-ticket-heading"><div className="ticket-overline"><span>{data.ticket.key}</span><span className="overline-divider" /><span>工程协作历史</span></div><h1>{data.ticket.title}</h1><div className="ticket-meta"><Badge kind={data.workflow.accepted ? 'success' : ''}>{data.workflow.accepted ? '当前已接受' : label(data.workflow.phase)}</Badge><span>基线 <code>{short(data.changes.baseline)}</code></span></div></header>
            <Tabs.Root value={conversationId} onValueChange={selectConversation} className="conversation-tabs"><Tabs.List className="tabs" aria-label="关联 Conversation">{data.conversations.map(c => <Tabs.Trigger key={c.id} value={c.id}><MessageSquare size={14} />{c.label}</Tabs.Trigger>)}</Tabs.List></Tabs.Root>
            <Conversation key={conversationId} id={conversationId} initial={conversationId === data.ticket.main_conversation_id ? data.conversation : undefined} relation={relation} composer={session.composer} refresh={refresh} /></>
            : <Overview data={overview} navigate={navigate} />}
      </main><aside className="workbench-rail" id="ticket-workbench" aria-label="辅助工作台" inert={!rightVisible}><div className="rail-heading"><span>工作台</span><span className="rail-ticket">{data?.ticket.key}</span></div><div className="workbench-scroll" tabIndex={0} role="region" aria-label="Workflow、变更和 Review 摘要">{workbench}</div></aside>
    </div><footer className="statusbar"><span><span className={recording?.state === 'recording' ? 'local-dot' : 'warning-dot'} />{label(recording?.state ?? 'unknown')}</span><span className="status-center">{recording?.observed_at ? '最近采集 ' + new Date(recording.observed_at).toLocaleTimeString() : '尚未观察来源'}</span><span>{session?.services_url ? <a href={session.services_url} rel="noreferrer">日常服务管理<ArrowUpRight size={12} /></a> : '日常服务管理：暂不可用'}</span></footer>
  </div><SideDrawer side="left" open={drawer === 'left'} close={() => setDrawer(null)} returnFocus={leftToggle}>{nav}</SideDrawer><SideDrawer side="right" open={drawer === 'right'} close={() => setDrawer(null)} returnFocus={rightToggle}>{workbench}</SideDrawer>
  {data && <DiffViewer ticketId={data.ticket.id} changes={data.changes} file={file} select={setFile} close={() => setFile(null)} returnFocus={diffReturn} fallbackFocus={rightToggle} />}</>;
}
