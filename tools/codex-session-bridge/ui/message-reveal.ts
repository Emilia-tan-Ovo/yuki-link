import type { ConversationPage } from '../src/harness/presentation-model.ts';

export const MAX_REVEAL_DURATION_MS = 3_200;
export const SHORT_MESSAGE_STEP_MS = 26;

export function revealStepMs(graphemeCount: number): number {
  if (graphemeCount <= 0) return 0;
  return Math.min(SHORT_MESSAGE_STEP_MS, MAX_REVEAL_DURATION_MS / graphemeCount);
}

export function selectRevealMessageIds(
  current: ConversationPage | null,
  incoming: ConversationPage,
  direction: 'before' | 'after',
  consumed: ReadonlySet<string>,
): string[] {
  if (!current || direction !== 'after') return [];
  const baseline = current.page.high_water_cursor;
  return incoming.items
    .filter(item => item.kind === 'message' && item.cursor > baseline && !consumed.has(item.id))
    .map(item => item.id);
}

export function graphemes(text: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
  return Array.from(text);
}
