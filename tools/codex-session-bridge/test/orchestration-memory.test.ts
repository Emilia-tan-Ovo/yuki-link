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
    const record = { ...draft('Rule'), payload: { directive: 'Check the diff', authority: {
      path: '.workflow/skills/review/SKILL.md', heading_path: ['Review'], unit_kind: 'list-item', unit_sha256: hash } },
      scope: { project_key: 'YCA', repository: 'fixture-repo' }, applicability: { actions: ['review'] },
      lifecycle: 'active', created_at: '', supersedes: null,
      superseded_by: null, invalidation: null } as any;
    const verifier = new RuleAuthorityVerifier(root, 'fixture-repo');
    assert.equal(verifier.verify(record).status, 'valid');
    assert.equal(verifier.verify({ ...record, scope: { project_key: 'YCA' } }).status, 'stale');
    assert.equal(verifier.verify({ ...record, applicability: {} }).status, 'stale');
    writeFileSync(file, '# Review\n\n- Check another diff.\n');
    assert.equal(verifier.verify(record).status, 'stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
