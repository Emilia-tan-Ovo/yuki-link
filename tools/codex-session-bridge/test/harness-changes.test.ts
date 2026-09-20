import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { Harness } from '../src/harness/harness.ts';
import { createHarnessServer } from '../src/harness/server.ts';
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
    page: async (ticketId: string) => (await fetch(`${base}/tickets/${ticketId}`, { headers: { cookie } })).text(),
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
  assert.match(await f.page(ticket.ticket_id), /累计 Changes/);
  assert.match(await f.page(ticket.ticket_id), /committed\.txt/);
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
