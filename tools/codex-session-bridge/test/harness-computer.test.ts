import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ComputerTools } from '../src/computer/tools.js';
import { RuntimeStore } from '../src/store.js';
import { createHttpServer } from '../src/http.js';
import { Harness } from '../src/harness/harness.ts';
import { createHarnessServer } from '../src/harness/server.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Wire data comes from the public MCP/HTTP protocols, not internal TS types.
type Wire = Record<string, any>;
async function fixture(t: TestContext, options: Wire = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-computer-'));
  const workspace = path.join(root, 'workspace'), runtime = path.join(root, 'runtime');
  mkdirSync(workspace);
  let store: RuntimeStore, harness: Harness, computer: ComputerTools, client: Client;
  let mcp: ReturnType<typeof createHttpServer>, ui: ReturnType<typeof createHarnessServer>;
  let base: string, url: string, cookie: string;
  async function boot() {
    store = new RuntimeStore(runtime);
    harness = new Harness(runtime, { session() { throw Error('no Codex'); }, runs: () => [], events: () => [], attribution: () => ({ state: 'unknown' }) });
    harness.start();
    computer = new ComputerTools({ readRoots: [workspace], writeRoots: [workspace], runtime, ...options } as any);
    mcp = createHttpServer({ harness }, computer);
    await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
    client = new Client({ name: 'harness-computer-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    ui = createHarnessServer(harness);
    await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`;
    cookie = (await fetch(base)).headers.get('set-cookie')!.split(';')[0];
  }
  async function close() {
    await client.close(); await computer.close(); harness.close();
    for (const server of [mcp, ui]) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    store.close();
  }
  await boot();
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (name: string, args: Wire): Promise<Wire> => {
    const r = await client.callTool({ name, arguments: args });
    return { ...(r.structuredContent as Wire), isError: r.isError === true };
  };
  return { root, runtime, workspace, call,
    get url() { return url; }, get client() { return client; },
    get: async (route: string): Promise<Wire> => (await fetch(base + route, { headers: { cookie } })).json(),
    page: async (route: string) => (await fetch(base + route, { headers: { cookie } })).text(),
    restart: async () => { await close(); await boot(); },
    // 故障 seam：公开记录 adapter 接收不可序列化的源快照，不能经 JSON MCP 制造。
    observe: (ticketId: string, input: Wire, action: () => unknown) => harness.computerCalls.run('powershell_execute', ticketId, input, action),
    register: (key = 'HARNESS-002') => call('harness_register_ticket', { project_key: 'P', project_name: '同步工程', ticket_key: key, title: key, reference: 'fixture:' + key, expected_worktree: workspace }),
  };
}

test('显式 Ticket 的同步输入和结果在 UI 未观察期间保存，重启后仍可回看', async t => {
  const f = await fixture(t);
  const ticket = await f.register();
  const file = path.join(f.workspace, 'note.txt');
  const content = '持久正文 <script>不能执行</script>\n';
  const written = await f.call('filesystem_write', { ticket_id: ticket.ticket_id, path: file, content });
  assert.equal(written.isError, false);
  assert.equal(written.harness_recording?.started, 'recorded');
  assert.equal(written.harness_recording?.result, 'recorded');
  assert.equal(readFileSync(file, 'utf8'), content);
  await f.restart();
  const detail = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(detail.ticket.main_conversation_id, ticket.conversation_id);
  const calls = detail.records.filter((r: Wire) => r.data.kind === 'computer_call').map((r: Wire) => r.data.call);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.content, content);
  assert.equal(calls[1].result.changed, true);
  assert.equal(calls[0].call_id, written.harness_recording.call_id);
  assert.equal(calls[1].call_id, calls[0].call_id);
  assert.equal(calls[0].session_id, undefined);
  const page = await f.page('/tickets/' + ticket.ticket_id);
  assert.match(page, /filesystem_write/);
  assert.match(page, /&lt;script&gt;/);
  assert.ok(!page.includes('<script>不能执行'));
  assert.equal((await f.get('/api/tickets/' + ticket.ticket_id)).next_cursor, detail.next_cursor);
});

test('采集失败保存缺口但不改执行结果；刷新与重启不掩盖该来源缺口', async t => {
  const f = await fixture(t), ticket = await f.register();
  const file = path.join(f.workspace, 'capture-failure.txt');
  const input = { cwd: f.workspace, script: 'password=neverPersistThis',
    snapshot: { toJSON() { throw new Error('fixture serialization failure'); } } };
  const observed = await f.observe(ticket.ticket_id, input, () => {
    writeFileSync(file, '执行仍成功', 'utf8');
    return { exit_code: 0, stdout: '真实结果', stderr: '' };
  });
  assert.equal(observed.isError, false);
  const response: Wire = observed.response;
  assert.equal(response.exit_code, 0);
  assert.equal(response.stdout, '真实结果');
  assert.equal(observed.response.harness_recording.started, 'collection-failed');
  assert.equal(observed.response.harness_recording.result, 'recorded');
  assert.equal(readFileSync(file, 'utf8'), '执行仍成功');
  const detail = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(detail.recording.state, 'collection-failed');
  const gap = detail.records.find((r: Wire) => r.data.kind === 'computer_call' && r.data.call.stage === 'started').data.call;
  assert.equal(gap.capture, 'collection-failed'); assert.equal(gap.input, null);
  assert.equal(gap.integrity.stdout, 'collection-failed');
  const durable = readFileSync(path.join(f.runtime, 'harness/history.jsonl'), 'utf8');
  assert.ok(!durable.includes('neverPersistThis'));
  assert.ok(!durable.includes('fixture serialization failure'));
  await f.restart();
  const restored = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(restored.recording.state, 'collection-failed');
  assert.equal(restored.next_cursor, detail.next_cursor);
  assert.equal(restored.computer_calls[0].state, 'succeeded');
});

test('保存失败后拒绝新的文件写入且不推进游标；重启后悬空 started 明确 unknown', async t => {
  let journal = '', armed = false;
  const f = await fixture(t, { appendAudit: (_file: string, line: string) => {
    const audit = JSON.parse(line);
    if (armed && audit.operation === 'filesystem_write' && audit.status === 'completed') {
      armed = false; renameSync(journal, journal + '.saved'); mkdirSync(journal);
    }
  } });
  const ticket = await f.register(); journal = path.join(f.runtime, 'harness/history.jsonl');
  armed = true;
  const file = path.join(f.workspace, 'saved.txt');
  const result = await f.call('filesystem_write', { ticket_id: ticket.ticket_id, path: file, content: '实际已写' });
  assert.equal(result.isError, false); assert.equal(result.changed, true);
  assert.equal(result.harness_recording.started, 'recorded');
  assert.equal(result.harness_recording.result, 'recording-failed');
  assert.equal(readFileSync(file, 'utf8'), '实际已写');
  const failed = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(failed.recording.state, 'recording-failed');
  const blocked = path.join(f.workspace, 'must-not-execute.txt');
  const next = await f.call('filesystem_write', { ticket_id: ticket.ticket_id, path: blocked, content: 'gate 已生效' });
  assert.equal(next.isError, true); assert.equal(next.error.code, 'RECORDING_FAILED');
  assert.equal(existsSync(blocked), false);
  const destination = path.join(f.workspace, 'must-not-move.txt');
  const move = await f.call('filesystem_move', { ticket_id: ticket.ticket_id, source: file, destination, expected_sha256: result.sha256 });
  assert.equal(move.isError, true); assert.equal(move.error.code, 'RECORDING_FAILED');
  assert.equal(existsSync(file), true); assert.equal(existsSync(destination), false);
  const sentinel = path.join(f.workspace, 'must-not-spawn.txt');
  const execute = await f.call('powershell_execute', { cwd: f.workspace, script: `Set-Content -LiteralPath '${sentinel}' -Value forbidden` });
  assert.equal(execute.isError, true); assert.equal(execute.error.code, 'RECORDING_FAILED');
  assert.equal(existsSync(sentinel), false, 'omitting ticket_id must not bypass the gate');
  assert.equal((await f.get('/api/tickets/' + ticket.ticket_id)).next_cursor, failed.next_cursor);
  rmdirSync(journal); renameSync(journal + '.saved', journal);
  await f.restart();
  const restored = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(restored.computer_calls[0].state, 'unknown');
  assert.equal(restored.computer_calls[0].reason, 'completion-not-recorded');
  assert.equal(restored.next_cursor, failed.next_cursor);
});

// 受控子进程只替代 OS seam，仍从真实 MCP/HTTP 核对来源截断与保存内容。
test('来源已截断的 UTF-8 输出与真实空流如实保存，无 Harness 二次裁剪', async t => {
  let child: any;
  const f = await fixture(t, { spawnProcess: () => {
    child = new EventEmitter(); child.pid = 1234567;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.emit('data', Buffer.from('中'.repeat(400000)));
    });
    return child;
  }, stopProcess: async () => { child.emit('exit', 1, null); child.emit('close'); return 'confirmed'; } });
  const ticket = await f.register();
  const result = await f.call('powershell_execute', { ticket_id: ticket.ticket_id, cwd: f.workspace, script: 'fixture 输出' });
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
  const source = result.error.details.result;
  assert.equal(source.output.stdout_truncated, true); assert.equal(source.stderr, '');
  const detail = await f.get('/api/tickets/' + ticket.ticket_id);
  const call = detail.records.find((r: Wire) => r.data.kind === 'computer_call' && r.data.call.stage === 'result').data.call;
  assert.equal(call.error.details.result.stdout, source.stdout);
  assert.equal(Buffer.byteLength(call.error.details.result.stdout), 1048575);
  assert.equal(call.integrity.truncated, true); assert.equal(call.integrity.incomplete, true);
  assert.equal(call.integrity.stderr, 'observed'); assert.equal(call.error.details.result.stderr, '');
});

test('八类工具保留来源事实、脱敏和旧调用行为；错误归属不执行且不串票', async t => {
  const f = await fixture(t), a = await f.register(), b = await f.register('OTHER');
  const ticket_id = a.ticket_id, file = path.join(f.workspace, 'a.txt');
  const written = await f.call('filesystem_write', { ticket_id, path: file, content: '中文内容\n' });
  const read = await f.call('filesystem_read', { ticket_id, path: file });
  assert.equal(read.content, '中文内容\n');
  assert.ok((await f.call('filesystem_list', { ticket_id, path: f.workspace })).entries.some((e: Wire) => e.name === 'a.txt'));
  assert.equal(spawnSync('git', ['init', f.workspace], { windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['-C', f.workspace, 'add', 'a.txt'], { windowsHide: true }).status, 0);
  assert.match((await f.call('git_status', { ticket_id, cwd: f.workspace })).stdout, /a.txt/);
  assert.match((await f.call('git_diff', { ticket_id, cwd: f.workspace, path: file, staged: true })).stdout, /中文内容/);
  assert.equal((await f.call('powershell', { ticket_id, cwd: f.workspace, query: 'location' })).data.path, f.workspace);
  const script = "[Console]::Out.Write('中文输出'); [Console]::Error.Write('password=fixtureSecret'); exit 7";
  const failed = await f.call('powershell_execute', { ticket_id, cwd: f.workspace, script });
  assert.equal(failed.isError, true);
  assert.equal(failed.error.details.result.exit_code, 7);
  assert.equal(failed.harness_recording.result, 'recorded');
  const moved = await f.call('filesystem_move', { ticket_id, source: file, destination: path.join(f.workspace, 'b.txt'), expected_sha256: written.sha256 });
  assert.equal(moved.changed, true);
  assert.equal((await f.call('filesystem_read', { path: moved.destination })).harness_recording, undefined);
  const forbidden = path.join(f.workspace, 'must-not-exist.txt');
  assert.equal((await f.call('filesystem_write', { ticket_id: randomUUID(), path: forbidden, content: 'x' })).error.code, 'TICKET_NOT_FOUND');
  assert.equal(existsSync(forbidden), false);
  const refused = await f.call('filesystem_write', { ticket_id, path: forbidden, content: 'password=secretRejected' });
  assert.equal(refused.error.code, 'SENSITIVE_CONTENT');
  assert.equal(existsSync(forbidden), false);
  const detail = await f.get('/api/tickets/' + ticket_id);
  const records = detail.records.filter((r: Wire) => r.data.kind === 'computer_call').map((r: Wire) => r.data.call);
  assert.equal(new Set(records.map((r: Wire) => r.tool)).size, 8);
  const result = records.find((r: Wire) => r.call_id === failed.harness_recording.call_id && r.stage === 'result');
  assert.equal(result.error.details.result.stdout, '中文输出');
  assert.equal(result.integrity.source_redaction, true);
  assert.equal(result.integrity.truncated, false);
  assert.equal(result.integrity.exit_code, 'observed');
  const input = records.find((r: Wire) => r.call_id === failed.harness_recording.call_id && r.stage === 'started');
  assert.equal(input.integrity.redacted, true);
  const fs = records.find((r: Wire) => r.tool === 'filesystem_read' && r.stage === 'result');
  assert.equal(fs.integrity.exit_code, 'source-not-provided');
  assert.equal(fs.integrity.truncated, 'unknown');
  for (const text of [JSON.stringify(detail), readFileSync(path.join(f.runtime, 'harness/history.jsonl'), 'utf8')]) {
    assert.ok(!text.includes('fixtureSecret')); assert.ok(!text.includes('secretRejected'));
  }
  assert.equal((await f.get('/api/tickets/' + b.ticket_id)).records.length, 1);
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.filter(tool => tool.inputSchema.properties?.ticket_id && !tool.name.startsWith('harness_') && tool.name !== 'task_start').length, 8);
});

test('响应丢失后仍保存一次执行；重启不自动重放', async t => {
  const f = await fixture(t), ticket = await f.register();
  const controller = new AbortController(), file = path.join(f.workspace, 'once.txt');
  const request = fetch(f.url, { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'powershell_execute', arguments: {
      ticket_id: ticket.ticket_id, cwd: f.workspace,
      script: "Add-Content './once.txt' 'START' -NoNewline; Start-Sleep -Milliseconds 800; Add-Content './once.txt' 'END' -NoNewline",
    } } }) }).then(r => r.text(), e => e.name);
  const deadline = Date.now() + 10000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(existsSync(file), true);
  const during = await f.get('/api/tickets/' + ticket.ticket_id);
  assert.equal(during.computer_calls[0].reason, 'not-yet-observed');
  controller.abort(); await request;
  let detail: Wire = during;
  while (Date.now() < deadline) {
    detail = await f.get('/api/tickets/' + ticket.ticket_id);
    if (detail.computer_calls[0]?.state === 'succeeded') break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(detail.computer_calls[0].state, 'succeeded');
  assert.equal(readFileSync(file, 'utf8'), 'STARTEND');
  const cursor = detail.next_cursor;
  await f.restart();
  assert.equal((await f.get('/api/tickets/' + ticket.ticket_id)).next_cursor, cursor);
  assert.equal(readFileSync(file, 'utf8'), 'STARTEND');
});
