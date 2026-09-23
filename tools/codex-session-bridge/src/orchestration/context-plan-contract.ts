export const CONTEXT_PLAN_LABELS = ['Core', 'Related', 'Retrieval', 'Expansion triggers'] as const;

export const CONTEXT_PLAN_TEMPLATE = `### Context Plan\n\n${CONTEXT_PLAN_LABELS.map(label => `- **${label}:** <${label.toLowerCase()} references>`).join('\n')}\n`;

export function parseContextPlan(lines: string[]) {
  const parsed = new Map<string, string[]>();
  for (const line of lines.filter(value => value.trim())) {
    const match = /^- \*\*([^*:]+):\*\* +(.+)$/.exec(line.trim());
    if (!match || !CONTEXT_PLAN_LABELS.includes(match[1] as typeof CONTEXT_PLAN_LABELS[number])
      || parsed.has(match[1])) return null;
    const values = match[2].split(/[；;]/).map(value => value.trim()).filter(Boolean);
    if (!values.length) return null;
    parsed.set(match[1], values);
  }
  if (parsed.size !== CONTEXT_PLAN_LABELS.length) return null;
  return { core: parsed.get('Core')!, related: parsed.get('Related')!, retrieval: parsed.get('Retrieval')!,
    expansion_triggers: parsed.get('Expansion triggers')! };
}
