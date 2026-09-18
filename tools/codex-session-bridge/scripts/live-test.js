import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ModelCatalog } from '../src/catalog.js';
import { RuntimeStore } from '../src/store.js';
import { CodexExecutor } from '../src/executor.js';
import { PermissionResolver } from '../src/permissions.js';
import { SessionManager } from '../src/manager.js';
import { createHttpServer } from '../src/http.js';
import { ComputerTools } from '../src/computer/tools.js';

// Explicit opt-in only: makes three real model turns using the existing CLI login.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(root, 'runtime', `live-${Date.now()}`);
const cwd = path.join(runtime, '中文 空格目录');
mkdirSync(cwd, { recursive: true });
const catalog = new ModelCatalog(process.env.BRIDGE_CODEX_BIN ?? 'codex');
const capabilities = await catalog.list();
await catalog.validate('gpt-6-astra', 'high');
await catalog.validate('gpt-5.6-sol', 'low');
console.log(JSON.stringify({ phase: 'catalog', models: capabilities.models.filter(m => ['gpt-6-astra', 'gpt-5.6-sol'].includes(m.model)) }));
const manager = new SessionManager({ store: new RuntimeStore(runtime), catalog, executor: new CodexExecutor(process.env.BRIDGE_CODEX_BIN ?? 'codex'), permissionResolver: new PermissionResolver(process.env.BRIDGE_CODEX_BIN ?? 'codex'), allowedCwds: [cwd] });
const computer = new ComputerTools({ readRoots: [root], writeRoots: [root], runtime });
const httpServer = createHttpServer(manager, computer);
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
let client;
const report = { runtime, cwd, started_at: new Date().toISOString(), runs: [] };
async function connect() {
  client = new Client({ name: 'bridge-live-acceptance', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.ok(!result.isError, JSON.stringify(value));
  return value;
}
async function wait(run) {
  let cursor = 0;
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const waitMs = Math.min(60_000, Math.max(0, deadline - Date.now()));
    const output = await call('codex_get_output', { run_id: run.run_id, cursor, wait_ms: waitMs });
    cursor = output.next_cursor;
    if (!['queued', 'running', 'stopping'].includes(output.status)) {
      const state = await call('codex_get_status', { run_id: run.run_id });
      report.runs.push(state);
      console.log(JSON.stringify({ phase: 'finished', run_id: run.run_id, thread_id: state.session.codex_thread_id, model: state.run.model, reasoning: state.run.reasoning, status: state.run.status, error: state.run.error, reply: state.run.final_response }));
      assert.equal(state.run.status, 'completed', JSON.stringify(state.run.error));
      return state;
    }
  }
  throw Error('Live acceptance timed out');
}
try {
  await connect();
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 18);
  const query = await call('powershell', { cwd: root, query: 'version' });
  assert.ok(query.data.version.startsWith('7.'));
  const file = await call('filesystem_read', { path: path.join(root, 'README.md') });
  assert.ok(file.content.includes('Yuki Computer Agent'));
  report.computer = { powershell: query.data, read_bytes: file.bytes, tool_count: tools.tools.length };
  console.log(JSON.stringify({ phase: 'computer', ...report.computer }));
  const marker = '雪花-' + randomUUID().slice(0, 8);
  const literal = '中文路径 C:\\测试 空格\\文件.txt；双引号 "你好"；单引号 \'Emilia\'；$HOME；`tick`；$(not-a-command)';
  const input = { request_id: randomUUID(), cwd, sender: 'AI 助手', prompt: `这是 Bridge 的通信验收，勿调用任何工具、Skill、浏览器或执行命令，也不要读取文件。\r\n请记住本会话标记：${marker}\n请原样回显下一行文字，然后输出标记，不要添加解释：\n${literal}` };
  const startedAt = Date.now();
  const first = await call('codex_start_session', input);
  report.start_return_ms = Date.now() - startedAt;
  assert.ok(['queued', 'running'].includes(first.status));
  assert.ok(report.start_return_ms < 10_000);
  const replay = await call('codex_start_session', input);
  assert.equal(replay.run_id, first.run_id); assert.equal(replay.deduplicated, true);
  // Closing the MCP client must not stop the background run.
  await client.close(); await connect();
  const result1 = await wait(first);
  assert.ok(result1.run.final_response.includes(marker));
  assert.ok(result1.run.final_response.includes(literal));
  const second = await call('codex_send_message', { request_id: randomUUID(), session_id: first.session_id, sender: 'AI 助手', prompt: '不要调用工具，只回复上一轮约定的本会话标记。' });
  const result2 = await wait(second);
  assert.equal(result2.session.codex_thread_id, result1.session.codex_thread_id);
  assert.equal(result2.run.model, 'gpt-6-astra'); assert.equal(result2.run.reasoning, 'high');
  assert.ok(result2.run.final_response.includes(marker));
  const third = await call('codex_send_message', { request_id: randomUUID(), session_id: first.session_id, sender: 'AI 助手', model: 'gpt-5.6-sol', reasoning: 'low', prompt: '这是同一会话的模型切换验收。不要调用工具，只回复 SOL_OK 和之前约定的本会话标记。' });
  const result3 = await wait(third);
  assert.equal(result3.session.codex_thread_id, result1.session.codex_thread_id);
  assert.equal(result3.run.model, 'gpt-5.6-sol'); assert.equal(result3.run.reasoning, 'low');
  assert.ok(result3.run.final_response.includes('SOL_OK')); assert.ok(result3.run.final_response.includes(marker));
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message;
  console.error(error.message); process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(path.join(runtime, 'acceptance.json'), JSON.stringify(report, null, 2), 'utf8');
  await client?.close();
  await manager.close();
  await computer.close();
  await new Promise(resolve => { httpServer.close(resolve); httpServer.closeIdleConnections(); });
  console.log(JSON.stringify({ passed: report.passed, report: path.join(runtime, 'acceptance.json') }));
}
