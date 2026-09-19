import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, renameSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RuntimeStore } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { createHttpServer } from '../src/http.js';
import { createHarnessRuntime, createHarnessServer } from '../src/harness/runtime.ts';
import { Harness } from '../src/harness/harness.ts';
import type { AddressInfo } from 'node:net';

interface Callbacks {
  onSpawn(pid: number | null): void;
  onEvent(event: Record<string, unknown>): void;
  onStderr(text: string): void;
  onDone(result: { code: number }): void;
}
type FixtureManager = SessionManager & { harness: Harness };
// SDK wire data is deliberately checked by assertions at the public seam.
type Wire = Record<string, any>;
const payload = (result: Record<string, unknown>) => result.structuredContent as Wire;

async function clientFor(manager: unknown) {
  const server = createHttpServer(manager);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'harness-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  return { client, close: async () => { await client.close(); server.close(); server.closeAllConnections(); } };
}

async function browserFor(harness: Harness) {
  const server = createHarnessServer(harness);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = await fetch(base), cookie = home.headers.get('set-cookie')!.split(';')[0];
  return { base, cookie, home: await home.text(),
    get: async (route: string): Promise<Wire> => { const r = await fetch(base + route, { headers: { cookie } }); assert.equal(r.status, 200); return r.json(); },
    close: () => { server.close(); server.closeAllConnections(); } };
}

test('Project → Ticket keeps the real bridge conversation while the UI is closed', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-'));
  const cwd = path.join(root, 'project'); mkdirSync(cwd);
  const store = new RuntimeStore(path.join(root, 'data'));
  let callbacks!: Callbacks;
  const manager = new SessionManager({ store, allowedCwds: [cwd],
    catalog: { validate: async () => ({ model: 'fixture', reasoning: 'low' }) },
    permissionResolver: { resolve: async () => ({ version: 1, kind: 'native', stored: true,
      sandbox_mode: 'read-only', approval_policy: 'never', approvals_reviewer: 'user',
      workspace_write: null, source: 'fixture', resolved_at: new Date().toISOString() }) },
    executor: { start: (_run: unknown, _session: unknown, _prompt: string, handlers: Callbacks) => {
      callbacks = handlers; handlers.onSpawn(null);
      return { stop: async () => handlers.onDone({ code: 1 }) };
    } },
  }) as FixtureManager;
  const mcp = createHttpServer(manager);
  manager.harness = createHarnessRuntime(manager);
  const ui = createHarnessServer(manager.harness);
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'harness-product-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`)));
  t.after(async () => { await client.close(); mcp.close(); mcp.closeAllConnections();
    ui.close(); ui.closeAllConnections(); manager.harness.close();
    await manager.close(); rmSync(root, { recursive: true, force: true }); });
  const registered = await client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'sample', project_name: '示例工程', ticket_key: '40', title: '首条协作', reference: 'issue:40',
  } });
  assert.equal(registered.isError, undefined, 'explicit Ticket registration must be available');
  const ticket = payload(registered);
  const run = payload(await client.callTool({ name: 'codex_start_session', arguments: {
    cwd, request_id: randomUUID(), prompt: '真实 bridge 任务',
  } }));
  assert.equal((await client.callTool({ name: 'harness_attach', arguments: {
    ticket_id: ticket.ticket_id, session_id: run.session_id,
  } })).isError, undefined);
  await client.close();
  callbacks.onEvent({ type: 'thread.started', thread_id: randomUUID() });
  callbacks.onEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'echo 测试', aggregated_output: '工具输出', exit_code: 0 } });
  callbacks.onEvent({ type: 'error', message: '可恢复错误' });
  callbacks.onStderr('诊断内容');
  callbacks.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: '回复 <script>bad()</script>' } });
  callbacks.onEvent({ type: 'turn.completed' }); callbacks.onDone({ code: 0 });
  // No UI/API request drives capture. After the background interval, remove the
  // source journal: the reopened product must read its own durable copy.
  await new Promise(resolve => setTimeout(resolve, 1300));
  renameSync(path.join(root, 'data/runs'), path.join(root, 'data/source-offline'));
  // The product listener is supplied by production composition in the green slice.
  const base = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`;
  const home = await fetch(base); const cookie = home.headers.get('set-cookie')!.split(';')[0];
  assert.match(await home.text(), /示例工程/);
  const detail = await (await fetch(`${base}/tickets/${ticket.ticket_id}`, { headers: { cookie } })).text();
  assert.match(detail, /真实 bridge 任务/); assert.match(detail, /工具输出/);
  assert.match(detail, /可恢复错误/); assert.match(detail, /诊断内容/);
  assert.match(detail, /回复 &lt;script&gt;/); assert.ok(!detail.includes('<script>bad()'));
  assert.ok(detail.includes(ticket.conversation_id));
  assert.match(detail, /collection-failed/);
});

test('restart and session switch preserve Conversation, grouping and explicit attribution', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-history-'));
  const cwd = path.join(root, 'project'), other = path.join(root, 'other'); mkdirSync(cwd); mkdirSync(other);
  const runtime = path.join(root, 'data');
  let store!: RuntimeStore, manager!: FixtureManager, transport!: Awaited<ReturnType<typeof clientFor>>, browser!: Awaited<ReturnType<typeof browserFor>>;
  const calls: Callbacks[] = [];
  async function boot() {
    store = new RuntimeStore(runtime);
    manager = new SessionManager({ store, allowedCwds: [cwd, other],
      catalog: { validate: async () => ({ model: 'fixture', reasoning: 'low' }) },
      permissionResolver: { resolve: async () => ({ version: 1, kind: 'native', stored: true, sandbox_mode: 'read-only',
        approval_policy: 'never', approvals_reviewer: 'user', workspace_write: null, source: 'fixture', resolved_at: new Date().toISOString() }) },
      executor: { start: (_r: unknown, _s: unknown, _p: string, callbacks: Callbacks) => { calls.push(callbacks); return { stop: async () => callbacks.onDone({ code: 1 }) }; } },
    }) as FixtureManager;
    manager.harness = createHarnessRuntime(manager);
    transport = await clientFor(manager);
    browser = await browserFor(manager.harness);
  }
  const tool = async (name: string, args: Wire): Promise<Wire> => transport.client.callTool({ name, arguments: args });
  const finish = async (text: string) => {
    await new Promise(resolve => setImmediate(resolve));
    const c = calls.at(-1)!;
    c.onEvent({ type: 'thread.started', thread_id: randomUUID() });
    c.onEvent({ type: 'item.completed', item: { type: 'agent_message', text } });
    c.onEvent({ type: 'turn.completed' }); c.onDone({ code: 0 });
  };
  await boot();
  t.after(async () => { browser.close(); await transport.close(); await manager.close(); rmSync(root, { recursive: true, force: true }); });
  const registration = { project_key: 'A', project_name: '工程 A', ticket_key: 'HARNESS-001', title: '持久 Ticket', reference: 'issue:40', expected_worktree: cwd };
  const ticket = (await tool('harness_register_ticket', registration)).structuredContent;
  assert.equal((await tool('harness_register_ticket', registration)).structuredContent.ticket_id, ticket.ticket_id);
  assert.equal((await tool('harness_register_ticket', { ...registration, title: '覆盖标题' })).structuredContent.error.code, 'REGISTRATION_CONFLICT');
  const second = (await tool('harness_register_ticket', { ...registration, project_key: 'B', project_name: '工程 B' })).structuredContent;
  const first = (await tool('codex_start_session', { cwd, request_id: randomUUID(), prompt: '第一段任务' })).structuredContent;
  await tool('harness_attach', { ticket_id: ticket.ticket_id, session_id: first.session_id });
  await finish('第一段回复');
  const conflicting = await tool('harness_attach', { ticket_id: second.ticket_id, session_id: first.session_id });
  assert.equal(conflicting.structuredContent.error.code, 'ATTRIBUTION_MISMATCH');
  // Shutdown through the existing owner; the last run's terminal events must be
  // captured before releasing RuntimeStore's lock, even without a UI refresh.
  browser.close(); await transport.close(); await manager.close();
  await boot();
  const restored = await browser.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(restored.ticket.main_conversation_id, ticket.conversation_id);
  assert.match(JSON.stringify(restored), /第一段回复/);
  const twice = await browser.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(twice.next_cursor, restored.next_cursor, 'refresh must not duplicate imported events');
  const later = (await tool('codex_start_session', { cwd: other, request_id: randomUUID(), prompt: '第二段任务' })).structuredContent;
  await tool('harness_attach', { ticket_id: ticket.ticket_id, session_id: later.session_id, run_id: later.run_id });
  await finish('第二段回复');
  const detail = await browser.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(detail.ticket.main_conversation_id, ticket.conversation_id);
  assert.match(JSON.stringify(detail), /attribution mismatch/);
  assert.match(JSON.stringify(detail), /第二段回复/);
  const page = await (await fetch(browser.base + '/tickets/' + ticket.ticket_id, { headers: { cookie: browser.cookie } })).text();
  assert.match(page, /session 切换边界/);
  const groups = await browser.get('/api/projects');
  assert.deepEqual(groups.projects.map((p: Wire) => [p.name, p.tickets.length]), [['工程 A', 1], ['工程 B', 1]]);
  assert.equal(groups.acceptance.state, 'unavailable');
  const isolated = await browser.get('/api/tickets/' + second.ticket_id);
  assert.ok(!JSON.stringify(isolated).includes('第一段回复'));
  assert.equal((await fetch(browser.base + '/api/projects')).status, 403);
  assert.equal((await fetch(browser.base, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const foreignHostStatus = await new Promise(resolve => {
    http.get(browser.base, { headers: { Host: 'foreign.invalid' } }, r => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(browser.base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(browser.base + '/api/tickets/' + ticket.ticket_id + '?after=-1', { headers: { cookie: browser.cookie } })).status, 400);
  assert.equal((await fetch(browser.base + '/api/tickets/' + randomUUID(), { headers: { cookie: browser.cookie } })).status, 404);
});

test('recording failure cannot acknowledge new history; damaged tail preserves readable prefix', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-failure-'));
  const store = new RuntimeStore(root);
  const session = { id: randomUUID(), cwd: root, codex_thread_id: null, permissions: {} };
  const run = { id: randomUUID(), session_id: session.id, created_at: new Date().toISOString(), model: 'fixture',
    reasoning: 'low', status: 'running', config_source: 'fixture', timeout_ms: null, exit_code: null };
  const events = [{ seq: 0, at: run.created_at, session_id: session.id, run_id: run.id, type: 'message.sent', data: { text: '已保存的消息 password=fixtureSecretValue' } }];
  const source = { session: () => session, runs: () => [run], events: () => events, attribution: () => ({ state: 'unknown' }) };
  let harness = new Harness(root, source), transport = await clientFor({ harness }), browser = await browserFor(harness);
  t.after(async () => { await transport.close(); browser.close(); harness.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const args = { project_key: 'P', project_name: 'P', ticket_key: 'one', title: '记录失败', reference: 'one' };
  const registered = payload(await transport.client.callTool({ name: 'harness_register_ticket', arguments: args }));
  await transport.client.callTool({ name: 'harness_attach', arguments: { ticket_id: registered.ticket_id, session_id: session.id } });
  const before = await browser.get('/api/tickets/' + registered.ticket_id);
  assert.equal(before.records.find((r: Wire) => r.data.kind === 'event' && r.data.event.kind === 'message.sent').data.event.integrity.redacted, true);
  assert.ok(!JSON.stringify(before).includes('fixtureSecretValue'));
  const file = path.join(root, 'harness/history.jsonl'), backup = file + '.saved';
  renameSync(file, backup); mkdirSync(file); // Deterministic filesystem write failure, not a mock of Store.
  events.push({ ...events[0], seq: 1, data: { text: '尚未保存的消息' } });
  const rejected = await transport.client.callTool({ name: 'harness_register_ticket', arguments: { ...args, ticket_key: 'two' } });
  assert.equal(rejected.isError, true); assert.equal(payload(rejected).error.code, 'RECORDING_FAILED');
  const failed = await browser.get('/api/tickets/' + registered.ticket_id);
  assert.equal(failed.recording.state, 'recording-failed');
  assert.equal(failed.next_cursor, before.next_cursor);
  assert.ok(!JSON.stringify(failed).includes('尚未保存的消息'));
  assert.equal((await browser.get('/api/projects')).projects[0].tickets.length, 1);
  await transport.close(); browser.close(); harness.close();
  rmdirSync(file); renameSync(backup, file); appendFileSync(file, '{"partial":', 'utf8');
  harness = new Harness(root, source); transport = await clientFor({ harness }); browser = await browserFor(harness);
  const damaged = await browser.get('/api/tickets/' + registered.ticket_id);
  assert.equal(damaged.recording.state, 'recording-failed');
  assert.match(JSON.stringify(damaged), /已保存的消息/);
  assert.ok(!JSON.stringify(damaged).includes('尚未保存的消息'));
});
