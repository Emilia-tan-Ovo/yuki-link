import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { BridgeError } from '../errors.js';

const text = z.string().trim().min(1).max(512);
const short = z.string().trim().min(1).max(240);
const source = z.object({ reference: text, digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional() }).strict();
const scope = z.object({ project_key: z.string().min(1).max(80), repository: text.optional(), component: text.optional() }).strict();
const applicability = z.object({ workflow_phases: z.array(text).min(1).max(16).optional(),
  actions: z.array(text).min(1).max(16).optional(), workflow_versions: z.array(text).min(1).max(16).optional() }).strict();
const authority = z.object({ path: z.string().min(1).max(260), heading_path: z.array(text).max(12),
  unit_kind: z.enum(['paragraph', 'list-item']), unit_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict();
const payloads = {
  Rule: z.object({ directive: short, authority: authority }).strict(),
  Decision: z.object({ choice: short, rationale: short }).strict(),
  Incident: z.object({ symptom: short, resolution: short }).strict(),
  Lesson: z.object({ observation: short, recommendation: short }).strict(),
  KnownBug: z.object({ symptom: short, workaround: short }).strict(),
} as const;
export const memoryDraft = z.object({ id: z.string().uuid(), logical_key: text, type: z.enum(['Rule', 'Decision', 'Incident', 'Lesson', 'KnownBug']),
  summary: short, scope, applicability, sources: z.array(source).min(1).max(8), payload: z.record(z.string(), z.unknown()) }).strict();
export type MemoryDraft = z.infer<typeof memoryDraft>;
export type MemoryRecord = MemoryDraft & { lifecycle: 'active' | 'superseded' | 'invalidated';
  created_at: string; supersedes: string | null; superseded_by: string | null; invalidation: null | { reason: string; source: z.infer<typeof source> } };
type Operation = { kind: 'create'; record: MemoryRecord } | { kind: 'supersede'; old_id: string; record: MemoryRecord }
  | { kind: 'invalidate'; id: string; reason: string; source: z.infer<typeof source> };
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), record: memoryDraft.extend({ lifecycle: z.literal('active'), created_at: z.string(),
    supersedes: z.null(), superseded_by: z.null(), invalidation: z.null() }) }).strict(),
  z.object({ kind: z.literal('supersede'), old_id: z.string().uuid(), record: memoryDraft.extend({ lifecycle: z.literal('active'),
    created_at: z.string(), supersedes: z.string().uuid(), superseded_by: z.null(), invalidation: z.null() }) }).strict(),
  z.object({ kind: z.literal('invalidate'), id: z.string().uuid(), reason: short, source }).strict(),
]);
export class MemoryError extends BridgeError { constructor(code: string) { super(code, code); } }
const fail = (code: string): never => { throw new MemoryError(code); };
const equal = isDeepStrictEqual;
const dims = ['workflow_phases', 'actions', 'workflow_versions'] as const;
const overlaps = (a: MemoryRecord, b: MemoryRecord) => a.logical_key === b.logical_key && a.scope.project_key === b.scope.project_key
  && (['repository', 'component'] as const).every(key => !a.scope[key] || !b.scope[key] || a.scope[key] === b.scope[key])
  && dims.every(key => !a.applicability[key] || !b.applicability[key]
    || a.applicability[key]!.some(value => b.applicability[key]!.includes(value)));
const matches = (r: MemoryRecord, q: MemoryQuery) => r.scope.project_key === q.project_key
  && (['repository', 'component'] as const).every(key => !r.scope[key] || r.scope[key] === q[key])
  && dims.every(key => !r.applicability[key] || (!!q[key] && r.applicability[key]!.includes(q[key]!)));
export const memoryQuery = z.object({ project_key: text, repository: text.optional(), component: text.optional(),
  workflow_phases: text.optional(), actions: text.optional(), workflow_versions: text.optional(),
  history: z.boolean().optional() }).strict();
export type MemoryQuery = z.infer<typeof memoryQuery>;

export class EngineeringMemoryStore {
  private records = new Map<string, MemoryRecord>();
  private file: string;
  private failure: string | null = null;
  constructor(runtime: string) {
    const directory = path.join(runtime, 'engineering-memory'); this.file = path.join(directory, 'operations.jsonl');
    try {
      if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) fail('MEMORY_STORE_UNSAFE');
      if (existsSync(this.file)) {
        const stat = lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) fail('MEMORY_STORE_UNSAFE');
        const bytes = readFileSync(this.file, 'utf8');
        if (bytes && !bytes.endsWith('\n')) fail('MEMORY_LOG_INCOMPLETE');
        for (const line of bytes.split('\n').filter(Boolean)) this.apply(operation.parse(JSON.parse(line)), true);
      }
    } catch { this.failure = 'MEMORY_LOG_INVALID_OR_UNAVAILABLE'; }
  }
  private ready() { if (this.failure) fail(this.failure); }
  private apply(op: Operation, replay = false) {
    if (op.kind === 'create' || op.kind === 'supersede') {
      validateDraft(op.record);
      if (this.records.has(op.record.id)) fail('MEMORY_ID_CONFLICT');
      const old = op.kind === 'supersede' ? this.records.get(op.old_id) : null;
      if (op.kind === 'supersede' && (!old || old.lifecycle !== 'active' || op.record.supersedes !== old.id
        || op.record.logical_key !== old.logical_key)) fail('MEMORY_SUPERSEDE_INVALID');
      if ([...this.records.values()].some(r => r.lifecycle === 'active' && r.id !== old?.id && overlaps(r, op.record))) {
        if (!replay) fail('MEMORY_ACTIVE_CONFLICT');
      }
      if (old !== null && old !== undefined) { old.lifecycle = 'superseded'; old.superseded_by = op.record.id; }
      this.records.set(op.record.id, op.record);
    } else {
      const old = this.records.get(op.id);
      if (old && old.lifecycle === 'active') {
        old.lifecycle = 'invalidated'; old.invalidation = { reason: op.reason, source: op.source };
      } else fail('MEMORY_INVALIDATE_INVALID');
    }
  }
  private append(op: Operation) {
    this.ready();
    // Validate against a detached projection before touching durable bytes.
    const before = this.records; this.records = new Map([...before].map(([id, record]) => [id, structuredClone(record)]));
    try { this.apply(op); } catch (error) { this.records = before; throw error; }
    this.records = before;
    try {
      if (!existsSync(path.dirname(this.file))) mkdirSync(path.dirname(this.file));
      appendFileSync(this.file, JSON.stringify(op) + '\n', { encoding: 'utf8', flush: true });
    }
    catch { this.failure = 'MEMORY_WRITE_FAILED'; fail(this.failure); }
    this.apply(op);
  }
  create(draft: MemoryDraft) {
    this.ready(); const existing = this.records.get(draft.id);
    if (existing) { if (existing.lifecycle === 'active' && equal({ id: existing.id, logical_key: existing.logical_key,
      type: existing.type, summary: existing.summary, scope: existing.scope, applicability: existing.applicability,
      sources: existing.sources, payload: existing.payload }, draft)) return structuredClone(existing);
      fail('MEMORY_ID_CONFLICT'); }
    const record = makeRecord(draft);
    this.append({ kind: 'create', record }); return structuredClone(record);
  }
  supersede(oldId: string, draft: MemoryDraft) {
    this.ready(); const record = makeRecord(draft, oldId);
    if (oldId === record.id) fail('MEMORY_SUPERSEDE_CYCLE');
    this.append({ kind: 'supersede', old_id: oldId, record }); return structuredClone(record);
  }
  invalidate(id: string, reason: string, citation: z.infer<typeof source>) {
    this.ready(); let parsed!: { id: string; reason: string; source: z.infer<typeof source> };
    try { parsed = z.object({ id: z.string().uuid(), reason: short, source }).parse({ id, reason, source: citation }); }
    catch { fail('MEMORY_INPUT_INVALID'); }
    this.append({ kind: 'invalidate', ...parsed }); return structuredClone(this.records.get(id));
  }
  query(q: MemoryQuery) {
    this.ready(); let input!: MemoryQuery;
    try { input = memoryQuery.parse(q); } catch { fail('MEMORY_QUERY_INVALID'); }
    const allActive = [...this.records.values()].filter(r => r.lifecycle === 'active');
    const conflicts = [...new Set(allActive.filter(r => r.scope.project_key === input.project_key
      && allActive.some(other => other.id !== r.id && overlaps(r, other)))
      .map(r => r.logical_key))];
    const selected = [...this.records.values()].filter(r => matches(r, input));
    const active = selected.filter(r => r.lifecycle === 'active');
    return { records: structuredClone((input.history ? selected : active.filter(r => !conflicts.includes(r.logical_key)))
      .sort((a, b) => a.logical_key.localeCompare(b.logical_key) || a.id.localeCompare(b.id))), conflicts };
  }
}
function validateDraft(draft: MemoryDraft) {
  try {
    memoryDraft.parse({ id: draft.id, logical_key: draft.logical_key, type: draft.type, summary: draft.summary,
      scope: draft.scope, applicability: draft.applicability, sources: draft.sources, payload: draft.payload });
    payloads[draft.type].parse(draft.payload);
  } catch { fail('MEMORY_INPUT_INVALID'); }
  if (JSON.stringify(draft).length > 4096) fail('MEMORY_RECORD_TOO_LARGE');
}
function makeRecord(draft: MemoryDraft, supersedes: string | null = null): MemoryRecord {
  validateDraft(draft);
  return { ...structuredClone(draft), lifecycle: 'active', created_at: new Date().toISOString(), supersedes,
    superseded_by: null, invalidation: null };
}

export class RuleAuthorityVerifier {
  root: string;
  repositoryId: string | null;
  ticketReference: string | null;
  specReference: string | null;
  specObservations: Map<string, { url?: string; status?: string; digest?: string | null; content?: string; provenance?: string }>;
  constructor(root: string, repositoryId: string | null = null, ticketReference: string | null = null,
    specReference: string | null = null,
    specObservations = new Map<string, { url?: string; status?: string; digest?: string | null; content?: string; provenance?: string }>()) {
    this.root = root; this.repositoryId = repositoryId; this.ticketReference = ticketReference;
    this.specReference = specReference; this.specObservations = specObservations;
  }
  verify(record: MemoryRecord): { status: 'valid' | 'stale'; reason?: string } {
    if (record.type !== 'Rule') return { status: 'valid' };
    try {
      const ref = payloads.Rule.parse(record.payload).authority;
      const githubSpec = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(ref.path);
      if (ref.path !== 'AGENTS.md' && !/^\.workflow\/skills\/[a-z0-9-]+\/SKILL\.md$/.test(ref.path)
        && ref.path !== 'docs/specs/emilia-orchestration-consistency-v0.md' && !githubSpec)
        return { status: 'stale', reason: 'UNTRUSTED_AUTHORITY' };
      if (this.repositoryId && record.scope.repository !== this.repositoryId)
        return { status: 'stale', reason: 'AUTHORITY_SCOPE_EXCEEDED' };
      let content: string;
      if (githubSpec) {
        const observed = this.specObservations.get(ref.path);
        if (ref.path !== this.specReference || observed?.url !== ref.path || observed.status !== 'observed'
          || !observed.provenance || typeof observed.content !== 'string'
          || Buffer.byteLength(observed.content, 'utf8') > 128 * 1024
          || observed.digest !== 'sha256:' + createHash('sha256').update(observed.content).digest('hex'))
          return { status: 'stale', reason: 'UNVERIFIABLE_AUTHORITY' };
        content = observed.content;
      } else {
        const absolute = path.resolve(this.root, ref.path), relative = path.relative(this.root, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return { status: 'stale', reason: 'UNTRUSTED_AUTHORITY' };
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024
          || realpathSync.native(absolute) !== absolute) return { status: 'stale', reason: 'UNVERIFIABLE_AUTHORITY' };
        content = readFileSync(absolute, 'utf8');
      }
      const lines = content.split(/\r?\n/), headings: string[] = [], units: string[] = [];
      let paragraph: string[] = [];
      const flush = () => { if (paragraph.length && equal(headings, ref.heading_path) && ref.unit_kind === 'paragraph') units.push(paragraph.join(' ').trim()); paragraph = []; };
      for (const line of [...lines, '']) {
        const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (heading) { flush(); headings.length = heading[1].length - 1; headings.push(heading[2]); continue; }
        const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
        if (item) { flush(); if (equal(headings, ref.heading_path) && ref.unit_kind === 'list-item') units.push(item[1].trim()); continue; }
        if (!line.trim()) flush(); else paragraph.push(line.trim());
      }
      const hits = units.filter(unit => 'sha256:' + createHash('sha256').update(unit).digest('hex') === ref.unit_sha256);
      if (hits.length !== 1) return { status: 'stale', reason: 'DIRECTIVE_MISSING_AMBIGUOUS_OR_DRIFTED' };
      const directive = payloads.Rule.parse(record.payload).directive;
      if (directive !== hits[0] || record.summary !== hits[0])
        return { status: 'stale', reason: 'DIRECTIVE_SUMMARY_DRIFTED' };
      if (ref.path.includes('/skills/')) {
        const skill = ref.path.split('/')[2];
        const action = ({ 'code-review': 'review', 'review-change': 'review', implement: 'implementation',
          'pair-with-docs': 'discovery', 'to-spec': 'spec', 'to-tickets': 'tickets' } as Record<string, string>)[skill] ?? skill;
        if (!record.applicability.actions?.length || record.applicability.actions.some(value => value !== action))
          return { status: 'stale', reason: 'AUTHORITY_SCOPE_EXCEEDED' };
      }
      if ((ref.path.startsWith('docs/specs/') || githubSpec) && (!record.sources.some(s => s.reference === ref.path)
        || (this.ticketReference && !record.sources.some(s => s.reference === this.ticketReference))))
        return { status: 'stale', reason: 'AUTHORITY_SCOPE_EXCEEDED' };
      return { status: 'valid' };
    } catch { return { status: 'stale', reason: 'UNVERIFIABLE_AUTHORITY' }; }
  }
}
