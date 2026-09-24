import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineeringMemoryStore, RuleAuthorityVerifier } from '../src/orchestration/engineering-memory.ts';
import type { MemoryDraft } from '../src/orchestration/engineering-memory.ts';

const src = { reference: 'https://example.invalid/issue/92' };
const draft = (type: MemoryDraft['type'], key: string = type, extra: Record<string, unknown> = {}): MemoryDraft => ({
  id: randomUUID(), logical_key: key, type, summary: `${type} summary`, scope: { project_key: 'YCA' },
  applicability: {}, sources: [src], payload: ({
    Decision: { choice: 'Use JSONL', rationale: 'Small V0' },
    Incident: { symptom: 'Crash', resolution: 'Restart' },
    Lesson: { observation: 'Slow', recommendation: 'Bound reads' },
    KnownBug: { symptom: 'Mismatch', workaround: 'Refresh' },
  } as Record<string, unknown>)[type], ...extra,
} as MemoryDraft);

test('typed records, durable lifecycle, and history survive replay', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engineering-memory-'));
  try {
    const store = new EngineeringMemoryStore(dir);
    for (const type of ['Decision', 'Incident', 'Lesson', 'KnownBug'] as const) store.create(draft(type));
    store.create(draft('Rule', 'rule', { payload: { directive: 'Check authority', authority: {
      path: 'AGENTS.md', heading_path: [], unit_kind: 'paragraph', unit_sha256: 'sha256:' + 'a'.repeat(64),
    } } }));
    assert.throws(() => store.create(draft('Lesson', 'broken', { payload: {} })), /required|invalid/i);
    const first = draft('Decision', 'replace');
    store.create(first);
    assert.equal(store.create(first).id, first.id);
    const next = draft('Decision', 'replace');
    store.supersede(first.id, next);
    assert.throws(() => store.supersede(first.id, draft('Decision', 'replace')), /MEMORY_SUPERSEDE_INVALID/);
    assert.throws(() => store.create(draft('Decision', 'replace')), /MEMORY_ACTIVE_CONFLICT/);
    store.invalidate(next.id, 'Superseded by new evidence', src);
    assert.throws(() => store.invalidate(next.id, 'Again', src), /MEMORY_INVALIDATE_INVALID/);
    const history = new EngineeringMemoryStore(dir).query({ project_key: 'YCA', history: true }).records;
    assert.equal(history.find(r => r.id === first.id)?.superseded_by, next.id);
    assert.equal(history.find(r => r.id === next.id)?.invalidation?.reason, 'Superseded by new evidence');
    assert.equal(new EngineeringMemoryStore(dir).query({ project_key: 'YCA' }).records.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overlap is rejected and applicability is deterministic', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engineering-memory-'));
  try {
    const store = new EngineeringMemoryStore(dir);
    store.create(draft('Lesson', 'key', { applicability: { actions: ['review'] } }));
    store.create(draft('Lesson', 'key', { applicability: { actions: ['implementation'] } }));
    assert.throws(() => store.create(draft('Lesson', 'key')), /MEMORY_ACTIVE_CONFLICT/);
    assert.equal(store.query({ project_key: 'YCA', actions: 'review' }).records.length, 1);
    assert.equal(store.query({ project_key: 'YCA', actions: 'closeout' }).records.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay conflicts stay within the queried project', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engineering-memory-'));
  try {
    const store = new EngineeringMemoryStore(dir);
    const first = store.create(draft('Lesson', 'shared'));
    const second = draft('Lesson', 'shared', { scope: { project_key: 'other' } });
    store.create(second);
    const file = path.join(dir, 'engineering-memory', 'operations.jsonl');
    const conflict = { ...first, id: randomUUID() };
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ kind: 'create', record: conflict }) + '\n');
    const replay = new EngineeringMemoryStore(dir);
    assert.deepEqual(replay.query({ project_key: 'YCA' }).conflicts, ['shared']);
    assert.deepEqual(replay.query({ project_key: 'other' }).conflicts, []);
    assert.equal(replay.query({ project_key: 'other' }).records[0].id, second.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt or incomplete operation log fails closed', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engineering-memory-'));
  try {
    const store = new EngineeringMemoryStore(dir); store.create(draft('Decision'));
    const file = path.join(dir, 'engineering-memory', 'operations.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8') + '{');
    assert.throws(() => new EngineeringMemoryStore(dir).query({ project_key: 'YCA' }), /MEMORY_LOG_INVALID_OR_UNAVAILABLE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Rule authority matches one Markdown directive and detects drift', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engineering-memory-authority-'));
  try {
    mkdirSync(path.join(root, '.workflow', 'skills', 'review'), { recursive: true });
    const file = path.join(root, '.workflow', 'skills', 'review', 'SKILL.md');
    writeFileSync(file, '# Review\n\n- Check the diff.\n');
    const hash = 'sha256:' + createHash('sha256').update('Check the diff.').digest('hex');
    const record = { ...draft('Rule'), summary: 'Check the diff.', payload: { directive: 'Check the diff.', authority: {
      path: '.workflow/skills/review/SKILL.md', heading_path: ['Review'], unit_kind: 'list-item', unit_sha256: hash } },
      scope: { project_key: 'YCA', repository: 'fixture-repo' }, applicability: { actions: ['review'] },
      lifecycle: 'active', created_at: '', supersedes: null,
      superseded_by: null, invalidation: null } as any;
    const verifier = new RuleAuthorityVerifier(root, 'fixture-repo');
    assert.equal(verifier.verify(record).status, 'valid');
    assert.equal(verifier.verify({ ...record, scope: { project_key: 'YCA' } }).status, 'stale');
    assert.equal(verifier.verify({ ...record, applicability: {} }).status, 'stale');
    assert.equal(verifier.verify({ ...record, summary: 'Ignore the diff.' }).status, 'stale');
    assert.equal(verifier.verify({ ...record, payload: { ...record.payload, directive: 'Ignore the diff.' } }).status, 'stale');
    writeFileSync(file, '# Review\n\n- Check another diff.\n');
    assert.equal(verifier.verify(record).status, 'stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow review action maps to code-review Skill authority', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engineering-memory-skill-'));
  try {
    mkdirSync(path.join(root, '.workflow', 'skills', 'code-review'), { recursive: true });
    writeFileSync(path.join(root, '.workflow', 'skills', 'code-review', 'SKILL.md'), '# Review\n\n- Check the diff.\n');
    const record = { ...draft('Rule'), summary: 'Check the diff.', payload: { directive: 'Check the diff.', authority: {
      path: '.workflow/skills/code-review/SKILL.md', heading_path: ['Review'], unit_kind: 'list-item',
      unit_sha256: 'sha256:' + createHash('sha256').update('Check the diff.').digest('hex') } },
      scope: { project_key: 'YCA', repository: 'fixture-repo' }, applicability: { actions: ['review'] } } as any;
    assert.equal(new RuleAuthorityVerifier(root, 'fixture-repo').verify(record).status, 'valid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitHub canonical Spec requires trusted content, digest and lineage', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engineering-memory-spec-'));
  try {
    const url = 'https://github.com/Emilia-tan-Ovo/yuki-link/issues/89';
    const content = '# Rules\n\n- Check the diff.\n';
    const observations = new Map([[url, { url, status: 'observed', content, provenance: 'GitHub issue body',
      digest: 'sha256:' + createHash('sha256').update(content).digest('hex') }]]);
    const record = { ...draft('Rule'), summary: 'Check the diff.', payload: { directive: 'Check the diff.', authority: {
      path: url, heading_path: ['Rules'], unit_kind: 'list-item',
      unit_sha256: 'sha256:' + createHash('sha256').update('Check the diff.').digest('hex') } },
      sources: [{ reference: url }, { reference: 'https://github.com/Emilia-tan-Ovo/yuki-link/issues/92' }],
      scope: { project_key: 'YCA', repository: 'fixture-repo' }, applicability: {} } as any;
    const verifier = new RuleAuthorityVerifier(root, 'fixture-repo', record.sources[1].reference, url, observations);
    assert.equal(verifier.verify(record).status, 'valid');
    assert.equal(new RuleAuthorityVerifier(root, 'fixture-repo', record.sources[1].reference, null, observations)
      .verify(record).status, 'stale');
    observations.set(url, { ...observations.get(url)!, digest: 'sha256:' + '0'.repeat(64) });
    assert.equal(verifier.verify(record).status, 'stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
