import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DocumentFact } from './context-contract.ts';

const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const empty = (status: DocumentFact['status'], location: string, observedAt: string | null = null,
  sourceUpdatedAt: string | null = null): DocumentFact => ({ status,
  adapter: 'markdown-context-v0', location, digest: null, observed_at: observedAt, source_updated_at: sourceUpdatedAt,
  fields: {}, context_plan: null,
  declarations: { unknown_side_effects: [], next_action: [] } });
const split = (value: string) => value.split(/[；;]/).map(item => item.trim()).filter(Boolean);
const section = (text: string, heading: string) => {
  const lines = text.split(/\r?\n/), start = lines.findIndex(line => new RegExp(`^#{1,4} +${heading} *$`, 'i').test(line.trim()));
  if (start < 0) return [];
  const level = /^#+/.exec(lines[start]!)![0].length, result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^(#+) /.exec(line);
    if (match && match[1].length <= level) break;
    result.push(line);
  }
  return result;
};
const scalar = (front: string, name: string) => {
  const raw = new RegExp(`^${name}: *(.+)$`, 'm').exec(front)?.[1]?.trim();
  if (!raw || /[\[\]{}&*!|>]/.test(raw)) return null;
  try { return raw.startsWith('"') ? JSON.parse(raw) : raw; } catch { return null; }
};

export class MarkdownContextDocumentAdapter {
  read(root: string, location: string, kind: 'checkpoint' | 'implementation-notes'): DocumentFact {
    const observedAt = new Date().toISOString();
    const absolute = path.resolve(root, location), relative = path.relative(root, absolute);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return empty('malformed', location, observedAt);
    if (!existsSync(absolute)) return empty('missing', location, observedAt);
    try {
      const file = lstatSync(absolute);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 64 * 1024
        || path.relative(root, realpathSync.native(absolute)).startsWith('..' + path.sep)) {
        return empty('malformed', location, observedAt, file.mtime.toISOString());
      }
      const sourceUpdatedAt = file.mtime.toISOString();
      const bytes = readFileSync(absolute), text = bytes.toString('utf8');
      if (kind === 'checkpoint') {
        const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
        if (!front) return { ...empty('malformed', location), digest: digest(bytes), observed_at: observedAt,
          source_updated_at: sourceUpdatedAt };
        const schema = scalar(front, 'schema_version');
        if (schema !== '1') return { ...empty('unsupported-version', location), digest: digest(bytes), observed_at: observedAt,
          source_updated_at: sourceUpdatedAt,
          fields: { schema_version: schema } };
        const fields = Object.fromEntries(['schema_version', 'ticket', 'phase', 'worktree', 'branch', 'fixed_point', 'head']
          .map(name => [name, scalar(front, name)]));
        if (Object.values(fields).some(value => value === null)) return { ...empty('malformed', location), digest: digest(bytes),
          observed_at: observedAt, source_updated_at: sourceUpdatedAt, fields };
        const sideEffects = section(text, 'Side effects').filter(line => /^\s*[-*] /.test(line))
          .map(line => line.replace(/^\s*[-*] +/, '').trim()).filter(line => /\b(unknown|pending|not[- ]verified)\b/i.test(line));
        const nextAction = section(text, 'Next action').filter(line => /^\s*[-*] /.test(line))
          .map(line => line.replace(/^\s*[-*] +/, '').trim()).slice(0, 16);
        return { status: 'observed', adapter: 'markdown-context-v0', location, digest: digest(bytes), observed_at: observedAt,
          source_updated_at: sourceUpdatedAt, fields, context_plan: null,
          declarations: { unknown_side_effects: sideEffects, next_action: nextAction } };
      }
      const plan = section(text, 'Context Plan');
      if (!plan.length) return { ...empty('malformed', location), digest: digest(bytes), observed_at: observedAt,
        source_updated_at: sourceUpdatedAt };
      const field = (label: string) => {
        const line = plan.find(value => new RegExp(`^\\s*[-*] +\\*\\*${label}:\\*\\*`, 'i').test(value));
        return line ? { present: true, values: split(line.replace(new RegExp(`^\\s*[-*] +\\*\\*${label}:\\*\\* *`, 'i'), '')) }
          : { present: false, values: [] as string[] };
      };
      const core = field('Core'), related = field('Related'), retrieval = field('Retrieval'), expansion = field('Expansion triggers');
      if (![core, related, retrieval, expansion].every(value => value.present)) return { ...empty('malformed', location),
        digest: digest(bytes), observed_at: observedAt, source_updated_at: sourceUpdatedAt };
      return { status: 'observed', adapter: 'markdown-context-v0', location, digest: digest(bytes), observed_at: observedAt,
        source_updated_at: sourceUpdatedAt, fields: {}, context_plan: { core: core.values, related: related.values,
          retrieval: retrieval.values, expansion_triggers: expansion.values }, declarations: { unknown_side_effects: [], next_action: [] } };
    } catch { return empty('malformed', location, observedAt); }
  }
}
