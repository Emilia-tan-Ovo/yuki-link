import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RuntimeStore } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { ModelCatalog } from '../src/catalog.js';
import { CodexExecutor, execArguments } from '../src/executor.js';
import { readLines, spawnDirect, stopProcessTree, isProcessAlive } from '../src/process.js';
import { createHttpServer } from '../src/http.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
class FakeExecutor {
  calls = [];
  start(run, session, prompt, callbacks) {
    const call = { run, session, prompt, callbacks };
    this.calls.push(call);
    callbacks.onSpawn(null);
    return { stop: async () => { callbacks.onDone({ code: 1, signal: null, error: null }); } };
  }
  complete(index, text = '协作助手回复 🌸') {
    const { session, callbacks } = this.calls[index];
    callbacks.onEvent({ type: 'thread.started', thread_id: session.codex_thread_id ?? randomUUID() });
    callbacks.onEvent({ type: 'item.completed', item: { type: 'agent_message', text } });
    callbacks.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
    callbacks.onDone({ code: 0, signal: null, error: null });
  }
}
function setup(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const cwd = path.join(root, '允许 中文 空格'); mkdirSync(cwd);
  const runtime = path.join(root, 'runtime');
  const catalog = new ModelCatalog();
  catalog.snapshot = { checked_at: new Date().toISOString(), models: [
    { model: 'gpt-6-astra', reasoning: ['low', 'high', 'ultra'] },
    { model: 'gpt-5.6-sol', reasoning: ['low', 'high'] },
  ] };
  const executor = new FakeExecutor();
  const store = new RuntimeStore(runtime);
  const manager = new SessionManager({ store, catalog, executor, allowedCwds: [cwd], ...options });
  t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });
  const input = () => ({ cwd, request_id: randomUUID(), prompt: '你好\r\n"引号" $HOME `tick` C:\\中文 空格\\a.txt', sender: 'AI 助手' });
  return { root, cwd, runtime, catalog, executor, store, manager, input };
}

test('async acceptance, concurrent dedup, session lock, inheritance and explicit model changes', async t => {
  const { manager, executor, input } = setup(t);
  const message = input();
  const [a, b] = await Promise.all([manager.start(message), manager.start(message)]);
  assert.equal(a.run_id, b.run_id);
  assert.equal(a.status, 'queued'); assert.equal(b.deduplicated, true);
  assert.equal(executor.calls.length, 0);
  await tick(); assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].prompt, message.prompt);
  await assert.rejects(manager.send({ request_id: randomUUID(), session_id: a.session_id, prompt: '冲突' }), { code: 'SESSION_BUSY' });
  executor.complete(0);
  const threadId = manager.session(a.session_id).codex_thread_id;
  const nextInput = { request_id: randomUUID(), session_id: a.session_id, prompt: '继续' };
  const [c, d] = await Promise.all([manager.send(nextInput), manager.send(nextInput)]);
  assert.equal(c.run_id, d.run_id); assert.equal(c.model, 'gpt-6-astra'); assert.equal(c.reasoning, 'high');
  await tick(); executor.complete(1);
  const e = await manager.send({ ...nextInput, request_id: randomUUID(), model: 'gpt-5.6-sol', reasoning: 'low' });
  await tick(); executor.complete(2);
  assert.equal(manager.session(a.session_id).codex_thread_id, threadId);
  assert.equal(manager.session(a.session_id).model, 'gpt-5.6-sol');
  assert.equal(manager.session(a.session_id).reasoning, 'low');
  const replay = await manager.send(nextInput); assert.equal(replay.run_id, c.run_id);
  assert.equal(manager.status({ run_id: e.run_id }).run.status, 'completed');
  const events = manager.output({ run_id: a.run_id, cursor: 0, limit: 1 });
  assert.equal(events.next_cursor, 1); assert.equal(events.has_more, true);
  assert.equal(events.events[0].data.text, message.prompt);
});

test('invalid configurations, path escape, conflicting idempotency keys and prototype-like keys', async t => {
  const { manager, catalog, input, cwd, root } = setup(t);
  await assert.rejects(manager.start({ ...input(), model: 'invented' }), { code: 'UNSUPPORTED_MODEL' });
  await assert.rejects(manager.start({ ...input(), reasoning: 'none' }), { code: 'UNSUPPORTED_REASONING' });
  await assert.rejects(manager.start({ ...input(), cwd: root }), { code: 'CWD_NOT_ALLOWED' });
  const sibling = cwd + '-outside'; mkdirSync(sibling);
  await assert.rejects(manager.start({ ...input(), cwd: sibling }), { code: 'CWD_NOT_ALLOWED' });
  const link = path.join(cwd, 'escape'); symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.start({ ...input(), cwd: link }), { code: 'CWD_NOT_ALLOWED' });
  const message = { ...input(), request_id: '__proto__' };
  const result = await manager.start(message);
  assert.equal((await manager.start(message)).run_id, result.run_id);
  await assert.rejects(manager.start({ ...message, prompt: 'changed' }), { code: 'REQUEST_ID_CONFLICT' });
  manager.stop(result.session_id);
  catalog.snapshot.models.push({ model: 'future-model', reasoning: ['future-effort'] });
  const future = await manager.start({ ...input(), model: 'future-model', reasoning: 'future-effort' });
  assert.equal(future.model, 'future-model'); manager.stop(future.session_id);
});

test('stop, timeout, CLI failure and output limits have terminal states', async t => {
  const { manager, executor, input } = setup(t, { defaultTimeoutMs: 30, maxOutputBytes: 1024 });
  const queued = await manager.start(input()); manager.stop(queued.session_id);
  assert.equal(manager.run(queued.run_id).status, 'stopped');
  const active = await manager.start(input()); await tick(); manager.stop(active.session_id);
  await tick(); assert.equal(manager.run(active.run_id).status, 'stopped');
  const timeout = await manager.start(input()); await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(manager.run(timeout.run_id).status, 'timed_out');
  const failed = await manager.start(input()); await tick();
  executor.calls.at(-1).callbacks.onDone({ code: 7, signal: null, error: null });
  assert.equal(manager.run(failed.run_id).status, 'failed');
  assert.equal(manager.run(failed.run_id).exit_code, 7);
  const limited = await manager.start(input()); await tick();
  executor.calls.at(-1).callbacks.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: '大'.repeat(2000) } });
  await tick(); assert.equal(manager.run(limited.run_id).error.code, 'OUTPUT_LIMIT');
});

test('durable results and idempotency survive a bridge restart; incomplete runs are not replayed', async t => {
  const { manager, executor, store, runtime, catalog, cwd, input } = setup(t);
  const message = input(); const first = await manager.start(message); await tick(); executor.complete(0, '持久回复');
  await manager.close();
  const nextStore = new RuntimeStore(runtime);
  const recovered = new SessionManager({ store: nextStore, catalog, executor: new FakeExecutor(), allowedCwds: [cwd] });
  t.after(() => recovered.close());
  assert.equal((await recovered.start(message)).run_id, first.run_id);
  assert.equal(recovered.output({ run_id: first.run_id }).final_response, '持久回复');
  // Simulate a persisted running state with no live process and an incomplete final JSONL record.
  const run = nextStore.state.runs[first.run_id]; run.status = 'running'; run.pid = null;
  nextStore.state.sessions[first.session_id].active_run_id = first.run_id;
  nextStore.save(); nextStore.close();
  const file = nextStore.eventFile(first.run_id);
  writeFileSync(file, readFileSync(file, 'utf8') + '{"partial":', 'utf8');
  const thirdStore = new RuntimeStore(runtime);
  const third = new SessionManager({ store: thirdStore, catalog, executor: new FakeExecutor(), allowedCwds: [cwd] });
  assert.equal(third.run(first.run_id).status, 'interrupted');
  assert.equal(third.session(first.session_id).active_run_id, null);
  assert.ok(third.output({ run_id: first.run_id }).events.at(-1).type === 'run.interrupted');
  await third.close();
  assert.equal(store.state.runs[first.run_id].status, 'completed');
});

test('runtime lock prevents a second writer and recovery refuses live orphan PIDs', async t => {
  const { store, runtime, manager, input, catalog, cwd } = setup(t);
  assert.throws(() => new RuntimeStore(runtime), { code: 'RUNTIME_LOCKED' });
  const a = await manager.start(input()); manager.stop(a.session_id);
  const run = store.state.runs[a.run_id]; run.status = 'running'; run.pid = process.pid;
  store.save(); store.close();
  const reopened = new RuntimeStore(runtime);
  assert.throws(() => new SessionManager({ store: reopened, catalog, executor: new FakeExecutor(), allowedCwds: [cwd] }), { code: 'ORPHAN_PROCESS' });
  reopened.close(); run.status = 'stopped';
});

test('UTF-8 split byte streams, multiline input and shell metacharacters round-trip through a native process', async () => {
  const payload = '用户 🌸\r\n"double" \'single\' $HOME `tick` $(never) & | C:\\中文 空格\\文件.txt';
  const child = spawnDirect(process.execPath, ['-e', 'process.stdin.on("data",b=>process.stdout.write(b));process.stdin.on("end",()=>process.stderr.write("独立错误流"));']);
  const chunks = []; const stderr = [];
  child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => stderr.push(b));
  child.stdin.end(payload, 'utf8');
  await new Promise(resolve => child.on('close', resolve));
  assert.equal(Buffer.concat(chunks).toString('utf8'), payload);
  assert.equal(Buffer.concat(stderr).toString('utf8'), '独立错误流');
  const stream = new PassThrough(); const lines = [];
  readLines(stream, line => lines.push(JSON.parse(line)), error => { throw error; });
  const bytes = Buffer.from(JSON.stringify({ text: payload }) + '\r\n');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end(); await tick(); assert.equal(lines[0].text, payload);
  const args = execArguments({ model: 'gpt-6-astra', reasoning: 'high' }, { cwd: 'C:\\中文 空格', codex_thread_id: 'test-id' });
  assert.deepEqual(args.slice(-3), ['resume', 'test-id', '-']);
  assert.ok(args.includes('model_reasoning_effort="high"')); assert.ok(!args.includes('--last'));
});

test('real MCP HTTP clients reconnect to durable runs; host/origin checks and explicit errors work', async t => {
  const { manager, executor, input } = setup(t);
  const server = createHttpServer(manager);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url));
  assert.equal((await client.listTools()).tools.length, 6);
  const started = await client.callTool({ name: 'codex_start_session', arguments: input() });
  assert.equal(started.isError, undefined);
  const { run_id } = started.structuredContent;
  await client.close(); await tick(); executor.complete(0);
  const next = new Client({ name: 'reconnected', version: '1' });
  await next.connect(new StreamableHTTPClientTransport(url));
  const output = await next.callTool({ name: 'codex_get_output', arguments: { run_id } });
  assert.equal(output.structuredContent.final_response, '协作助手回复 🌸');
  const invalid = await next.callTool({ name: 'codex_start_session', arguments: { ...input(), reasoning: 'imaginary' } });
  assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'UNSUPPORTED_REASONING');
  const forbidden = await fetch(url, { method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  await next.close();
});

test('executor parses native-process JSONL and reports malformed output and spawn failure', async () => {
  const payload = '中文 🌸\n$HOME `test` "quoted" C:\\空 格\\a.txt';
  const script = 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{console.log(JSON.stringify({type:"echo",text:s}));process.stderr.write("stderr only");});';
  const executor = new CodexExecutor('codex', (_command, args, options) => {
    assert.equal(args.at(-1), '-');
    assert.ok(!args.includes(payload));
    return spawnDirect(process.execPath, ['-e', script], options);
  });
  const events = []; const stderr = [];
  const done = await new Promise(resolve => executor.start({ model: 'gpt-6-astra', reasoning: 'high' }, { cwd: process.cwd(), codex_thread_id: null }, payload, { onEvent: e => events.push(e), onStderr: s => stderr.push(s), onSpawn: () => {}, onDone: resolve }));
  assert.equal(done.code, 0); assert.equal(events[0].text, payload); assert.deepEqual(stderr, ['stderr only']);
  const malformed = new CodexExecutor('codex', (_command, _args, options) => spawnDirect(process.execPath, ['-e', 'process.stdout.write("not-json\\n");setInterval(()=>{},1000)'], options));
  const bad = await new Promise(resolve => malformed.start({ model: 'gpt-6-astra', reasoning: 'high' }, { cwd: process.cwd(), codex_thread_id: null }, 'test', { onEvent: () => {}, onStderr: () => {}, onSpawn: () => {}, onDone: resolve }));
  assert.equal(bad.error.code, 'INVALID_CODEX_OUTPUT');
  const missing = new CodexExecutor('nonexistent-bridge-executable-12345');
  const failed = await new Promise(resolve => missing.start({ model: 'gpt-6-astra', reasoning: 'high' }, { cwd: process.cwd(), codex_thread_id: null }, 'test', { onEvent: () => {}, onStderr: () => {}, onSpawn: () => {}, onDone: resolve }));
  assert.equal(failed.error.code, 'SPAWN_FAILED');
});

test('stopProcessTree terminates an owned native process and its child', async () => {
  const script = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);';
  const parent = spawnDirect(process.execPath, ['-e', script], { detached: process.platform !== 'win32' });
  parent.stdin.end(); parent.stderr.resume();
  const childPid = await new Promise(resolve => readLines(parent.stdout, line => resolve(Number(line)), error => { throw error; }));
  assert.ok(isProcessAlive(childPid));
  const closed = new Promise(resolve => parent.once('close', resolve));
  await stopProcessTree(parent); await closed;
  const deadline = Date.now() + 2000;
  while (isProcessAlive(childPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(isProcessAlive(childPid), false);
});

test('append/save failures roll back acceptance so identical requests can safely retry', async t => {
  for (const failurePoint of ['append', 'save']) {
    const { manager, executor, store, input } = setup(t);
    const message = input();
    const original = store[failurePoint].bind(store);
    store[failurePoint] = () => { throw new Error('Simulated disk failure'); };
    await assert.rejects(manager.start(message), { code: 'PERSISTENCE_FAILED' });
    assert.equal(Object.keys(store.state.runs).length, 0);
    assert.equal(Object.hasOwn(store.state.requests, message.request_id), false);
    await tick(); assert.equal(executor.calls.length, 0);
    store[failurePoint] = original;
    const started = await manager.start(message);
    assert.equal(started.deduplicated, false); await tick(); executor.complete(0);
    const session = manager.session(started.session_id);
    const next = { request_id: randomUUID(), session_id: session.id, prompt: 'retry send' };
    store[failurePoint] = () => { throw new Error('Simulated disk failure'); };
    await assert.rejects(manager.send(next), { code: 'PERSISTENCE_FAILED' });
    assert.equal(session.active_run_id, null);
    assert.equal(session.last_run_id, started.run_id);
    store[failurePoint] = original;
    const retried = await manager.send(next);
    assert.equal(retried.deduplicated, false); await tick(); executor.complete(1);
    assert.equal(executor.calls.length, 2);
  }
});

test('stale lock acquisition never removes or replaces another starter lock', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-stale-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, 'bridge.lock');
  const oldLock = JSON.stringify({ pid: -1, token: 'stale-token' });
  writeFileSync(lockFile, oldLock, 'utf8');
  assert.throws(() => new RuntimeStore(root), { code: 'STALE_RUNTIME_LOCK' });
  assert.throws(() => new RuntimeStore(root), { code: 'STALE_RUNTIME_LOCK' });
  assert.equal(readFileSync(lockFile, 'utf8'), oldLock);
});
