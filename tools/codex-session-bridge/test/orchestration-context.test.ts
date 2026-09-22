import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { Harness } from '../src/harness/harness.ts';

type Wire = Record<string, any>;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function fixture(runStatus = 'running') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orchestration-context-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, 'subject.txt'), 'base\n', 'utf8');
  git(repo, 'add', 'subject.txt'); git(repo, 'commit', '-m', 'base');
  const fixedPoint = git(repo, 'rev-parse', 'HEAD');
  mkdirSync(path.join(repo, '.local', 'workflow-state'), { recursive: true });
  mkdirSync(path.join(repo, 'docs', 'implementation-notes'), { recursive: true });
  writeFileSync(path.join(repo, '.local', 'workflow-state', 'ORCH-001.md'), `---
schema_version: 1
ticket: "ORCH-001 / GitHub #90"
phase: implementation
worktree: "${repo.replaceAll('\\', '/')}"
branch: "fixture"
fixed_point: "${fixedPoint}"
head: "${fixedPoint}"
---

# Current evidence

- fixture

# Side effects

- external deployment: unknown

# Next action

- Resume implementation.
`, 'utf8');
  writeFileSync(path.join(repo, 'docs', 'implementation-notes', 'ORCH-001.md'), `# ORCH-001 Implementation Notes

## Implementation Decisions

- Keep facts read-only.

### Context Plan

- **Core:** GitHub #90；AGENTS.md
- **Related:** GitHub #89；reason: source spec
- **Retrieval:** search symbols only
- **Expansion triggers:** evidence conflict
`, 'utf8');

  const session = { id: randomUUID(), cwd: repo, codex_thread_id: null, permissions: { sandbox_mode: 'read-only' } };
  const run = { id: randomUUID(), session_id: session.id, created_at: new Date().toISOString(), model: 'fixture',
    reasoning: 'low', status: runStatus, config_source: 'fixture', timeout_ms: null, exit_code: runStatus === 'completed' ? 0 : null };
  let starts = 0;
  const source = { session: () => session, runs: () => [run], events: () => [], attribution: () => ({ state: 'matched' }),
    start: () => { starts++; } };
  const harness = new Harness(path.join(root, 'runtime'), source);
  const registration = harness.register({ project_key: 'YCA', project_name: 'Yuki Computer Agent', ticket_key: 'ORCH-001',
    title: 'Context Packet', reference: 'https://github.invalid/issues/90', expected_worktree: repo, fixed_point: fixedPoint });
  harness.attach({ ticket_id: registration.ticket_id, session_id: session.id, run_id: run.id });
  const server = createHttpServer({ harness });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'context-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  return { root, repo, fixedPoint, harness, client, server, registration, run, source, sideEffects: () => starts, close: async () => {
    await client.close(); server.close(); server.closeAllConnections(); harness.close(); rmSync(root, { recursive: true, force: true });
  } };
}

test('public Context tools preserve evidence integrity and remain read-only', async t => {
  const f = await fixture(); t.after(f.close);
  writeFileSync(path.join(f.repo, 'subject.txt'), 'index version\n', 'utf8'); git(f.repo, 'add', 'subject.txt');
  writeFileSync(path.join(f.repo, 'subject.txt'), 'worktree version\n', 'utf8');
  writeFileSync(path.join(f.repo, 'untracked.txt'), 'untracked\n', 'utf8');
  const beforeJournal = readFileSync(path.join(f.root, 'runtime', 'harness', 'history.jsonl'), 'utf8');
  const beforeCheckpoint = readFileSync(path.join(f.repo, '.local', 'workflow-state', 'ORCH-001.md'), 'utf8');

  const implementation = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'handoff',
  } })).structuredContent as Wire;
  const review = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'review', trigger: 'handoff',
  } })).structuredContent as Wire;
  const resume = (await f.client.callTool({ name: 'prepare_ticket_resume', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'interruption',
  } })).structuredContent as Wire;

  assert.equal(implementation.schema_version, 1);
  assert.equal(implementation.integrity.state, review.integrity.state, 'requested action does not change evidence integrity');
  assert.equal(implementation.subject.identity.scheme, 'yuki-git-subject');
  assert.equal(implementation.subject.identity.version, 1);
  assert.ok(implementation.subject.identity.payload.index.some((entry: Wire) => entry.path === 'subject.txt'));
  assert.ok(implementation.subject.identity.payload.worktree.some((entry: Wire) => entry.path === 'subject.txt'));
  assert.ok(implementation.subject.identity.payload.untracked.some((entry: Wire) => entry.path === 'untracked.txt'));
  assert.notEqual(implementation.subject.identity.payload.index[0].content_id,
    implementation.subject.identity.payload.worktree[0].content_id, 'index content is independent from worktree content');
  assert.equal(implementation.execution.coverage.global, false);
  assert.equal(implementation.execution.active[0].run_id, f.run.id);
  assert.equal(implementation.action_readiness.state, 'blocked');
  assert.ok(implementation.attention.unknown_side_effects.length > 0);
  assert.equal(implementation.retrieval.context_plan.status, 'observed');
  assert.equal(resume.recommendation.kind, 'inspect-active-execution');
  assert.deepEqual(resume.packet.integrity, implementation.integrity);
  assert.equal(readFileSync(path.join(f.root, 'runtime', 'harness', 'history.jsonl'), 'utf8'), beforeJournal);
  assert.equal(readFileSync(path.join(f.repo, '.local', 'workflow-state', 'ORCH-001.md'), 'utf8'), beforeCheckpoint);
  assert.equal(f.sideEffects(), 0);
});

test('unsupported action and incomplete protected identity stay explicit', async t => {
  const f = await fixture(); t.after(f.close);
  mkdirSync(path.join(f.repo, 'secrets')); writeFileSync(path.join(f.repo, 'secrets', 'token.txt'), 'fixture-only\n', 'utf8');
  const packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'future-launch', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.equal(packet.action_readiness.state, 'unsupported');
  assert.equal(packet.subject.identity.completeness, 'incomplete');
  assert.equal(packet.subject.identity.digest, null, 'incomplete identity never claims a comparable digest');
  assert.ok(packet.integrity.unknowns.some((value: Wire) => value.code === 'SUBJECT_IDENTITY_INCOMPLETE'));
});

test('stale and conflicting durable facts are preserved without choosing a winner', async t => {
  const f = await fixture('completed'); t.after(f.close);
  const checkpoint = path.join(f.repo, '.local', 'workflow-state', 'ORCH-001.md');
  const current = readFileSync(checkpoint, 'utf8');
  writeFileSync(checkpoint, current.replace('phase: implementation', 'phase: review'), 'utf8');
  const snapshot = {
    phase: 'implementation', actor: { name: 'Emilia', method: 'deterministic' },
    checkpoint: { artifact_id: 'checkpoint', ticket_key: 'ORCH-001', worktree: f.repo, branch: 'fixture',
      fixed_point: f.fixedPoint, head: f.fixedPoint, phase: 'implementation', schema_version: 1 },
    subject: { subject_id: 'legacy-implementation-subject', fixed_point: f.fixedPoint, head: f.fixedPoint, scope: ['subject.txt'],
      staged: [], unstaged: [], untracked: [], ticket_ref: 'https://github.invalid/issues/90', spec_ref: 'fixture:#89',
      standards: ['AGENTS.md'], tests: ['node --test test/orchestration-context.test.ts'] },
    artifacts: [{ artifact_id: 'checkpoint', role: 'checkpoint', kind: 'file', location: checkpoint,
      revision: sha256(checkpoint), source_schema: 'checkpoint-v1', source: 'engineering-workflow',
      observed_at: new Date().toISOString(), integrity: 'observed' }],
    reviews: [], findings: [],
    acceptance: { acceptance_id: null, status: 'not-recorded', actor: { name: 'Emilia', method: 'deterministic' },
      subject_ref: null, criteria: [], evidence: [], evidence_refs: [], execution_refs: [], applicability: 'not-applicable', reason: 'pending' },
    closeout: { status: 'pending', artifact_refs: [], evidence: [], applicability: 'not-applicable', reason: 'pending' },
    runtime_refs: [],
  };
  const recorded = await f.client.callTool({ name: 'harness_record_workflow', arguments: {
    ticket_id: f.registration.ticket_id, request_id: randomUUID(), expected_revision: null, schema_version: 1, snapshot,
  } });
  assert.equal(recorded.isError, undefined);
  writeFileSync(path.join(f.repo, 'subject.txt'), 'new head\n', 'utf8'); git(f.repo, 'add', 'subject.txt'); git(f.repo, 'commit', '-m', 'new head');
  const packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'acceptance', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.equal(packet.integrity.state, 'conflicted');
  assert.ok(packet.integrity.conflicts.some((value: Wire) => value.code === 'PHASE_CONFLICT'));
  assert.ok(packet.integrity.stale_sources.some((value: Wire) => value.code === 'CHECKPOINT_HEAD_STALE'));
  assert.equal(packet.subject.phase.workflow, 'implementation');
  assert.equal(packet.subject.phase.checkpoint, 'review');
  assert.equal(packet.subject.legacy_workflow_subject.scheme, 'legacy-workflow-subject');
  assert.equal(packet.subject.identity.scheme, 'yuki-git-subject');
});

test('document degradation and budget omissions remain explicit while safety facts survive', async t => {
  const f = await fixture('completed'); t.after(f.close);
  const notes = path.join(f.repo, 'docs', 'implementation-notes', 'ORCH-001.md');
  const many = Array.from({ length: 80 }, (_, index) => `${index}-${'x'.repeat(600)}`).join('；');
  writeFileSync(notes, `# Notes\n\n### Context Plan\n\n- **Core:** ${many}\n- **Related:** source spec\n- **Retrieval:** symbols\n- **Expansion triggers:** conflict\n`, 'utf8');
  let packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.ok(packet.integrity.omissions.some((value: Wire) => value.category === 'context-plan-core'));
  assert.ok(packet.attention.unknown_side_effects.length > 0, 'safety fact survives budget trimming');
  assert.ok(packet.budget.actual_bytes <= packet.budget.max_bytes
    || packet.integrity.omissions.some((value: Wire) => value.category === 'safety-core'));

  writeFileSync(notes, '# Notes without a Context Plan\n', 'utf8');
  packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.equal(packet.retrieval.context_plan.status, 'malformed');
  assert.ok(packet.integrity.unknowns.some((value: Wire) => value.code === 'IMPLEMENTATION_NOTES_MALFORMED'));

  rmSync(notes);
  packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.equal(packet.retrieval.context_plan.status, 'missing');
  assert.ok(packet.retrieval.references.every((value: Wire) => value.status === 'reference-only'));

  const checkpoint = path.join(f.repo, '.local', 'workflow-state', 'ORCH-001.md');
  writeFileSync(checkpoint, readFileSync(checkpoint, 'utf8').replace('schema_version: 1', 'schema_version: 2'), 'utf8');
  packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.ok(packet.sources.some((value: Wire) => value.id === 'checkpoint' && value.state === 'unsupported-version'));
});

test('service reconstruction keeps Context assembly read-only and recoverable', async () => {
  const f = await fixture('completed');
  await f.client.close(); f.server.close(); f.server.closeAllConnections(); f.harness.close();
  const journal = path.join(f.root, 'runtime', 'harness', 'history.jsonl');
  const before = readFileSync(journal, 'utf8');
  const restored = new Harness(path.join(f.root, 'runtime'), f.source);
  const server = createHttpServer({ harness: restored });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'context-restart-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  try {
    const resume = (await client.callTool({ name: 'prepare_ticket_resume', arguments: {
      ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'service-restart',
    } })).structuredContent as Wire;
    assert.equal(resume.kind, 'ticket-resume');
    assert.equal(resume.packet.execution.coverage.global, false);
    assert.equal(readFileSync(journal, 'utf8'), before);
    assert.equal(f.sideEffects(), 0);
  } finally {
    await client.close(); server.close(); server.closeAllConnections(); restored.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
