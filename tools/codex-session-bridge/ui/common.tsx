import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Code2, X } from 'lucide-react';

export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query), update = () => setMatches(media.matches);
    update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
export function Badge({ children, kind = '' }: { children: ReactNode; kind?: string }) { return <span className={'badge ' + kind}>{children}</span>; }
export const short = (value: string | null) => value?.slice(0, 8) ?? '未记录';
const labels: Record<string, string> = {
  unknown: '待确认', unavailable: '暂不可用', current: '当前', complete: '完整', incomplete: '有缺口',
  recording: '正在记录', 'collection-failed': '采集有缺口', 'recording-failed': '记录失败',
  pending: '待处理', passed: '通过', failed: '失败', running: '运行中', completed: '已结束',
  verified: '已核对', mismatch: '不匹配', stale: '已过期', open: '待修复', fixed: '已修复',
  'fixed-unverified': '待复核', requested: '已请求', observed: '已观察', succeeded: '成功',
  'not-yet-observed': '等待结果', 'attribution mismatch': '归属不匹配', matched: '归属匹配',
};
export const label = (value: string) => labels[value] ?? value;
const DisclosureContext = createContext<{ values: ReadonlySet<string>; set: (id: string, open: boolean) => void } | null>(null);
export function DisclosureProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<Set<string>>(() => new Set());
  return <DisclosureContext.Provider value={{ values, set: (id, open) => setValues(old => {
    const next = new Set(old); if (open) next.add(id); else next.delete(id); return next;
  }) }}>{children}</DisclosureContext.Provider>;
}
export function useDisclosure(id?: string) {
  const context = useContext(DisclosureContext), [local, setLocal] = useState(false);
  return { open: context && id ? context.values.has(id) : local,
    onOpenChange: (open: boolean) => { if (context && id) context.set(id, open); else setLocal(open); } };
}
export function Advanced({ value, title = 'Raw evidence & debug', disclosureId }: { value: unknown; title?: string; disclosureId?: string }) {
  const disclosure = useDisclosure(disclosureId);
  return <Collapsible.Root className="advanced" {...disclosure}><Collapsible.Trigger><ChevronRight size={15} className="chevron" /><span>Advanced</span><span className="muted">{title}</span><Code2 size={14} /></Collapsible.Trigger>
    <Collapsible.Content className="collapse-content"><div className="raw-content"><pre tabIndex={0} aria-label="已保护的来源证据">{JSON.stringify(value, null, 2)}</pre></div></Collapsible.Content></Collapsible.Root>;
}
export function SideDrawer({ side, open, close, returnFocus, children }: { side: 'left' | 'right'; open: boolean; close: () => void; returnFocus: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  // Radix Overlay injects a scroll-lock style tag. The shell already owns scrolling;
  // use bundled CSS for the backdrop so strict style-src self stays sufficient.
  return <Dialog.Root open={open} onOpenChange={value => !value && close()}><Dialog.Portal><div aria-hidden="true" data-state={open ? 'open' : 'closed'} className="modal-overlay drawer-overlay" onClick={close} />
    <Dialog.Content className={'side-drawer ' + side} onCloseAutoFocus={e => { e.preventDefault(); returnFocus.current?.focus(); }}>
      <header className="drawer-heading"><Dialog.Title>{side === 'left' ? 'Project / Tickets' : 'Ticket 工作台'}</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭侧栏抽屉"><X size={19} /></Dialog.Close></header>
      <Dialog.Description className="sr-only">项目导航、Workflow、Changes 与 Review</Dialog.Description><div className="drawer-body">{children}</div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
