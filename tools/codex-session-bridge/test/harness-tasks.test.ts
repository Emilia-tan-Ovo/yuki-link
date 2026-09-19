import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, renameSync, rmdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ComputerTools } from '../src/computer/tools.js';
import { RuntimeStore } from '../src/store.js';
import { createHttpServer } from '../src/http.js';
import { createHarnessRuntime, createHarnessServer } from '../src/harness/runtime.ts';
import { processFixture, waitTask } from './helpers/task-fixture.js';

// 只替代 OS 进程/时钟 seam，结果从真实 MCP 与产品 HTTP 核对。
type Wire = Record<string, any>;
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-tasks-'));
  const workspace = path.join(root, 'workspace'), runtime = path.join(root, 'runtime');
  mkdirSync(workspace);
  const store = new RuntimeStore(runtime);
  const children: any[] = [];
  let time = Date.now(), failCollection = false;
  const options = { readRoots: [workspace], writeRoots: [workspace], runtime, taskNow: () => time,
    spawnProcess: () => { const child = processFixture(); children.push(child); return child; },
    stopProcess: async (child: any) => { child.endProcess(9); return 'succeeded'; },
  };
  let computer = new ComputerTools(options as any);
  // Source-read failure is injected at the task source Interface, never by
  // mocking journal/collector internals. Normal output remains the real source.
  const source = () => ({
    get epoch() { return computer.tasks.epoch; },
    identities: () => computer.tasks.identities(),
    subscribe: (observer: any) => computer.tasks.subscribe(observer),
    observation: (id: string) => computer.tasks.observation(id),
    output: (args: any) => { if (failCollection) throw Error('source read failed'); return computer.tasks.output(args); },
  });
  const manager: any = { store, allowedCwds: [workspace], session() { throw Error('No model in task tests'); } };
  // The third argument is the production-owned task source, never an execution wrapper.
  manager.harness = createHarnessRuntime(manager, [], source());
  let mcp: ReturnType<typeof createHttpServer>, url: URL;
  async function serveMcp() {
    mcp = createHttpServer(manager, computer);
    await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve));
    url = new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`);
  }
  await serveMcp();
  let client: Client;
  async function connect() {
    client = new Client({ name: 'harness-task-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url));
  }
  await connect();
  let ui: ReturnType<typeof createHarnessServer> | undefined, base = '', cookie = '';
  async function openUI() {
    ui = createHarnessServer(manager.harness);
    await new Promise<void>(resolve => ui!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`;
    cookie = (await fetch(base)).headers.get('set-cookie')!.split(';')[0];
  }
  async function closeUI() {
    if (ui) { const server = ui; ui = undefined; await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  }
  t.after(async () => {
    await client.close(); await computer.close(); manager.harness.close(); await closeUI();
    await new Promise<void>(resolve => { mcp.close(() => resolve()); mcp.closeAllConnections(); });
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  const call = async (name: string, args: Wire = {}): Promise<Wire> => {
    const result = await client.callTool({ name, arguments: args });
    return { ...(result.structuredContent as Wire), isError: result.isError === true };
  };
  return { workspace, runtime, children, call, openUI,
    tools: () => client.listTools(),
    advance: (ms: number) => { time += ms; },
    collectionFails: (fails: boolean) => { failCollection = fails; },
    reconnect: async () => { await client.close(); await connect(); },
    rebuild: async (newEpoch = false) => {
      await closeUI(); manager.harness.close();
      if (newEpoch) {
        await client.close();
        await new Promise<void>(resolve => { mcp.close(() => resolve()); mcp.closeAllConnections(); });
        await computer.close(); computer = new ComputerTools(options as any);
        await serveMcp(); await connect();
      }
      manager.harness = createHarnessRuntime(manager, [], source()); await openUI();
    },
    detail: async (id: string): Promise<Wire> => (await fetch(base + '/api/tickets/' + id, { headers: { cookie } })).json(),
    page: async (id: string) => (await fetch(base + '/tickets/' + id, { headers: { cookie } })).text(),
    register: (key = 'HARNESS-003') => call('harness_register_ticket', { project_key: 'P', project_name: '任务工程', ticket_key: key, title: key, reference: 'fixture:' + key }),
  };
}
const taskRecords = (detail: Wire): Wire[] => detail.records.filter((r: Wire) => r.data.kind === 'owned_task').map((r: Wire) => r.data.task);
test('同 request 的 Ticket 身份不可改变，省略归属兼容旧行为且无新增工具', async t => {
  const f = await fixture(t), a = await f.register(), b = await f.register('OTHER');
  const { service_epoch } = await f.call('task_status');
  const args: Wire = { service_epoch, request_id: 'bound', cwd: f.workspace, script: 'unused', ticket_id: a.ticket_id };
  const first = await f.call('task_start', args);
  assert.equal(first.isError, false);
  for (const ticket_id of [b.ticket_id, undefined]) {
    assert.equal((await f.call('task_start', { ...args, ticket_id })).error.code, 'REQUEST_CONFLICT');
  }
  const legacy = await f.call('task_start', { ...args, request_id: 'legacy', ticket_id: undefined });
  assert.equal(legacy.harness_recording, undefined);
  assert.equal((await f.call('task_start', { ...args, request_id: 'legacy' })).error.code, 'REQUEST_CONFLICT');
  assert.equal((await f.call('task_start', { ...args, request_id: 'invalid', ticket_id: randomUUID() })).error.code, 'TICKET_NOT_FOUND');
  assert.equal(f.children.length, 2);
  const tools = (await f.tools()).tools;
  assert.equal(tools.length, 20);
  assert.ok(tools.find(tool => tool.name === 'task_start')!.inputSchema.properties?.ticket_id);
  await f.openUI();
  assert.equal(taskRecords(await f.detail(b.ticket_id)).length, 0);
  assert.ok(taskRecords(await f.detail(a.ticket_id)).every(r => r.binding.task_id === first.task_id));
});

test('公开行保留单流顺序和脱敏，半行不伪造跨流顺序、截断不扩为 Harness 上限', async t => {
  const f = await fixture(t), ticket = await f.register();
  const { service_epoch } = await f.call('task_status');
  const start = await f.call('task_start', { service_epoch, request_id: 'streams', ticket_id: ticket.ticket_id, cwd: f.workspace, script: '不长期保存脚本' });
  const child = f.children[0];
  child.stdout.write(Buffer.from([0xe4, 0xb8]));
  child.stderr.write('stderr-1\n');
  child.stdout.write(Buffer.concat([Buffer.from([0xad]), Buffer.from(' sk-abcdef')]));
  child.stdout.write('ghijklmnop\n');
  child.stderr.write('stderr-2\n');
  // Below the existing source line budget: no new Harness output cap.
  child.stdout.write('大'.repeat(21000) + '\n');
  child.stdout.write('password=unfinished');
  await f.call('task_stop', { task_id: start.task_id });
  await waitTask(f.call, start.task_id, (s: Wire) => s.status === 'stopped');
  await f.openUI();
  const records = taskRecords(await f.detail(ticket.ticket_id));
  const lines = records.filter(r => r.kind === 'output').map(r => r.payload);
  assert.deepEqual(lines.map(r => r.stream), ['stderr', 'stdout', 'stderr', 'stdout']);
  assert.deepEqual(lines.map(r => r.seq), [0, 1, 2, 3]);
  assert.equal(lines[1].text, '中 [REDACTED]\n');
  assert.equal(lines[3].text, '大'.repeat(21000) + '\n');
  const final = records.find(r => r.kind === 'final')!;
  assert.equal(final.integrity.truncated, true);
  assert.equal(final.snapshot.output.stdout_truncated, true);
  assert.equal(final.integrity.source_redaction, true);
  assert.equal(final.snapshot.exit_code, 9);
  assert.ok(!readFileSync(path.join(f.runtime, 'harness/history.jsonl'), 'utf8').includes('unfinished'));
});

test('源过期与新 epoch 分开呈现，保存的输出和终态仍可读且不重放', async t => {
  const f = await fixture(t), ticket = await f.register();
  const { service_epoch } = await f.call('task_status');
  const args = { service_epoch, request_id: 'expiry', ticket_id: ticket.ticket_id, cwd: f.workspace, script: 'unused' };
  const start = await f.call('task_start', args);
  f.children[0].stdout.write('保存后源可以过期\n'); f.children[0].endProcess(7);
  await waitTask(f.call, start.task_id, (s: Wire) => s.status === 'failed');
  await f.openUI();
  f.advance(1800001);
  assert.equal((await f.call('task_status', { task_id: start.task_id })).error.code, 'TASK_EXPIRED');
  const expired = await f.detail(ticket.ticket_id);
  assert.equal(expired.owned_tasks[0].source_state, 'source-expired');
  assert.equal(expired.owned_tasks[0].snapshot.exit_code, 7);
  assert.equal(expired.owned_tasks[0].current.state, 'unknown');
  assert.equal((await f.detail(ticket.ticket_id)).next_cursor, expired.next_cursor);
  const unfinished = await f.call('task_start', { ...args, request_id: 'unconfirmed-before-restart' });
  // Simulate lost observation before a source epoch change. This is deliberately
  // not the production graceful shutdown path (verified in shutdown.test.js).
  await f.rebuild(true);
  const restarted = await f.detail(ticket.ticket_id);
  assert.equal(restarted.owned_tasks[0].source_state, 'source-epoch-expired');
  assert.match(JSON.stringify(restarted), /保存后源可以过期/);
  assert.equal(restarted.owned_tasks[0].snapshot.exit_code, 7);
  const unknown = restarted.owned_tasks.find((task: Wire) => task.binding.task_id === unfinished.task_id);
  assert.equal(unknown.source_state, 'source-epoch-expired');
  assert.equal(unknown.current.state, 'unknown');
  assert.equal(unknown.snapshot.finished_at, null);
  assert.ok(!taskRecords(restarted).some(r => r.binding.task_id === unfinished.task_id && r.kind === 'final'));
  assert.equal((await f.call('task_start', args)).error.code, 'TASK_EPOCH_EXPIRED');
  assert.equal(f.children.length, 2);
});

test('一次来源读取失败保留独立采集缺口，重复刷新不重复缺口记录', async t => {
  const f = await fixture(t), ticket = await f.register();
  const { service_epoch } = await f.call('task_status');
  await f.call('task_start', { service_epoch, request_id: 'read-fail', ticket_id: ticket.ticket_id, cwd: f.workspace, script: 'unused' });
  f.children[0].stdout.write('已有公开行\n');
  f.collectionFails(true);
  await f.openUI();
  const failed = await f.detail(ticket.ticket_id);
  assert.equal(failed.recording.state, 'collection-failed');
  assert.equal(failed.owned_tasks[0].source_state, 'collection-failed');
  assert.equal((await f.detail(ticket.ticket_id)).next_cursor, failed.next_cursor);
  f.collectionFails(false);
  const recovered = await f.detail(ticket.ticket_id);
  assert.equal(recovered.owned_tasks[0].source_state, 'observed');
  assert.equal(recovered.recording.sources.tasks.state, 'collection-failed', 'past gap must remain visible');
  assert.match(JSON.stringify(recovered), /已有公开行/);
  await f.rebuild();
  assert.equal((await f.detail(ticket.ticket_id)).recording.sources.tasks.state, 'collection-failed');
});

test('保存失败不拒绝新任务、不伪造未执行；恢复只补可用输出和快照', async t => {
  const f = await fixture(t), ticket = await f.register();
  const { service_epoch } = await f.call('task_status');
  const args = { service_epoch, request_id: 'saved-prefix', ticket_id: ticket.ticket_id, cwd: f.workspace, script: '绝不能长期保存的脚本正文' };
  const start = await f.call('task_start', args);
  f.children[0].stdout.write('已保存前缀\n');
  await f.openUI();
  const before = await f.detail(ticket.ticket_id);
  const journal = path.join(f.runtime, 'harness/history.jsonl');
  renameSync(journal, journal + '.saved'); mkdirSync(journal);
  f.children[0].stdout.write('故障期间仍在源内\n');
  const accepted = await f.call('task_start', { ...args, request_id: 'recording-failed' });
  assert.equal(accepted.isError, false);
  assert.equal(accepted.harness_recording.state, 'recording-failed');
  assert.equal(accepted.harness_recording.accepted, 'recording-failed');
  assert.equal(f.children.length, 2);
  const failed = await f.detail(ticket.ticket_id);
  assert.equal(failed.next_cursor, before.next_cursor);
  assert.equal(failed.recording.state, 'recording-failed');
  assert.ok(!JSON.stringify(failed).includes(args.script));
  rmdirSync(journal); renameSync(journal + '.saved', journal);
  await f.rebuild();
  const recovered = await f.detail(ticket.ticket_id), events = taskRecords(recovered);
  assert.deepEqual(events.filter(r => r.kind === 'output').map(r => r.payload.text), ['已保存前缀\n', '故障期间仍在源内\n']);
  assert.ok(events.some(r => r.kind === 'lifecycle-gap'));
  assert.equal(f.children.length, 2);
  await f.call('task_stop', { task_id: start.task_id });
});

test('MCP 受管任务在 UI 离线期间保存双流与停止事实，重建后同票历史不重复', async t => {
  const f = await fixture(t), ticket = await f.register();
  const { service_epoch } = await f.call('task_status');
  const args = { ticket_id: ticket.ticket_id, service_epoch, request_id: 'once', cwd: f.workspace, script: '完整脚本只供执行，不进入长期历史' };
  const started = await f.call('task_start', args);
  assert.equal(started.isError, false, 'task_start must accept the explicit Ticket at the public seam');
  assert.equal(started.harness_recording?.state, 'recording');
  const child = f.children[0];
  child.stdout.write('输出一\n'); child.stderr.write('诊断一\n');
  await f.reconnect();
  const recovered = await f.call('task_start', args);
  assert.equal(recovered.task_id, started.task_id);
  assert.equal(recovered.deduplicated, true);
  assert.equal(f.children.length, 1);
  child.stdout.write('输出二 <script>unsafe</script>\n'); child.stderr.write('诊断二\n');
  const output = await f.call('task_output', { task_id: started.task_id });
  assert.equal(output.events.length, 4);
  assert.deepEqual((await f.call('task_output', { task_id: started.task_id })).events, output.events);
  assert.equal((await f.call('task_status', { task_id: started.task_id })).status, 'running');
  await f.call('task_stop', { task_id: started.task_id });
  const terminal = await waitTask(f.call, started.task_id, (s: Wire) => s.status === 'stopped');
  assert.equal(terminal.exit_code, 9);
  await f.openUI();
  const detail = await f.detail(ticket.ticket_id), tasks = taskRecords(detail);
  assert.equal(detail.ticket.main_conversation_id, ticket.conversation_id);
  assert.deepEqual(tasks.filter(r => r.kind === 'output').map(r => r.payload), output.events);
  for (const kind of ['accepted', 'spawn', 'stop.requested', 'stop.attempt', 'stop.result', 'root.exit', 'pipes.closed', 'final']) {
    assert.ok(tasks.some(r => r.kind === kind), 'missing lifecycle: ' + kind);
  }
  assert.equal(tasks.find(r => r.kind === 'final')!.snapshot.exit_code, 9);
  assert.ok(!JSON.stringify(detail).includes(args.script));
  assert.match(JSON.stringify(detail), /source-not-provided/);
  const page = await f.page(ticket.ticket_id);
  assert.match(page, /stdout/); assert.match(page, /stderr/); assert.match(page, /非两管道实际写入全局顺序/);
  assert.match(page, /&lt;script&gt;/); assert.ok(!page.includes('<script>unsafe'));
  await f.rebuild();
  const restored = await f.detail(ticket.ticket_id);
  assert.deepEqual(taskRecords(restored).filter(r => r.kind === 'output').map(r => r.payload), output.events);
  assert.equal(restored.next_cursor, detail.next_cursor);
  assert.equal(f.children.length, 1);
});
