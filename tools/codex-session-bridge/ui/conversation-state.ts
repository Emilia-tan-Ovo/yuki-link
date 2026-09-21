import type { ConversationPage } from '../src/harness/presentation-model.ts';

export function mergePage(current: ConversationPage, next: ConversationPage, direction: 'before' | 'after'): ConversationPage {
  if (current.id !== next.id) return current;
  const items = [...new Map([...current.items, ...next.items].map(item => [item.id, item])).values()].sort((a, b) => a.cursor - b.cursor);
  return { ...current, items, page: { first_cursor: items[0]?.cursor ?? null, last_cursor: items.at(-1)?.cursor ?? null,
    high_water_cursor: Math.max(current.page.high_water_cursor, next.page.high_water_cursor),
    has_older: direction === 'before' ? next.page.has_older : current.page.has_older,
    has_newer: direction === 'after' ? next.page.has_newer : current.page.has_newer } };
}
export interface ScrollAnchor { id: string; offset: number }
export function captureAnchor(container: HTMLElement): ScrollAnchor | null {
  const top = container.getBoundingClientRect().top;
  const nodes = [...container.querySelectorAll<HTMLElement>('[data-item-id]')];
  const first = nodes.find(node => node.getBoundingClientRect().bottom > top);
  const node = first?.dataset.memberIds && first.getBoundingClientRect().top < top
    ? nodes.find(node => !node.dataset.memberIds && first.contains(node) && node.getBoundingClientRect().bottom > top) ?? first : first;
  return node ? { id: node.dataset.itemId!, offset: node.getBoundingClientRect().top - top } : null;
}
export function restoreAnchor(container: HTMLElement, anchor: ScrollAnchor) {
  const nodes = [...container.querySelectorAll<HTMLElement>('[data-item-id]')];
  const node = nodes.find(node => !node.dataset.memberIds && node.dataset.itemId === anchor.id)
    ?? nodes.find(node => node.dataset.itemId === anchor.id || (node.dataset.memberIds && (JSON.parse(node.dataset.memberIds) as string[]).includes(anchor.id)));
  if (node) container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
}
