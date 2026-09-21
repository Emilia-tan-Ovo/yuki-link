import type { ReactNode } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight, CircleCheck, Terminal } from 'lucide-react';
import type { ConversationItem } from '../src/harness/presentation-model';
import { Advanced, Badge, label, useDisclosure } from './common';
import type { ExecutionGroup } from './conversation-reading';
export { DisclosureProvider } from './common';

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => part.startsWith('`')
    ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}
// A deliberately small, escaped text renderer: no HTML execution or provider-specific syntax.
function Prose({ text }: { text: string }) {
  return <div className="prose">{text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((block, index) => block.startsWith('```')
    ? <pre key={index} tabIndex={0}><code>{block.slice(block.indexOf('\n') + 1, -3)}</code></pre>
    : block.split(/\n\s*\n/).filter(Boolean).map((p, i) => /^#{1,4} /.test(p)
      ? <h3 key={index + ':' + i}>{inline(p.replace(/^#{1,4} /, ''))}</h3>
      : <p key={index + ':' + i}>{inline(p)}</p>))}</div>;
}
type Of<K extends ConversationItem['kind']> = Extract<ConversationItem, { kind: K }>;
function Message({ item }: { item: Of<'message'> }) {
  return <article className="message"><div className={'avatar role-' + item.participant.role} aria-hidden="true">{item.participant.label.slice(0, 1)}</div><div className="message-body">
    <header className="message-meta"><strong>{item.participant.label}</strong><span>{[item.participant.provider, item.participant.model].filter(Boolean).join(' · ') || '协作消息'}</span><time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
    <Prose text={item.content.text} /></div></article>;
}
function Tool({ item }: { item: Of<'tool'> }) {
  const disclosure = useDisclosure(item.id + ':tool');
  return <Collapsible.Root className="tool" {...disclosure}><Collapsible.Trigger className="tool-trigger"><Terminal size={17} /><strong>{item.content.title}</strong><span className="tool-label">{label(item.content.status)}</span><ChevronRight size={16} className="chevron" /></Collapsible.Trigger>
    <Collapsible.Content className="collapse-content"><div className="tool-content">{item.content.command && <code><span className="prompt">$</span> {item.content.command}</code>}
      <pre tabIndex={0}>{item.content.output ?? '来源未提供可显示的文本输出；结构化证据保留在 Advanced。'}</pre></div></Collapsible.Content></Collapsible.Root>;
}
function Event({ item }: { item: Exclude<ConversationItem, Of<'message'> | Of<'tool'>> }) {
  return <div className="timeline-event"><span className="event-node"><CircleCheck size={14} /></span><div><strong>{item.content.title}</strong>{item.content.text && <p>{item.content.text}</p>}</div>{item.content.status && <span className="event-tail">{label(item.content.status)}</span>}</div>;
}
type Registry = { [K in ConversationItem['kind']]: (item: ConversationItem) => ReactNode };
// Closed, trusted registry; adding a provider does not change the component tree.
const registry: Registry = {
  message: item => item.kind === 'message' && <Message item={item} />,
  tool: item => item.kind === 'tool' && <Tool item={item} />,
  lifecycle: item => item.kind !== 'message' && item.kind !== 'tool' && <Event item={item} />,
  workflow: item => item.kind !== 'message' && item.kind !== 'tool' && <Event item={item} />,
  control: item => item.kind !== 'message' && item.kind !== 'tool' && <Event item={item} />,
  task: item => item.kind !== 'message' && item.kind !== 'tool' && <Event item={item} />,
  unknown: item => item.kind !== 'message' && item.kind !== 'tool' && <Event item={item} />,
};
export function ConversationRow({ item }: { item: ConversationItem }) {
  return <div className={'conversation-item kind-' + item.kind} data-item-id={item.id}>
    {registry[item.kind](item)}
    {(item.integrity.redacted || item.integrity.truncated === true || item.integrity.incomplete === true) && <div className="integrity-note">
      {item.integrity.redacted && <Badge>已脱敏</Badge>}{item.integrity.truncated === true && <Badge>来源截断</Badge>}{item.integrity.incomplete === true && <Badge>内容有缺口</Badge>}
    </div>}
    <Advanced disclosureId={item.id + ':advanced'} value={{ cursor: item.cursor, integrity: item.integrity, sourceRefs: item.sourceRefs, record: item.rawEvidence }} />
  </div>;
}
function ExecutionMember({ item }: { item: ConversationItem }) {
  const disclosure = useDisclosure(item.id + ':record');
  return <Collapsible.Root className="execution-member" data-item-id={item.id} {...disclosure}>
    <Collapsible.Trigger className="execution-member-trigger"><ChevronRight size={14} className="chevron" />
      <span>{item.kind === 'message' ? '消息' : item.content.title}</span><span>{label(item.execution?.status ?? 'unknown')}</span><time>{item.timestamp}</time></Collapsible.Trigger>
    <Collapsible.Content><ConversationRow item={item} /></Collapsible.Content>
  </Collapsible.Root>;
}
export function ExecutionGroupRow({ group, open, onOpenChange }: { group: ExecutionGroup; open: boolean; onOpenChange: (open: boolean) => void }) {
  const category = { command: '命令', tool: '工具', observation: '状态观察', output: '任务输出' }[group.category];
  const time = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '时间待确认';
  return <Collapsible.Root className="execution-group" data-anchor-group-id={group.id} data-item-id={group.memberIds[0]} data-member-ids={JSON.stringify(group.memberIds)} open={open} onOpenChange={onOpenChange}>
    <Collapsible.Trigger className="execution-group-trigger"><Terminal size={16} /><strong>{category} · {group.countKind === 'calls' ? '调用' : '执行记录'} × {group.count}</strong>
      <span>{label(group.status)}</span><ChevronRight size={16} className="chevron" /></Collapsible.Trigger>
    <div className="execution-summary"><span>{group.members[0].participant.label}</span><time title={group.from + ' → ' + group.to}>{time(group.from)}–{time(group.to)}</time><span>当前已加载 {group.members.length} 条</span>
      {group.issues.map(issue => <Badge key={issue} kind="warning">{label(issue)}</Badge>)}
      {group.integrity.redacted && <Badge>已脱敏</Badge>}{group.integrity.truncated === true && <Badge>来源截断</Badge>}{group.integrity.incomplete === true && <Badge>内容有缺口</Badge>}
      {(group.integrity.truncated === 'unknown' || group.integrity.incomplete === 'unknown') && <span>完整性待确认</span>}
    </div><Collapsible.Content className="execution-members">{group.members.map(item => <ExecutionMember key={item.id} item={item} />)}</Collapsible.Content>
  </Collapsible.Root>;
}
