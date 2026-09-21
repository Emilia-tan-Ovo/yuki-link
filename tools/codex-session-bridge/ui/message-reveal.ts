import type { ConversationPage } from '../src/harness/presentation-model.ts';

export const MAX_REVEAL_DURATION_MS = 3_200;
export const SHORT_MESSAGE_STEP_MS = 26;

export function revealStepMs(graphemeCount: number): number {
  if (graphemeCount <= 0) return 0;
  return Math.min(SHORT_MESSAGE_STEP_MS, MAX_REVEAL_DURATION_MS / graphemeCount);
}

export interface MessageRevealState {
  baselineCursor: number | null;
  loadedIds: Set<string>;
  consumedIds: Set<string>;
}

export function createMessageRevealState(initial: ConversationPage | null): MessageRevealState {
  return {
    baselineCursor: initial?.page.high_water_cursor ?? null,
    loadedIds: new Set(initial?.items.map(item => item.id) ?? []),
    consumedIds: new Set(),
  };
}

export function selectRevealMessageIds(
  state: MessageRevealState,
  incoming: ConversationPage,
  direction: 'before' | 'after',
): string[] {
  if (state.baselineCursor === null) state.baselineCursor = incoming.page.high_water_cursor;
  const baselineCursor = state.baselineCursor;
  const revealIds = direction === 'after' ? incoming.items
    .filter(item => item.kind === 'message' && item.cursor > baselineCursor
      && !state.loadedIds.has(item.id) && !state.consumedIds.has(item.id))
    .map(item => item.id)
    : [];
  for (const item of incoming.items) state.loadedIds.add(item.id);
  for (const id of revealIds) state.consumedIds.add(id);
  return revealIds;
}

export function graphemes(text: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
  return Array.from(text);
}
