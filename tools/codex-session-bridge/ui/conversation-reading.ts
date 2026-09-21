import type { AuxiliaryMetadata, ConversationItem, ItemIntegrity, ConversationLink } from '../src/harness/presentation-model.ts';

export interface AuxiliaryGroup {
  kind: 'auxiliary-group'; id: string; members: ConversationItem[]; memberIds: string[];
  category: AuxiliaryMetadata['category']; count: number; countKind: 'calls' | 'records';
  status: string; statuses: string[]; issues: string[]; from: string; to: string; integrity: ItemIntegrity;
}
export type ReadingItem = { kind: 'item'; id: string; item: ConversationItem } | AuxiliaryGroup;

function eligible(item: ConversationItem): boolean {
  return item.kind !== 'message' && !!item.auxiliary;
}
function adjacent(a: ConversationItem, b: ConversationItem): boolean {
  const x = a.auxiliary!, y = b.auxiliary!;
  const gap = Date.parse(y.observedAt) - Date.parse(x.observedAt);
  return !!x.scope && x.scope === y.scope && x.source === y.source && x.family === y.family && x.category === y.category
    && a.participant.id === b.participant.id && a.participant.role === b.participant.role
    && !x.issues.length && !y.issues.length
    && b.cursor > a.cursor && Number.isFinite(gap) && gap >= 0;
}
const aggregate = (values: Array<boolean | 'unknown'>): boolean | 'unknown' => values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false;
function summarize(members: ConversationItem[], id: string): AuxiliaryGroup {
  const first = members[0].auxiliary!, last = members.at(-1)!.auxiliary!;
  const calls = ['tool', 'command', 'control'].includes(first.category) && members.every(m => !!m.auxiliary!.operationId);
  return { kind: 'auxiliary-group', id, members, memberIds: members.map(m => m.id), category: first.category,
    countKind: calls ? 'calls' : 'records', count: calls ? new Set(members.map(m => m.auxiliary!.operationId)).size : members.length,
    status: last.status, statuses: [...new Set(members.map(m => m.auxiliary!.status))],
    issues: [...new Set(members.flatMap(m => m.auxiliary!.issues))], from: first.observedAt, to: last.observedAt,
    integrity: { redacted: members.some(m => m.integrity.redacted), truncated: aggregate(members.map(m => m.integrity.truncated)),
      incomplete: aggregate(members.map(m => m.integrity.incomplete)) } };
}
// Derived from merged atomic items only. Previous membership retains the mounted group
// identity across prepends; no cursor, Journal or provider payload interpretation here.
export function groupConversation(items: ConversationItem[], previous: ReadingItem[] = []): ReadingItem[] {
  const prior = new Map<string, string>();
  for (const row of previous) if (row.kind === 'auxiliary-group') for (const id of row.memberIds) prior.set(id, row.id);
  const used = new Set<string>(), rows: ReadingItem[] = [];
  for (let i = 0; i < items.length;) {
    const first = items[i++];
    if (!eligible(first)) { rows.push({ kind: 'item', id: first.id, item: first }); continue; }
    const members = [first];
    while (i < items.length && eligible(items[i]) && adjacent(members.at(-1)!, items[i])) members.push(items[i++]);
    const reused = members.map(m => prior.get(m.id)).find(id => id !== undefined && !used.has(id));
    let id = reused ?? 'auxiliary:' + first.id;
    if (used.has(id)) id = 'auxiliary:' + members.at(-1)!.id;
    used.add(id); rows.push(summarize(members, id));
  }
  return rows;
}
export function groupIsOpen(group: AuxiliaryGroup, openMembers: ReadonlySet<string>): boolean {
  return group.memberIds.some(id => openMembers.has(id));
}
export function setGroupOpen(group: AuxiliaryGroup, openMembers: ReadonlySet<string>, open: boolean): Set<string> {
  const next = new Set(openMembers);
  for (const id of group.memberIds) { if (open) next.add(id); else next.delete(id); }
  return next;
}
export function conversationTabs(links: ConversationLink[]) {
  const counts = { main: 0, review: 0, focused: 0, acceptance: 0 };
  return links.map(link => {
    const n = ++counts[link.kind];
    const name = link.kind === 'main' ? 'Main' : ({ review: 'Review', focused: 'Focused', acceptance: 'Acceptance' }[link.kind] + ' ' + n);
    const relation = [link.label, 'Conversation: ' + link.id, link.participant && 'Participant: ' + link.participant,
      link.review_id && 'Review: ' + link.review_id, link.isolation && 'Isolation: ' + link.isolation,
      link.original_review_id && 'Original Review: ' + link.original_review_id,
      link.finding_refs.length > 0 && 'Findings: ' + link.finding_refs.join(', ')].filter(Boolean).join(' · ');
    return { ...link, name, accessibleName: name + ' · ' + relation };
  });
}
