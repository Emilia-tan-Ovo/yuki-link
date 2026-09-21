import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { Harness } from '../src/harness/harness.ts';
import { createHarnessServer } from '../src/harness/server.ts';
import { ChangesSource, ChangesSourceError } from '../src/harness/changes-source.ts';
import type { AddressInfo } from 'node:net';
import type { Source, SourceRun, SourceSession } from '../src/harness/model.ts';

type Wire = Record<string, any>;
const payload = (value: Wire) => value.structuredContent as Wire;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-repo-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Harness Fixture');
  git(root, 'config', 'user.email', 'harness@example.invalid');
  writeFileSync(path.join(root, 'tracked.txt'), 'baseline\n', 'utf8');
  git(root, 'add', 'tracked.txt'); git(root, 'commit', '-qm', 'baseline');
  return { root, fixedPoint: git(root, 'rev-parse', 'HEAD') };
}

function sourceFixture(root: string) {
  const session: SourceSession = { id: randomUUID(), cwd: root, codex_thread_id: null, permissions: {} };
  const run: SourceRun = { id: randomUUID(), session_id: session.id, created_at: new Date().toISOString(),
    model: 'fixture', reasoning: 'low', status: 'completed', config_source: 'fixture', timeout_ms: null, exit_code: 0 };
  const source: Source = { session: id => { assert.equal(id, session.id); return session; },
    runs: id => id === session.id ? [run] : [], events: () => [], attribution: () => ({ state: 'matched' }) };
  return { source, session, run };
}

async function publicFixture(runtime: string, source: Source) {
  const harness = new Harness(runtime, source);
  const mcp = createHttpServer({ harness });
  const ui = createHarnessServer(harness);
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'changes-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`)));
  const base = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`;
  const home = await fetch(base), cookie = home.headers.get('set-cookie')!.split(';')[0];
  return { harness, client, base, cookie,
    register: async (input: Wire) => payload(await client.callTool({ name: 'harness_register_ticket', arguments: input })),
    call: async (name: string, args: Wire) => payload(await client.callTool({ name, arguments: args })),
    detail: async (ticketId: string) => {
      const response = await fetch(`${base}/api/tickets/${ticketId}`, { headers: { cookie } });
      assert.equal(response.status, 200); return response.json() as Promise<Wire>;
    },
    page: async (ticketId: string) => (await fetch(`${base}/api/ui/tickets/${ticketId}`, { headers: { cookie } })).json() as Promise<Wire>,
    close: async () => { await client.close(); mcp.close(); mcp.closeAllConnections(); ui.close(); ui.closeAllConnections(); harness.close(); },
  };
}

test('public Ticket registration persists a fixed baseline and cumulative committed, dirty and untracked Changes', async t => {
  const repo = repository(), runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-runtime-'));
  const fixtureSource = sourceFixture(repo.root);
  writeFileSync(path.join(repo.root, 'tracked.txt'), 'dirty before registration\n', 'utf8');
  writeFileSync(path.join(repo.root, 'pre-existing.txt'), 'already here\n', 'utf8');
  let f = await publicFixture(runtime, fixtureSource.source);
  t.after(async () => { await f.close(); rmSync(runtime, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const registration = { project_key: 'Y', project_name: 'Yuki', ticket_key: 'HARNESS-007', title: '累计 Changes',
    reference: 'issue:47', expected_worktree: repo.root, fixed_point: repo.fixedPoint };
  const ticket = await f.register(registration);
  let detail = await f.detail(ticket.ticket_id);
  assert.equal(detail.ticket.comparison_baseline.commit_oid, repo.fixedPoint);
  assert.equal(detail.changes.freshness, 'current');
  assert.equal(detail.changes.files.find((item: Wire) => item.path === 'tracked.txt').start_relation, 'pre-existing-at-start');
  assert.equal(detail.changes.files.find((item: Wire) => item.path === 'pre-existing.txt').start_relation, 'pre-existing-at-start');

  git(repo.root, 'add', 'tracked.txt'); git(repo.root, 'commit', '-qm', 'commit pre-existing edit');
  writeFileSync(path.join(repo.root, 'committed.txt'), 'committed during ticket\n', 'utf8');
  git(repo.root, 'add', 'committed.txt'); git(repo.root, 'commit', '-qm', 'ticket commit');
  writeFileSync(path.join(repo.root, 'tracked.txt'), 'dirty after commit\n', 'utf8');
  writeFileSync(path.join(repo.root, 'new-untracked.txt'), 'new work\n', 'utf8');
  detail = await f.detail(ticket.ticket_id);
  assert.equal(detail.changes.baseline.commit_oid, repo.fixedPoint, 'HEAD movement must not rewrite the baseline');
  assert.equal(detail.changes.current_head, git(repo.root, 'rev-parse', 'HEAD'));
  assert.deepEqual(new Set(detail.changes.files.map((item: Wire) => item.path)),
    new Set(['tracked.txt', 'committed.txt', 'pre-existing.txt', 'new-untracked.txt']));
  assert.equal(detail.changes.files.find((item: Wire) => item.path === 'tracked.txt').start_relation, 'pre-existing-overlap');
  assert.equal(detail.changes.commits.length, 2, 'commits after the baseline remain in the cumulative view');
  assert.ok(detail.changes.commits.every((item: Wire) => /^[0-9a-f]{40}$/.test(item.oid)));

  await f.close();
  f = await publicFixture(runtime, fixtureSource.source);
  const reopened = await f.detail(ticket.ticket_id);
  assert.equal(reopened.ticket.id, ticket.ticket_id);
  assert.equal(reopened.changes.baseline.commit_oid, repo.fixedPoint);
  assert.ok(reopened.changes.files.some((item: Wire) => item.path === 'committed.txt'));
  assert.equal((await f.page(ticket.ticket_id)).changes.baseline, repo.fixedPoint);
  assert.match(JSON.stringify(await f.page(ticket.ticket_id)), /committed\.txt/);
});

test('run association is process evidence, never modification ownership', async t => {
  const repo = repository(), runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-association-'));
  const fixtureSource = sourceFixture(repo.root), f = await publicFixture(runtime, fixtureSource.source);
  t.after(async () => { await f.close(); rmSync(runtime, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const ticket = await f.register({ project_key: 'Y', project_name: 'Yuki', ticket_key: 'HARNESS-007', title: '关联',
    reference: 'issue:47', expected_worktree: repo.root, fixed_point: repo.fixedPoint });
  await f.call('harness_attach', { ticket_id: ticket.ticket_id, session_id: fixtureSource.session.id, run_id: fixtureSource.run.id });
  writeFileSync(path.join(repo.root, 'external.txt'), 'external editor\n', 'utf8');
  const changes = (await f.detail(ticket.ticket_id)).changes;
  assert.deepEqual(changes.runs.map((item: Wire) => item.association), ['ticket-process']);
  assert.equal(changes.runs[0].modification_ownership, 'not-proven');
  assert.equal(changes.files.find((item: Wire) => item.path === 'external.txt').modification_ownership, 'not-proven');
  assert.ok(changes.evidence_gaps.some((gap: Wire) => gap.code === 'ATTRIBUTION_UNPROVEN'));
  assert.doesNotMatch(JSON.stringify(changes), /Agent contribution|Agent 贡献/i);
});

test('refresh reports unavailable Git facts without reusing a prior current result and recovers', async t => {
  const repo = repository(), runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-freshness-'));
  const fixtureSource = sourceFixture(repo.root), f = await publicFixture(runtime, fixtureSource.source);
  t.after(async () => { await f.close(); rmSync(runtime, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const ticket = await f.register({ project_key: 'Y', project_name: 'Yuki', ticket_key: 'HARNESS-007', title: '刷新',
    reference: 'issue:47', expected_worktree: repo.root, fixed_point: repo.fixedPoint });
  assert.equal((await f.detail(ticket.ticket_id)).changes.freshness, 'current');
  renameSync(path.join(repo.root, '.git'), path.join(repo.root, '.git-offline'));
  const unavailable = (await f.detail(ticket.ticket_id)).changes;
  assert.equal(unavailable.freshness, 'unknown');
  assert.equal(unavailable.state, 'unavailable');
  assert.ok(unavailable.evidence_gaps.some((gap: Wire) => ['GIT_UNAVAILABLE', 'REPOSITORY_MISMATCH'].includes(gap.code)));
  assert.equal(unavailable.files.length, 0, 'a stale successful file list must not masquerade as current');
  renameSync(path.join(repo.root, '.git-offline'), path.join(repo.root, '.git'));
  assert.equal((await f.detail(ticket.ticket_id)).changes.freshness, 'current');
});

test('legacy registered journal records replay without inventing a baseline', async t => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-legacy-'));
  const journalDir = path.join(runtime, 'harness'); mkdirSync(journalDir);
  const sourceId = randomUUID(), projectId = randomUUID(), ticketId = randomUUID(), conversationId = randomUUID();
  const record = (cursor: number, data: Wire) => ({ schema_version: 1, cursor, event_id: randomUUID(), source_id: sourceId,
    observed_at: new Date().toISOString(), data });
  writeFileSync(path.join(journalDir, 'history.jsonl'), [
    record(1, { kind: 'source' }),
    record(2, { kind: 'registered', project: { id: projectId, key: 'legacy', name: 'Legacy' }, ticket: {
      id: ticketId, project_id: projectId, key: 'OLD-1', title: '旧 Ticket', reference: 'legacy:1',
      main_conversation_id: conversationId, expected_worktree: null,
    } }),
  ].map(value => JSON.stringify(value)).join('\n') + '\n', 'utf8');
  const source: Source = { session: () => { throw new Error('unused'); }, runs: () => [], events: () => [], attribution: () => ({}) };
  const harness = new Harness(runtime, source);
  t.after(() => { harness.close(); rmSync(runtime, { recursive: true, force: true }); });
  const detail = harness.detail(ticketId);
  assert.equal(detail.recording.state, 'recording');
  assert.equal(detail.ticket.comparison_baseline, null);
  assert.equal(detail.changes.state, 'unavailable');
  assert.ok(detail.changes.evidence_gaps.some((gap: Wire) => gap.code === 'BASELINE_NOT_RECORDED'));
});

test('tracked and untracked protected names never expose content, hashes or previews', async t => {
  const repo = repository(), runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-protected-'));
  const f = await publicFixture(runtime, sourceFixture(repo.root).source);
  t.after(async () => { await f.close(); rmSync(runtime, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const ticket = await f.register({ project_key: 'Y', project_name: 'Yuki', ticket_key: 'HARNESS-007', title: '保护内容',
    reference: 'issue:47', expected_worktree: repo.root, fixed_point: repo.fixedPoint });
  const trackedSecret = 'tracked-secret-fixture-value', untrackedSecret = 'untracked-secret-fixture-value';
  writeFileSync(path.join(repo.root, '.env.production'), trackedSecret, 'utf8');
  git(repo.root, 'add', '.env.production'); git(repo.root, 'commit', '-qm', 'add protected tracked fixture');
  mkdirSync(path.join(repo.root, 'select-key'));
  writeFileSync(path.join(repo.root, 'select-key', 'credential.pem'), untrackedSecret, 'utf8');
  const detail = await f.detail(ticket.ticket_id);
  for (const name of ['.env.production', 'select-key/credential.pem']) {
    const file = detail.changes.files.find((item: Wire) => item.path === name);
    assert.equal(file.content.state, 'unavailable');
    assert.equal(file.content.sha256, null);
    assert.equal(file.content.preview, null);
  }
  assert.equal(detail.changes.freshness, 'current');
  assert.equal(detail.changes.completeness, 'incomplete');
  assert.ok(!JSON.stringify(detail).includes(trackedSecret));
  assert.ok(!JSON.stringify(detail).includes(untrackedSecret));
  assert.equal((await f.page(ticket.ticket_id)).changes.completeness, 'incomplete');
});

test('Ticket detail refreshes only its target while project overview stays summary-only', async t => {
  const first = repository(), second = repository(), runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-summary-'));
  const f = await publicFixture(runtime, sourceFixture(first.root).source);
  t.after(async () => { await f.close(); rmSync(runtime, { recursive: true, force: true });
    rmSync(first.root, { recursive: true, force: true }); rmSync(second.root, { recursive: true, force: true }); });
  const target = await f.register({ project_key: 'Y', project_name: 'Yuki', ticket_key: 'TARGET', title: '目标',
    reference: 'issue:47', expected_worktree: first.root, fixed_point: first.fixedPoint });
  await f.register({ project_key: 'Y', project_name: 'Yuki', ticket_key: 'OTHER', title: '无关',
    reference: 'issue:48', expected_worktree: second.root, fixed_point: second.fixedPoint });
  const inspected: string[] = [];
  const original = f.harness.changes.facts.inspect.bind(f.harness.changes.facts);
  f.harness.changes.facts.inspect = baseline => { inspected.push(baseline.worktree_root); return original(baseline); };
  await f.detail(target.ticket_id);
  assert.deepEqual(inspected, [first.root]);

  writeFileSync(path.join(first.root, 'summary-only.txt'), 'preview-must-not-leak', 'utf8');
  git(first.root, 'add', 'summary-only.txt'); git(first.root, 'commit', '-qm', 'summary fixture');
  const response = await fetch(`${f.base}/api/projects`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const overview = await response.json() as Wire;
  const changes = overview.projects[0].tickets.find((item: Wire) => item.id === target.ticket_id).changes;
  assert.equal(changes.files, undefined);
  assert.equal(changes.commits, undefined);
  assert.equal(changes.runs, undefined);
  assert.equal(typeof changes.file_count, 'number');
  assert.equal(typeof changes.commit_count, 'number');
  assert.ok(!JSON.stringify(overview).includes('preview-must-not-leak'));
});

test('same-path repository replacement is rejected even when the baseline commit still exists', async t => {
  const repo = repository(), runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-replaced-'));
  const f = await publicFixture(runtime, sourceFixture(repo.root).source);
  t.after(async () => { await f.close(); rmSync(runtime, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const ticket = await f.register({ project_key: 'Y', project_name: 'Yuki', ticket_key: 'HARNESS-007', title: '仓库替换',
    reference: 'issue:47', expected_worktree: repo.root, fixed_point: repo.fixedPoint });
  const before = await f.detail(ticket.ticket_id);
  assert.equal(typeof before.ticket.comparison_baseline.repository_instance_id, 'string');
  const originalGit = path.join(repo.root, '.git-original');
  renameSync(path.join(repo.root, '.git'), originalGit);
  git(repo.root, 'init', '-q');
  git(repo.root, 'config', 'user.name', 'Harness Fixture');
  git(repo.root, 'config', 'user.email', 'harness@example.invalid');
  git(repo.root, 'fetch', '-q', originalGit, repo.fixedPoint);
  git(repo.root, 'reset', '--hard', '-q', 'FETCH_HEAD');
  const replaced = await f.detail(ticket.ticket_id);
  assert.equal(replaced.changes.state, 'unavailable');
  assert.equal(replaced.changes.completeness, 'unknown');
  assert.ok(replaced.changes.evidence_gaps.some((gap: Wire) => gap.code === 'REPOSITORY_MISMATCH'));
});

test('merge-base distinguishes ancestry, real divergence and command failure', () => {
  const repo = repository();
  try {
    const source = new ChangesSource(), baseline = source.capture(repo.root, repo.fixedPoint);
    assert.ok(!source.inspect(baseline).gaps.some(gap => gap.code === 'HISTORY_DIVERGED'));
    git(repo.root, 'checkout', '-q', '--orphan', 'unrelated');
    git(repo.root, 'rm', '-q', '-rf', '.');
    writeFileSync(path.join(repo.root, 'replacement.txt'), 'unrelated history\n', 'utf8');
    git(repo.root, 'add', 'replacement.txt'); git(repo.root, 'commit', '-qm', 'unrelated');
    assert.ok(source.inspect(baseline).gaps.some(gap => gap.code === 'HISTORY_DIVERGED'));

    const failingSpawn = ((command: string, args: readonly string[], options: object) => {
      if (args.includes('merge-base')) return { pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.from('fatal fixture'),
        status: 2, signal: null, error: undefined };
      return spawnSync(command, args, options as never);
    }) as unknown as typeof spawnSync;
    const failing = new ChangesSource({ spawn: failingSpawn });
    assert.throws(() => failing.inspect(baseline), error => error instanceof ChangesSourceError && error.code === 'GIT_UNAVAILABLE');
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test('current Changes report and render material incompleteness independently from freshness', async t => {
  const repo = repository(), runtime = mkdtempSync(path.join(os.tmpdir(), 'harness-changes-completeness-'));
  const f = await publicFixture(runtime, sourceFixture(repo.root).source);
  t.after(async () => { await f.close(); rmSync(runtime, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const ticket = await f.register({ project_key: 'Y', project_name: 'Yuki', ticket_key: 'HARNESS-007', title: '完整性',
    reference: 'issue:47', expected_worktree: repo.root, fixed_point: repo.fixedPoint });
  writeFileSync(path.join(repo.root, 'large.txt'), Buffer.alloc(65 * 1024, 65));
  const detail = await f.detail(ticket.ticket_id);
  assert.equal(detail.changes.freshness, 'current');
  assert.equal(detail.changes.completeness, 'incomplete');
  const page = await f.page(ticket.ticket_id);
  assert.equal(page.changes.freshness, 'current'); assert.equal(page.changes.completeness, 'incomplete');
  const home = await (await fetch(f.base + '/api/ui/projects', { headers: { cookie: f.cookie } })).json() as Wire;
  assert.equal(home.projects[0].tickets[0].attention, true);
});
