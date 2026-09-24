import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { ChangesSource } from '../src/harness/changes-source.ts';
import { Harness } from '../src/harness/harness.ts';
import { MarkdownContextDocumentAdapter } from '../src/orchestration/document-adapter.ts';
import { HarnessContextFactsSource } from '../src/orchestration/harness-context-source.ts';
import { ContextAssembler } from '../src/orchestration/context-assembler.ts';

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
  const run = { id: randomUUID(), session_id: session.id, created_at: '2000-01-01T00:00:00.000Z', model: 'fixture',
    reasoning: 'low', status: runStatus, config_source: 'fixture', timeout_ms: null, exit_code: runStatus === 'completed' ? 0 : null };
  let starts = 0;
  const source = { session: () => session, runs: () => [run], events: () => [], attribution: () => ({ state: 'matched' }),
    start: () => { starts++; } };
  const harness = new Harness(path.join(root, 'runtime'), source);
  const registration = harness.register({ project_key: 'YCA', project_name: 'Yuki Computer Agent', ticket_key: 'ORCH-001',
    title: 'Context Packet', reference: 'https://github.invalid/issues/90', expected_worktree: repo, fixed_point: fixedPoint });
  harness.attach({ ticket_id: registration.ticket_id, session_id: session.id, run_id: run.id });
  const canonicalSpecObservations = new Map<string, any>();
  let targetPackages: string[] | undefined = [];
  const manager = { harness, store: { directory: path.join(root, 'runtime') }, canonicalSpecObservations, implementationLaunchAuthority: {
    snapshot: () => ({ policy: { preflight: { dependency_packages: targetPackages } },
      source: { reference: 'fixture-authority' } }),
  } };
  const server = createHttpServer(manager);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'context-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  return { root, repo, fixedPoint, harness, client, server, registration, run, source,
    canonicalSpecObservations, setTargetPackages(value: string[] | undefined) { targetPackages = value; },
    sideEffects: () => starts, close: async () => {
    await client.close(); server.close(); server.closeAllConnections(); harness.close(); rmSync(root, { recursive: true, force: true });
  } };
}

test('public Memory write and Context retrieval keep diagnostics local', async t => {
  const f = await fixture(); t.after(f.close);
  const context = async () => (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  const before = await context();
  assert.equal(existsSync(path.join(f.root, 'runtime', 'engineering-memory')), false,
    'Context assembly never creates an empty Memory store');
  const record = { id: randomUUID(), logical_key: 'lesson-context', type: 'Lesson', summary: 'Keep facts bounded',
    scope: { project_key: 'YCA' }, applicability: { actions: ['implementation'] },
    sources: [{ reference: 'https://example.invalid/issue/92' }],
    payload: { observation: 'Long context', recommendation: 'Use short records' } };
  const written = await f.client.callTool({ name: 'engineering_memory_create', arguments: { record } });
  assert.equal(written.isError, undefined);
  const after = await context();
  assert.equal(after.retrieval.engineering_memory.items[0].id, record.id);
  assert.equal(after.integrity.state, before.integrity.state);
  assert.equal(after.action_readiness.state, before.action_readiness.state);
  const invalidated = await f.client.callTool({ name: 'engineering_memory_invalidate', arguments: {
    id: record.id, reason: 'Obsolete', source: { reference: 'https://example.invalid/issue/93' },
  } });
  assert.equal(invalidated.isError, undefined);
  assert.equal((await context()).retrieval.engineering_memory.items.length, 0);
  const history = (await f.client.callTool({ name: 'engineering_memory_query', arguments: {
    project_key: 'YCA', actions: 'implementation', history: true,
  } })).structuredContent as Wire;
  assert.equal(history.records[0].lifecycle, 'invalidated');
});

test('public Context tools preserve evidence integrity and remain read-only', async t => {
  const f = await fixture(); t.after(f.close);
  f.harness.checkedAt = '2000-01-01T00:00:00.000Z';
  utimesSync(path.join(f.repo, '.local', 'workflow-state', 'ORCH-001.md'), new Date(0), new Date(0));
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
  assert.equal(implementation.execution.environment.preflight.status, 'observed');
  assert.ok(implementation.execution.environment.preflight.capabilities.observed_at);
  assert.equal(implementation.execution.model_usage.state, 'unavailable');
  assert.equal(implementation.budget.reference_count, implementation.retrieval.references.length);
  assert.equal(implementation.budget.duplicate_reference_count, 0);
  assert.equal(implementation.execution.active[0].run_id, f.run.id);
  assert.notEqual(implementation.execution.active[0].observed_at, f.run.created_at);
  assert.equal(implementation.execution.active[0].created_at, f.run.created_at);
  const runtimeSource = implementation.sources.find((value: Wire) => value.id === 'runtime');
  const checkpointSource = implementation.sources.find((value: Wire) => value.id === 'checkpoint');
  assert.ok(runtimeSource.observed_at);
  assert.equal(runtimeSource.source_updated_at, '2000-01-01T00:00:00.000Z');
  assert.equal(checkpointSource.source_updated_at, '1970-01-01T00:00:00.000Z');
  assert.equal(implementation.action_readiness.state, 'blocked');
  assert.ok(implementation.attention.unknown_side_effects.length > 0);
  assert.equal(implementation.retrieval.context_plan.status, 'observed');
  assert.equal(resume.recommendation.kind, 'inspect-active-execution');
  assert.deepEqual(resume.packet.integrity, implementation.integrity);
  assert.equal(readFileSync(path.join(f.root, 'runtime', 'harness', 'history.jsonl'), 'utf8'), beforeJournal);
  assert.equal(readFileSync(path.join(f.repo, '.local', 'workflow-state', 'ORCH-001.md'), 'utf8'), beforeCheckpoint);
  assert.equal(f.sideEffects(), 0);
});

test('current subject identity distinguishes index renames and rejects hidden index state', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'orchestration-identity-'));
  try {
    git(repo, 'init'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture');
    writeFileSync(path.join(repo, 'a.txt'), 'same\n', 'utf8');
    writeFileSync(path.join(repo, 'b.txt'), 'same\n', 'utf8');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
    const source = new ChangesSource(), baseline = source.capture(repo, 'HEAD');

    git(repo, 'mv', 'a.txt', 'dest.txt');
    const first = source.currentIdentity(baseline);
    git(repo, 'reset', '--hard', 'HEAD');
    git(repo, 'mv', 'b.txt', 'dest.txt');
    const second = source.currentIdentity(baseline);
    assert.equal(first.completeness, 'complete');
    assert.equal(second.completeness, 'complete');
    assert.notEqual(first.payload.index_state.digest, second.payload.index_state.digest);
    assert.notEqual(first.digest, second.digest, 'different staged rename sources are different subjects');

    git(repo, 'reset', '--hard', 'HEAD');
    git(repo, 'update-index', '--skip-worktree', 'a.txt');
    writeFileSync(path.join(repo, 'a.txt'), 'hidden change\n', 'utf8');
    const hidden = source.currentIdentity(baseline);
    assert.equal(hidden.completeness, 'incomplete');
    assert.equal(hidden.digest, null);
    assert.ok(hidden.gaps.some(value => value.code === 'HIDDEN_INDEX_STATE'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('every explicit runtime ref is materialized and observed at collection time', () => {
  const lifecycleTime = '2000-01-01T00:00:00.000Z';
  const harness = {
    bindings: new Map(),
    source: { runs: () => [] },
    taskHistory: { currentStatus: () => [{
      binding: { task_id: 'task-1' }, snapshot: { status: 'running', created_at: lifecycleTime,
        started_at: lifecycleTime, finished_at: null }, source_state: 'observed',
      current: { state: 'observed', observed_at: lifecycleTime },
    }] },
  };
  const adapter = new HarnessContextFactsSource(harness as never) as Wire;
  const workflow = { snapshot: { runtime_refs: [
    { runtime_ref_id: 'owned-1', kind: 'owned-task', session_id: null, run_id: null, task_id: 'task-1', call_id: null },
    { runtime_ref_id: 'codex-1', kind: 'codex-run', session_id: randomUUID(), run_id: randomUUID(), task_id: null, call_id: null },
    { runtime_ref_id: 'sync-1', kind: 'sync-call', session_id: null, run_id: null, task_id: null, call_id: randomUUID() },
  ] } };
  const before = Date.now();
  const execution = adapter.execution('ticket-1', workflow, 'runtime', new Date().toISOString());
  assert.equal(execution.observed.length, 3);
  assert.equal(execution.coverage.complete, false);
  assert.equal(execution.observed.find((value: Wire) => value.runtime_ref_id === 'owned-1').classification, 'active');
  assert.equal(execution.observed.find((value: Wire) => value.runtime_ref_id === 'codex-1').classification, 'unknown');
  assert.equal(execution.observed.find((value: Wire) => value.runtime_ref_id === 'sync-1').classification, 'unknown');
  assert.ok(execution.observed.every((value: Wire) => Date.parse(value.observed_at) >= before));
  assert.equal(execution.observed.find((value: Wire) => value.runtime_ref_id === 'owned-1').created_at, lifecycleTime);
});

test('document adapter degrades incomplete contracts and preserves observation provenance', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orchestration-documents-'));
  try {
    const adapter = new MarkdownContextDocumentAdapter();
    writeFileSync(path.join(root, 'checkpoint.md'), '---\nschema_version: 1\n---\n', 'utf8');
    assert.equal(adapter.read(root, 'checkpoint.md', 'checkpoint').status, 'malformed');

    writeFileSync(path.join(root, 'notes.md'), '# Notes\n\n## Context Plan\n\n- **Core:** only-core\n', 'utf8');
    assert.equal(adapter.read(root, 'notes.md', 'implementation-notes').status, 'malformed');

    const effects = Array.from({ length: 100 }, (_, index) => `- effect-${index}: unknown`).join('\n');
    writeFileSync(path.join(root, 'checkpoint.md'), `---\nschema_version: 1\nticket: ORCH-001\nphase: implementation\nworktree: ${root.replaceAll('\\', '/')}\nbranch: fixture\nfixed_point: fixed\nhead: head\n---\n\n# Side effects\n\n${effects}\n`, 'utf8');
    const oldTime = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(path.join(root, 'checkpoint.md'), oldTime, oldTime);
    const before = Date.now(), fact = adapter.read(root, 'checkpoint.md', 'checkpoint');
    assert.equal(fact.status, 'observed');
    assert.equal(fact.declarations.unknown_side_effects.length, 100);
    assert.ok(Date.parse(fact.observed_at!) >= before);
    assert.equal(fact.source_updated_at, oldTime.toISOString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Packet usage derives from durable run events instead of model text', () => {
  const runId = randomUUID(), sessionId = randomUUID();
  const harness = { bindings: new Map([['binding', { ticket_id: 'ticket-1', session_id: sessionId,
    run_id: runId, scope: 'run', id: 'binding' }]]),
  source: { runs: () => [{ id: runId, session_id: sessionId, created_at: new Date().toISOString(),
    status: 'completed', model: 'gpt-6-sol', reasoning: 'medium' }] },
  journal: { records: [{ data: { kind: 'event', event: { kind: 'codex', run_id: runId,
    payload: { type: 'turn.completed', usage: { input_tokens: 91, cached_input_tokens: 70,
      output_tokens: 5 } } } } }] },
  executionOperations: { observations: () => [] } };
  const adapter = new HarnessContextFactsSource(harness as never) as Wire;
  const fact = adapter.execution('ticket-1', undefined, 'runtime', new Date().toISOString());
  assert.deepEqual(fact.usage.value, { runs: 1, input_tokens: 91, cached_input_tokens: 70, output_tokens: 5 });
});

test('Context Plan writer contract accepts four canonical labels and rejects variants', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'context-plan-contract-'));
  try {
    const file = path.join(root, 'notes.md'), adapter = new MarkdownContextDocumentAdapter();
    const canonical = '# Notes\n\n## Context Plan\n\n- **Core:** ticket\n- **Related:** spec\n- **Retrieval:** symbols\n- **Expansion triggers:** conflict\n';
    writeFileSync(file, canonical, 'utf8');
    assert.deepEqual(adapter.read(root, 'notes.md', 'implementation-notes').context_plan?.core, ['ticket']);
    for (const variant of [canonical.replace('Core:', 'Core：'), canonical.replace('- **Related:** spec\n', ''),
      canonical.replace('Core:** ticket', 'Core:** '), canonical.replace('- **Related:** spec', '- **Related:** spec\n- **Related:** duplicate')]) {
      writeFileSync(file, variant, 'utf8');
      assert.equal(adapter.read(root, 'notes.md', 'implementation-notes').status, 'malformed');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Packet distinguishes a missing local spec mirror from its canonical GitHub reference', async t => {
  const f = await fixture('completed'); t.after(f.close);
  const notes = path.join(f.repo, 'docs', 'implementation-notes', 'ORCH-001.md');
  writeFileSync(notes, '# Notes\n\nSource Spec: https://github.invalid/issues/89\n\n## Context Plan\n\n'
    + '- **Core:** ticket\n- **Related:** docs/specs/ORCH-001.md\n- **Retrieval:** symbols\n'
    + '- **Expansion triggers:** conflict\n', 'utf8');
  const packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.ok(packet.retrieval.references.some((value: Wire) => value.kind === 'spec' && value.canonical
    && value.location === 'https://github.invalid/issues/89' && value.status === 'reference-only'));
  assert.ok(packet.retrieval.references.some((value: Wire) => value.kind === 'spec-mirror'
    && value.location === 'docs/specs/ORCH-001.md' && value.status === 'missing'));
  assert.ok(packet.sources.some((value: Wire) => value.kind === 'spec' && value.state === 'missing'));
});

test('canonical source observations retain provenance and conflicting Spec references stay visible', async t => {
  const f = await fixture('completed'); t.after(async () => {
    f.harness.workflowHistory.current.delete(f.registration.ticket_id); await f.close();
  });
  const canonical = 'https://github.invalid/issues/89';
  const notes = path.join(f.repo, 'docs', 'implementation-notes', 'ORCH-001.md');
  writeFileSync(notes, '# Notes\n\nSource Spec: ' + canonical + '\n\n## Context Plan\n\n'
    + '- **Core:** ticket\n- **Related:** spec\n- **Retrieval:** symbols\n- **Expansion triggers:** conflict\n');
  f.harness.workflowHistory.current.set(f.registration.ticket_id, { workflow_revision: 2, fingerprint: 'a'.repeat(64),
    snapshot: { phase: 'implementation', subject: { spec_ref: 'https://github.invalid/issues/88', subject_id: 'subject' },
      findings: [], runtime_refs: [] } } as any);
  const observations = new Map<string, { status: 'observed' | 'unavailable'; revision: string | null;
    observed_at: string; digest: string | null; url: string; provenance: string }>([[canonical,
    { status: 'observed', revision: 'github-revision-1', observed_at: new Date().toISOString(),
      digest: 'sha256:' + 'b'.repeat(64), url: canonical, provenance: 'outer-reader:fixture' }]]);
  const source = new HarnessContextFactsSource(f.harness, new MarkdownContextDocumentAdapter(), observations);
  const packet = new ContextAssembler(source).assemble({ ticket_id: f.registration.ticket_id,
    requested_action: 'implementation', trigger: 'manual' });
  assert.equal(packet.sources.find((value: Wire) => value.id === 'spec-canonical').state, 'observed');
  assert.equal(packet.retrieval.references.find((value: Wire) => value.kind === 'spec').revision, 'github-revision-1');
  assert.ok(packet.integrity.conflicts.some((value: Wire) => value.code === 'SPEC_REFERENCE_CONFLICT'));
  observations.set(canonical, { status: 'unavailable', revision: null, observed_at: new Date().toISOString(),
    digest: null, url: canonical, provenance: 'outer-reader:fixture' });
  assert.equal(source.collect(f.registration.ticket_id).sources.find(value => value.id === 'spec-canonical')?.state,
    'unavailable');
});

test('public Packet uses the trusted authority target list and shows missing package readiness', async t => {
  const f = await fixture(); t.after(f.close);
  const pkg = path.join(f.repo, 'tools', 'package'); mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ dependencies: { sample: '1.0.0' } }));
  writeFileSync(path.join(pkg, 'package-lock.json'), JSON.stringify({ packages: { '': {
    dependencies: { sample: '1.0.0' } } } }));
  f.setTargetPackages(['tools/package']);
  const packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.deepEqual(packet.execution.environment.preflight.target_packages, ['tools/package']);
  assert.equal(packet.execution.environment.preflight.target_package_source, 'fixture-authority');
  assert.equal(packet.execution.environment.preflight.dependencies[0].state, 'missing');
  assert.ok(packet.attention.blockers.some((value: Wire) => value.code === 'DEPENDENCY_NOT_READY'));
  f.setTargetPackages(undefined);
  const unknown = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.equal(unknown.execution.environment.preflight.status, 'unavailable');
});

test('public Packet consumes trusted outer canonical Spec observations with provenance', async t => {
  const f = await fixture(); t.after(f.close);
  const canonical = 'https://github.invalid/issues/89';
  const notes = path.join(f.repo, 'docs', 'implementation-notes', 'ORCH-001.md');
  writeFileSync(notes, '# Notes\n\nSource Spec: ' + canonical + '\n\n## Context Plan\n\n'
    + '- **Core:** ticket\n- **Related:** spec\n- **Retrieval:** symbols\n- **Expansion triggers:** conflict\n');
  const call = async () => (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.equal((await call()).sources.find((value: Wire) => value.id === 'spec-canonical').state, 'reference-only');
  f.canonicalSpecObservations.set(canonical, { url: canonical, status: 'observed',
    revision: 'github-revision-1', observed_at: new Date().toISOString(),
    digest: 'sha256:' + 'a'.repeat(64), provenance: 'outer-reader:fixture' });
  const observed = await call();
  assert.equal(observed.sources.find((value: Wire) => value.id === 'spec-canonical').state, 'observed');
  assert.equal(observed.sources.find((value: Wire) => value.id === 'spec-canonical').provenance, 'outer-reader:fixture');
  f.canonicalSpecObservations.set(canonical, { url: canonical, status: 'unavailable',
    revision: null, observed_at: new Date().toISOString(), digest: null,
    provenance: 'outer-reader:fixture', reason: 'remote-read-failed' });
  const unavailable = await call();
  assert.equal(unavailable.sources.find((value: Wire) => value.id === 'spec-canonical').state, 'unavailable');
  assert.equal(unavailable.sources.find((value: Wire) => value.id === 'spec-canonical').reason, 'remote-read-failed');
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
  const checkpoint = path.join(f.repo, '.local', 'workflow-state', 'ORCH-001.md');
  const many = Array.from({ length: 80 }, (_, index) => `${index}-${'x'.repeat(600)}`).join('；');
  writeFileSync(notes, `# Notes\n\n### Context Plan\n\n- **Core:** ${many}\n- **Related:** source spec\n- **Retrieval:** symbols\n- **Expansion triggers:** conflict\n`, 'utf8');
  let packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.ok(packet.integrity.omissions.some((value: Wire) => value.category === 'context-plan-core'));
  assert.ok(packet.attention.unknown_side_effects.length > 0, 'safety fact survives budget trimming');
  assert.ok(packet.budget.actual_bytes <= packet.budget.max_bytes
    || packet.integrity.omissions.some((value: Wire) => value.category === 'safety-core'));

  const effects = Array.from({ length: 100 }, (_, index) => `- effect-${index}: unknown`).join('\n');
  writeFileSync(checkpoint, readFileSync(checkpoint, 'utf8').replace('- external deployment: unknown', effects), 'utf8');
  packet = (await f.client.callTool({ name: 'assemble_ticket_context', arguments: {
    ticket_id: f.registration.ticket_id, requested_action: 'implementation', trigger: 'manual',
  } })).structuredContent as Wire;
  assert.equal(packet.attention.unknown_side_effects.length, 24);
  assert.equal(packet.integrity.omissions.find((value: Wire) => value.category === 'unknown-side-effects').count, 76);

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
