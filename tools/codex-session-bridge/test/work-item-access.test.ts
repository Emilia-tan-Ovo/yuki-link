import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileExecutionAuthority, executeRaw } from '../src/orchestration/execution-authority.ts';
import { workDigest } from '../src/orchestration/work-items.ts';
import { createHash, randomUUID } from 'node:crypto';

test('raw execution requires an exact trusted diagnostic grant and records its use', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'execution-authority-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = { cwd: repo, request_id: 'diagnostic-1', prompt: 'diagnostic', model: 'fixture', reasoning: 'low' };
  const file = path.join(root, 'authority.json');
  writeFileSync(file, JSON.stringify({ schema_version: 1, decisions: [], raw_access: [{ authorization_ref: 'owner:diagnostic',
    category: 'diagnostic', action: 'start', payload_digest: workDigest(payload), reason: 'Owner diagnostic request' }] }));
  const observations: string[] = [];
  const manager: any = { executionAuthority: new FileExecutionAuthority(file, { forbiddenRoots: [repo] }),
    harness: { executionOperations: {
      reserveRaw: () => observations.push('reserved'),
      guardRaw: () => observations.push('dispatched'),
      rawFailure: () => observations.push('failed'),
    } },
    startGuarded: async (_input: any, guard: any) => { guard({}); return { run_id: 'diagnostic-run' }; } };
  await assert.rejects(executeRaw(manager, 'start', payload), { code: 'RAW_EXECUTION_NOT_AUTHORIZED' });
  const receipt = await executeRaw(manager, 'start', { ...payload, authorization_ref: 'owner:diagnostic' });
  assert.equal(receipt.run_id, 'diagnostic-run');
  assert.deepEqual(observations, ['reserved', 'dispatched']);
  await assert.rejects(executeRaw(manager, 'start', { ...payload, prompt: 'different', authorization_ref: 'owner:diagnostic' }),
    { code: 'RAW_EXECUTION_NOT_AUTHORIZED' });
});

test('trusted lifecycle decisions bind revision and exact local evidence; edited evidence is rejected', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'decision-authority-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(repo, 'handoff.md'), 'verified handoff', 'utf8');
  const decision = { decision_ref: 'owner:handoff', work_item_id: randomUUID(), expected_revision: 3,
    workflow_revision: 2, subject_ref: 'subject', content_version: 'sha256:' + 'a'.repeat(64),
    action: 'complete', evidence_refs: ['handoff.md'],
    evidence: [{ path: 'handoff.md', sha256: createHash('sha256').update('verified handoff').digest('hex') }] };
  const file = path.join(root, 'authority.json');
  writeFileSync(file, JSON.stringify({ schema_version: 1, decisions: [decision], raw_access: [] }));
  const authority = new FileExecutionAuthority(file, { forbiddenRoots: [repo] });
  assert.equal(authority.decision('owner:handoff', repo).expected_revision, 3);
  assert.throws(() => authority.decision('caller:invented', repo), { code: 'WORK_ITEM_TRANSITION_NOT_AUTHORIZED' });
  writeFileSync(path.join(repo, 'handoff.md'), 'changed');
  assert.throws(() => authority.decision('owner:handoff', repo), { code: 'WORK_ITEM_EVIDENCE_CONFLICT' });
  const untrusted = path.join(repo, 'authority.json');
  writeFileSync(untrusted, JSON.stringify({ schema_version: 1, decisions: [], raw_access: [] }));
  assert.throws(() => new FileExecutionAuthority(untrusted, { forbiddenRoots: [repo] }),
    { code: 'EXECUTION_AUTHORITY_UNTRUSTED' });
});

test('raw authority changes during guarded dispatch cannot launch execution', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'raw-authority-race-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = { request_id: 'admin-1', cwd: repo, prompt: 'inspect' };
  const file = path.join(root, 'authority.json');
  writeFileSync(file, JSON.stringify({ schema_version: 1, decisions: [], raw_access: [{
    authorization_ref: 'owner:admin', category: 'admin', action: 'start',
    payload_digest: workDigest(payload), reason: 'explicit inspection' }] }));
  const authority = new FileExecutionAuthority(file, { forbiddenRoots: [repo] });
  assert.equal(authority.raw('start', 'owner:admin', payload).category, 'admin');
  let dispatched = 0;
  const manager = { executionAuthority: authority, harness: { executionOperations: {
    reserveRaw() {}, guardRaw() { dispatched++; }, rawFailure() {},
  } }, async startGuarded(_input: unknown, guard: () => void) {
    writeFileSync(file, JSON.stringify({ schema_version: 1, decisions: [], raw_access: [] }));
    guard();
  } };
  await assert.rejects(executeRaw(manager, 'start', { ...payload, authorization_ref: 'owner:admin' }),
    { code: 'RAW_EXECUTION_NOT_AUTHORIZED' });
  assert.equal(dispatched, 0);
});
