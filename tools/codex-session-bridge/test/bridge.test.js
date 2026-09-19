import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
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
const until = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for test state.');
};
class FakePermissionResolver {
  constructor() {
    this.calls = [];
    this.snapshot = {
      version: 1, kind: 'native', stored: true,
      sandbox_mode: 'danger-full-access', approval_policy: 'on-request', approvals_reviewer: 'user',
      workspace_write: null, source: 'fake', resolved_at: new Date().toISOString(),
    };
  }
  async resolve(cwd, selection) {
    this.calls.push({ cwd, selection: selection ? structuredClone(selection) : null });
    const snapshot = structuredClone(this.snapshot);
    if (selection?.sandbox_mode) snapshot.sandbox_mode = selection.sandbox_mode;
    if (selection?.approval_policy) snapshot.approval_policy = selection.approval_policy;
    if (selection?.approvals_reviewer) snapshot.approvals_reviewer = selection.approvals_reviewer;
    snapshot.workspace_write = snapshot.sandbox_mode === 'workspace-write'
      ? { writable_roots: [], network_access: false, exclude_slash_tmp: false, exclude_tmpdir_env_var: false }
      : null;
    snapshot.source = selection ? 'explicit_fake' : 'fake';
    return snapshot;
  }
}
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
class FakeTimers {
  nextId = 1;
  scheduled = new Map();
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.scheduled.set(id, { callback, delay });
    return id;
  };
  clearTimeout = id => { this.scheduled.delete(id); };
  fire(delay) {
    const entries = [...this.scheduled.entries()].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of entries) {
      this.scheduled.delete(id);
      timer.callback();
    }
  }
}
function setup(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const cwd = path.join(root, '允许 中文 空格'); mkdirSync(cwd);
  const runtime = path.join(root, 'runtime');
  const catalog = new ModelCatalog();
  catalog.snapshot = { checked_at: new Date().toISOString(), models: [
    { model: 'gpt-6-astra', reasoning: ['low', 'high', 'ultra'] },
    { model: 'gpt-5.6-sol', reasoning: ['low', 'medium', 'high'] },
  ] };
  const executor = new FakeExecutor();
  const permissionResolver = new FakePermissionResolver();
  const store = new RuntimeStore(runtime);
  const manager = new SessionManager({ store, catalog, executor, permissionResolver, allowedCwds: [cwd], ...options });
  t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });
  const input = () => ({ cwd, request_id: randomUUID(), prompt: '你好\r\n"引号" $HOME `tick` C:\\中文 空格\\a.txt', sender: 'AI 助手' });
  return { root, cwd, runtime, catalog, executor, permissionResolver, store, manager, input };
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
  assert.equal(c.run_id, d.run_id); assert.equal(c.model, 'gpt-5.6-sol'); assert.equal(c.reasoning, 'medium');
  await tick(); executor.complete(1);
  const e = await manager.send({ ...nextInput, request_id: randomUUID(), model: 'gpt-5.6-sol', reasoning: 'low' });
  await tick(); executor.complete(2);
  assert.equal(manager.session(a.session_id).codex_thread_id, threadId);
  assert.equal(manager.session(a.session_id).model, 'gpt-5.6-sol');
  assert.equal(manager.session(a.session_id).reasoning, 'low');
  const replay = await manager.send(nextInput); assert.equal(replay.run_id, c.run_id);
  assert.equal(manager.status({ run_id: e.run_id }).run.status, 'completed');
  const events = await manager.output({ run_id: a.run_id, cursor: 0, limit: 1 });
  assert.equal(events.next_cursor, 1); assert.equal(events.has_more, true);
  assert.equal(events.return_reason, 'events');
  assert.equal(events.events[0].data.text, message.prompt);
});

test('output wait wakes every observer on the next durable event without losing a same-turn append', async t => {
  const timers = new FakeTimers();
  const { manager, executor, input } = setup(t, { timers });
  const started = await manager.start(input());
  await tick();
  const cursor = manager.run(started.run_id).event_count;
  const first = manager.output({ run_id: started.run_id, cursor, wait_ms: 60_000 });
  const second = manager.output({ run_id: started.run_id, cursor, wait_ms: 60_000 });

  executor.calls[0].callbacks.onStderr('durable progress');
  timers.fire(60_000);
  for (const pending of [first, second]) {
    const result = await pending;
    assert.equal(result.return_reason, 'events');
    assert.deepEqual(result.events.map(event => event.type), ['stderr']);
    assert.equal(result.next_cursor, cursor + 1);
  }
  assert.equal(timers.scheduled.size, 0);
  manager.stop(started.session_id);
});

test('aborting an output observation removes its waiter without stopping the run', async t => {
  const timers = new FakeTimers();
  const { manager, input } = setup(t, { timers });
  const started = await manager.start(input());
  await tick();
  const controller = new AbortController();
  const cursor = manager.run(started.run_id).event_count;
  const pending = manager.output({ run_id: started.run_id, cursor, wait_ms: 60_000 }, { signal: controller.signal });

  controller.abort();
  timers.fire(60_000);
  await assert.rejects(pending, { code: 'OBSERVATION_CANCELLED' });
  assert.equal(timers.scheduled.size, 0);
  assert.equal(manager.run(started.run_id).status, 'running');
  manager.stop(started.session_id);
});

test('manager close wakes output observers through the stopped lifecycle event', async t => {
  const timers = new FakeTimers();
  const { manager, input } = setup(t, { timers });
  const started = await manager.start(input());
  await tick();
  const cursor = manager.run(started.run_id).event_count;
  const pending = manager.output({ run_id: started.run_id, cursor, wait_ms: 60_000 });
  await manager.close();
  const result = await pending;
  assert.equal(result.return_reason, 'events');
  assert.equal(result.status, 'stopped');
  assert.equal(result.events.at(-1).type, 'run.stopped');
  assert.equal(timers.scheduled.size, 0);
});

test('output wait separates elapsed observations from stop, completion and hard-timeout lifecycle events', async t => {
  const timers = new FakeTimers();
  const { manager, executor, input } = setup(t, { timers });

  const stopped = await manager.start(input());
  await tick();
  let cursor = manager.run(stopped.run_id).event_count;
  const elapsed = manager.output({ run_id: stopped.run_id, cursor, wait_ms: 60_000 });
  timers.fire(60_000);
  assert.deepEqual(await elapsed, {
    run_id: stopped.run_id, status: 'running', events: [], next_cursor: cursor,
    has_more: false, final_response: null, return_reason: 'wait_elapsed',
  });
  assert.equal(manager.run(stopped.run_id).status, 'running');

  const stoppedObservation = manager.output({ run_id: stopped.run_id, cursor, wait_ms: 60_000 });
  manager.stop(stopped.session_id);
  const stoppedResult = await stoppedObservation;
  assert.equal(stoppedResult.return_reason, 'events');
  assert.equal(stoppedResult.status, 'stopped');
  assert.equal(stoppedResult.events.at(-1).type, 'run.stopped');
  cursor = stoppedResult.next_cursor;
  const terminal = await manager.output({ run_id: stopped.run_id, cursor, wait_ms: 60_000 });
  assert.equal(terminal.return_reason, 'terminal');
  assert.equal(terminal.events.length, 0);

  const completed = await manager.start(input());
  await tick();
  cursor = manager.run(completed.run_id).event_count;
  const completedObservation = manager.output({ run_id: completed.run_id, cursor, wait_ms: 60_000 });
  executor.complete(1, 'finished through observation');
  const completedResult = await completedObservation;
  assert.equal(completedResult.return_reason, 'events');
  assert.equal(completedResult.status, 'completed');
  assert.equal(completedResult.final_response, 'finished through observation');

  const timedOut = await manager.start({ ...input(), timeout_ms: 1000 });
  await tick();
  cursor = manager.run(timedOut.run_id).event_count;
  const timeoutObservation = manager.output({ run_id: timedOut.run_id, cursor, wait_ms: 60_000 });
  timers.fire(1000);
  const timeoutResult = await timeoutObservation;
  assert.equal(timeoutResult.return_reason, 'events');
  assert.equal(timeoutResult.status, 'timed_out');
  assert.equal(manager.run(timedOut.run_id).error.code, 'RUN_TIMEOUT');
  assert.equal(timers.scheduled.size, 0);
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

test('permission snapshots freeze per session, explicit selection participates in idempotency, and old request hashes replay', async t => {
  const { manager, executor, permissionResolver, input } = setup(t);
  const message = input();
  const started = await manager.start(message);
  assert.equal(started.permissions.sandbox_mode, 'danger-full-access');
  assert.equal(permissionResolver.calls.length, 1);
  await tick(); executor.complete(0);

  permissionResolver.snapshot.sandbox_mode = 'read-only';
  permissionResolver.snapshot.approval_policy = 'never';
  const continued = await manager.send({ request_id: randomUUID(), session_id: started.session_id, prompt: 'continue frozen permissions' });
  assert.equal(continued.permissions.sandbox_mode, 'danger-full-access');
  await tick();
  assert.equal(executor.calls[1].session.permissions.sandbox_mode, 'danger-full-access');
  executor.complete(1);

  const explicitInput = { ...input(), permissions: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' } };
  const explicit = await manager.start(explicitInput);
  assert.equal(explicit.permissions.sandbox_mode, 'workspace-write');
  await assert.rejects(manager.start({ ...explicitInput, permissions: { sandbox_mode: 'read-only', approval_policy: 'never' } }), { code: 'REQUEST_ID_CONFLICT' });
  manager.stop(explicit.session_id);

  const legacyCompatible = input();
  const oldFingerprint = createHash('sha256').update(JSON.stringify(['start', legacyCompatible.cwd, legacyCompatible.prompt, legacyCompatible.sender ?? 'caller', legacyCompatible.model ?? null, legacyCompatible.reasoning ?? null, legacyCompatible.timeout_ms ?? null])).digest('hex');
  const accepted = await manager.start(legacyCompatible);
  manager.store.state.requests[legacyCompatible.request_id].fingerprint = oldFingerprint;
  manager.store.save();
  const replay = await manager.start(legacyCompatible);
  assert.equal(replay.run_id, accepted.run_id);
  assert.equal(replay.deduplicated, true);
  manager.stop(accepted.session_id);
});

test('legacy sessions keep the old read-only execution profile and never inherit current defaults', async t => {
  const { manager, executor, input } = setup(t);
  const started = await manager.start(input());
  await tick(); executor.complete(0);
  const session = manager.session(started.session_id);
  delete session.permissions;
  manager.store.save();
  const continued = await manager.send({ request_id: randomUUID(), session_id: session.id, prompt: 'legacy resume' });
  assert.equal(continued.permissions.kind, 'legacy');
  assert.equal(continued.permissions.sandbox_mode, 'read-only');
  assert.equal(continued.permissions.approval_policy, 'never');
  await tick();
  const call = executor.calls.at(-1);
  const args = execArguments(call.run, call.session);
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(args.includes('read-only'));
  executor.complete(executor.calls.length - 1);
});

test('old-format runtime fixture loads history, replays the old request hash and resumes without upgrading permissions', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-legacy-fixture-'));
  const cwd = path.join(root, '旧会话目录'); mkdirSync(cwd);
  const runtime = path.join(root, 'runtime'); mkdirSync(path.join(runtime, 'runs'), { recursive: true });
  const legacyInput = { cwd, request_id: 'legacy-request-001', prompt: 'legacy fixture start', sender: 'legacy caller' };
  const oldFingerprint = createHash('sha256').update(JSON.stringify([
    'start', legacyInput.cwd, legacyInput.prompt, legacyInput.sender, null, null, null,
  ])).digest('hex');
  const template = readFileSync(new URL('./fixtures/legacy-runtime/sessions.template.json', import.meta.url), 'utf8')
    .replace('__CWD__', cwd.replaceAll('\\', '\\\\'))
    .replace('__FINGERPRINT__', oldFingerprint);
  writeFileSync(path.join(runtime, 'sessions.json'), template, 'utf8');
  writeFileSync(
    path.join(runtime, 'runs', '22222222-2222-4222-8222-222222222222.jsonl'),
    readFileSync(new URL('./fixtures/legacy-runtime/runs/22222222-2222-4222-8222-222222222222.jsonl', import.meta.url), 'utf8'),
    'utf8',
  );

  const catalog = new ModelCatalog();
  catalog.snapshot = { checked_at: new Date().toISOString(), models: [{ model: 'gpt-6-astra', reasoning: ['high'] }] };
  const executor = new FakeExecutor();
  const permissionResolver = new FakePermissionResolver();
  const store = new RuntimeStore(runtime);
  const manager = new SessionManager({ store, catalog, executor, permissionResolver, allowedCwds: [cwd] });
  t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });

  const sessionId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const status = manager.status({ session_id: sessionId });
  assert.equal(status.session.permissions.kind, 'legacy');
  assert.equal(status.session.permissions.sandbox_mode, 'read-only');
  assert.equal(status.run.timeout_ms, 300_000);
  assert.equal((await manager.output({ run_id: runId })).final_response, 'legacy fixture reply');

  const replay = await manager.start(legacyInput);
  assert.equal(replay.run_id, runId);
  assert.equal(replay.deduplicated, true);
  assert.equal(permissionResolver.calls.length, 0);

  const continued = await manager.send({ request_id: randomUUID(), session_id: sessionId, prompt: 'legacy fixture continue' });
  assert.equal(continued.permissions.kind, 'legacy');
  await tick();
  const args = execArguments(executor.calls[0].run, executor.calls[0].session);
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(args.includes('read-only'));
  executor.complete(0);
  assert.equal(manager.status({ run_id: continued.run_id }).run.status, 'completed');
});

test('omitted timeout has no hard deadline while an explicit deadline retains RUN_TIMEOUT', async t => {
  const timers = new FakeTimers();
  const { manager, input } = setup(t, { timers });
  const unlimitedInput = input();
  const unlimited = await manager.start(unlimitedInput);
  assert.equal(unlimited.timeout_ms, null);
  assert.equal(manager.run(unlimited.run_id).timeout_ms, null);
  await tick();
  assert.equal(timers.scheduled.size, 0);
  timers.fire(180_000);
  timers.fire(300_000);
  assert.equal(manager.run(unlimited.run_id).status, 'running');
  assert.equal((await manager.start(unlimitedInput)).run_id, unlimited.run_id);
  await assert.rejects(manager.start({ ...unlimitedInput, timeout_ms: 1000 }), { code: 'REQUEST_ID_CONFLICT' });
  manager.stop(unlimited.session_id);

  const limited = await manager.start({ ...input(), timeout_ms: 1000 });
  assert.equal(limited.timeout_ms, 1000);
  await tick();
  assert.deepEqual([...timers.scheduled.values()].map(timer => timer.delay), [1000]);
  timers.fire(1000);
  await tick();
  assert.equal(manager.run(limited.run_id).status, 'timed_out');
  assert.equal(manager.run(limited.run_id).error.code, 'RUN_TIMEOUT');
});

test('stop, CLI failure and output limits have terminal states', async t => {
  const { manager, executor, input } = setup(t, { maxOutputBytes: 1024 });
  const queued = await manager.start(input()); manager.stop(queued.session_id);
  assert.equal(manager.run(queued.run_id).status, 'stopped');
  const active = await manager.start(input()); await tick(); manager.stop(active.session_id);
  await tick(); assert.equal(manager.run(active.run_id).status, 'stopped');
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
  const recovered = new SessionManager({ store: nextStore, catalog, executor: new FakeExecutor(), permissionResolver: new FakePermissionResolver(), allowedCwds: [cwd] });
  t.after(() => recovered.close());
  assert.equal((await recovered.start(message)).run_id, first.run_id);
  assert.equal((await recovered.output({ run_id: first.run_id })).final_response, '持久回复');
  // Simulate a persisted running state with no live process and an incomplete final JSONL record.
  const run = nextStore.state.runs[first.run_id]; run.status = 'running'; run.pid = null;
  nextStore.state.sessions[first.session_id].active_run_id = first.run_id;
  nextStore.save(); nextStore.close();
  const file = nextStore.eventFile(first.run_id);
  writeFileSync(file, readFileSync(file, 'utf8') + '{"partial":', 'utf8');
  const thirdStore = new RuntimeStore(runtime);
  const third = new SessionManager({ store: thirdStore, catalog, executor: new FakeExecutor(), permissionResolver: new FakePermissionResolver(), allowedCwds: [cwd] });
  assert.equal(third.run(first.run_id).status, 'interrupted');
  assert.equal(third.session(first.session_id).active_run_id, null);
  const interrupted = await third.output({ run_id: first.run_id });
  assert.ok(interrupted.events.at(-1).type === 'run.interrupted');
  const recoveredTerminal = await third.output({ run_id: first.run_id, cursor: interrupted.next_cursor, wait_ms: 60_000 });
  assert.equal(recoveredTerminal.return_reason, 'terminal');
  assert.equal(recoveredTerminal.status, 'interrupted');
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
  assert.throws(() => new SessionManager({ store: reopened, catalog, executor: new FakeExecutor(), permissionResolver: new FakePermissionResolver(), allowedCwds: [cwd] }), { code: 'ORPHAN_PROCESS' });
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
  assert.equal((await client.listTools()).tools.length, 8);
  const started = await client.callTool({ name: 'codex_start_session', arguments: input() });
  assert.equal(started.isError, undefined);
  const { run_id, session_id } = started.structuredContent;
  await client.close(); await tick(); executor.complete(0);
  const next = new Client({ name: 'reconnected', version: '1' });
  await next.connect(new StreamableHTTPClientTransport(url));
  const output = await next.callTool({ name: 'codex_get_output', arguments: { run_id } });
  assert.equal(output.structuredContent.final_response, '协作助手回复 🌸');
  const runCountBeforePermissionChange = Object.keys(manager.store.state.runs).length;
  const permissionChange = await next.callTool({ name: 'codex_send_message', arguments: {
    session_id, request_id: randomUUID(), prompt: 'must reject permission changes',
    permissions: { sandbox_mode: 'read-only', approval_policy: 'never' },
  } });
  assert.equal(permissionChange.isError, true);
  assert.equal(permissionChange.structuredContent.error.code, 'PERMISSION_CHANGE_REQUIRES_NEW_SESSION');
  assert.equal(Object.keys(manager.store.state.runs).length, runCountBeforePermissionChange);
  const invalid = await next.callTool({ name: 'codex_start_session', arguments: { ...input(), reasoning: 'imaginary' } });
  assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'UNSUPPORTED_REASONING');
  const forbidden = await fetch(url, { method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  await next.close();
});

test('MCP output wait exposes its schema and HTTP disconnect cancels only the observation', async t => {
  const timers = new FakeTimers();
  const { manager, executor, input } = setup(t, { timers });
  const server = createHttpServer(manager);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  let client = new Client({ name: 'wait-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url));
  const tools = await client.listTools();
  const outputTool = tools.tools.find(tool => tool.name === 'codex_get_output');
  assert.equal(outputTool.inputSchema.properties.wait_ms.type, 'integer');
  assert.equal(outputTool.inputSchema.properties.wait_ms.minimum, 0);
  assert.equal(outputTool.inputSchema.properties.wait_ms.maximum, 60_000);

  const started = await client.callTool({ name: 'codex_start_session', arguments: input() });
  const { run_id } = started.structuredContent;
  await tick();
  let cursor = manager.run(run_id).event_count;
  const elapsedCall = client.callTool({ name: 'codex_get_output', arguments: { run_id, cursor, wait_ms: 60_000 } });
  await until(() => timers.scheduled.size === 1);
  timers.fire(60_000);
  const elapsed = await elapsedCall;
  assert.equal(elapsed.structuredContent.return_reason, 'wait_elapsed');
  assert.equal(manager.run(run_id).status, 'running');

  const disconnectedCall = client.callTool({ name: 'codex_get_output', arguments: { run_id, cursor, wait_ms: 60_000 } });
  await until(() => timers.scheduled.size === 1);
  await client.close();
  client = null;
  await assert.rejects(disconnectedCall);
  await until(() => timers.scheduled.size === 0);
  assert.equal(manager.run(run_id).status, 'running');

  const reconnected = new Client({ name: 'wait-test-reconnected', version: '1' });
  await reconnected.connect(new StreamableHTTPClientTransport(url));
  executor.calls[0].callbacks.onStderr('after reconnect');
  const output = await reconnected.callTool({ name: 'codex_get_output', arguments: { run_id, cursor } });
  assert.equal(output.structuredContent.return_reason, 'events');
  assert.equal(output.structuredContent.events.at(-1).data.text, 'after reconnect');
  cursor = output.structuredContent.next_cursor;
  manager.stop(started.structuredContent.session_id);
  const terminal = await reconnected.callTool({ name: 'codex_get_output', arguments: { run_id, cursor, wait_ms: 60_000 } });
  assert.equal(terminal.structuredContent.return_reason, 'events');
  const drained = await reconnected.callTool({ name: 'codex_get_output', arguments: { run_id, cursor: terminal.structuredContent.next_cursor, wait_ms: 60_000 } });
  assert.equal(drained.structuredContent.return_reason, 'terminal');
  await reconnected.close();
});

test('executor parses native-process JSONL and reports malformed output and spawn failure', async () => {
  const payload = '中文 🌸\n$HOME `test` "quoted" C:\\空 格\\a.txt';
  const script = 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{console.log(JSON.stringify({type:"echo",text:s}));process.stderr.write("stderr only");});';
  const executor = new CodexExecutor(process.execPath, (_command, args, options) => {
    assert.equal(args.at(-1), '-');
    assert.ok(!args.includes(payload));
    return spawnDirect(process.execPath, ['-e', script], options);
  });
  const events = []; const stderr = [];
  const done = await new Promise(resolve => executor.start({ model: 'gpt-6-astra', reasoning: 'high' }, { cwd: process.cwd(), codex_thread_id: null }, payload, { onEvent: e => events.push(e), onStderr: s => stderr.push(s), onSpawn: () => {}, onDone: resolve }));
  assert.equal(done.code, 0); assert.equal(events[0].text, payload); assert.deepEqual(stderr, ['stderr only']);
  const malformed = new CodexExecutor(process.execPath, (_command, _args, options) => spawnDirect(process.execPath, ['-e', 'process.stdout.write("not-json\\n");setInterval(()=>{},1000)'], options));
  const bad = await new Promise(resolve => malformed.start({ model: 'gpt-6-astra', reasoning: 'high' }, { cwd: process.cwd(), codex_thread_id: null }, 'test', { onEvent: () => {}, onStderr: () => {}, onSpawn: () => {}, onDone: resolve }));
  assert.equal(bad.error.code, 'INVALID_CODEX_OUTPUT');
  // Simulate removal between discovery and spawn without using a real install.
  const missing = new CodexExecutor('nonexistent-bridge-executable-12345', spawnDirect, executable => ({ executable }));
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
