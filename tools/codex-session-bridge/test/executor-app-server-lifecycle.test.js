import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexExecutor } from '../src/executor.js';
import { BridgeError } from '../src/errors.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const oldTurn = '33333333-3333-4333-8333-333333333333';
const tick = () => new Promise(resolve => setImmediate(resolve));
const tokens = (input, output) => ({ inputTokens: input, outputTokens: output,
  cachedInputTokens: input / 2, cacheWriteInputTokens: input / 10, reasoningOutputTokens: output / 2 });

// Only protocol streams are simulated; no model or OS process is launched.
function harness({ onEvent = () => {}, terminate = async () => 'succeeded', resume = false,
  hold = null, replay = null } = {}) {
  const sent = [], events = [], completions = [], failures = [], stderr = [], order = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 123456789; child.exitCode = null; child.signalCode = null;
  const notify = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n');
  const reply = message => {
    const result = message.method.startsWith('thread/') ? { thread: { id: threadId } }
      : message.method === 'turn/start' ? { turn: { id: turnId, status: 'inProgress' } } : {};
    child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
    if (message.method === 'thread/resume' && replay) notify('thread/tokenUsage/updated', replay);
    if (message.method === 'turn/start') notify('turn/started', { turn: { id: turnId } });
  };
  child.stdin = new Writable({ write(bytes, _encoding, next) {
    const message = JSON.parse(bytes.toString()); sent.push(message);
    if (message.method && message.method !== hold) queueMicrotask(() => reply(message));
    next();
  } });
  const executor = new CodexExecutor('fixture', () => {
    queueMicrotask(() => child.emit('spawn')); return child;
  }, () => ({ executable: 'fixture' }), terminate);
  const session = { cwd: process.cwd(), codex_thread_id: resume ? threadId : null, permissions: {
    version: 1, kind: 'native', stored: true, sandbox_mode: 'danger-full-access',
    approval_policy: 'on-request', approvals_reviewer: 'user', workspace_write: null,
    source: 'fixture', resolved_at: '2026-10-04T00:00:00.000Z',
  } };
  const handle = executor.start({ model: 'fixture', reasoning: 'high' }, session, 'fixture', {
    onSpawn() {}, onStopping() { order.push('stopping'); },
    onStopFailed(error) { failures.push(error); },
    onStderr(line) { stderr.push(line); order.push('stderr'); },
    onEvent(event) { events.push(event); order.push(event.type); onEvent(event); },
    onDone(result) { completions.push(result); order.push('done'); },
  });
  const close = async () => {
    child.exitCode = 0; child.emit('exit', 0, null);
    child.stdout.end(); child.stderr.end(); await tick();
    child.emit('close', 0, null); await tick();
  };
  const complete = () => notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
  const update = (total, last, id = turnId) => notify('thread/tokenUsage/updated', {
    threadId, turnId: id, tokenUsage: { total, last, modelContextWindow: 10000 },
  });
  return { handle, child, sent, events, completions, failures, stderr, order, reply, close, complete, update };
}

test('SP-1: failed explicit stop retains ownership until close and reports the failure', async () => {
  const h = harness({ terminate: async () => { throw new BridgeError('STOP_FAILED', 'fixture denied'); } });
  await tick();
  await assert.rejects(h.handle.stop(), { code: 'STOP_FAILED' });
  assert.equal(h.child.exitCode, null);
  assert.equal(h.completions.length, 0);
  assert.equal(h.failures[0].code, 'STOP_FAILED');
  await h.close();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].error.code, 'STOP_FAILED');
});

test('SP-1: completed turn with failed termination cannot publish success', async () => {
  const h = harness({ terminate: async () => { throw new BridgeError('STOP_FAILED', 'fixture denied'); } });
  await tick(); h.complete(); await tick();
  assert.equal(h.completions.length, 0);
  assert.equal(h.failures[0].code, 'STOP_FAILED');
  assert.ok(h.order.includes('stopping'));
  await h.close();
  assert.equal(h.completions[0].error.code, 'STOP_FAILED');
});

test('SP-1: onDone waits for tree-stop confirmation, close and trailing output exactly once', async () => {
  let release;
  const h = harness({ terminate: () => new Promise(resolve => { release = resolve; }) });
  await tick(); h.complete(); await tick();
  assert.equal(h.completions.length, 0);
  h.child.stdout.write(JSON.stringify({ method: 'item/completed', params: {
    item: { type: 'agentMessage', id: 'tail', text: 'tail' },
  } })); // Final JSONL fragment has no newline.
  h.child.stderr.write('tail diagnostic');
  await h.close();
  assert.equal(h.completions.length, 0);
  release('succeeded'); await tick();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].code, 0);
  assert.equal(h.events.at(-1).item.text, 'tail');
  assert.deepEqual(h.stderr, ['tail diagnostic']);
  assert.equal(h.order.at(-1), 'done');
  await h.handle.stop();
  assert.equal(h.completions.length, 1);
});

test('SP-1: successful tree-stop does not finish before exit and output drain', async () => {
  const h = harness(); await tick(); h.complete(); await tick();
  assert.equal(h.completions.length, 0);
  h.child.exitCode = 0; h.child.emit('exit', 0, null); await tick();
  assert.equal(h.completions.length, 0);
  h.child.stderr.write('last output');
  await h.close();
  assert.equal(h.completions.length, 1);
  assert.deepEqual(h.stderr, ['last output']);
  assert.equal(h.order.at(-1), 'done');
});

for (const code of ['THREAD_MISMATCH', 'INVALID_THREAD_ID', 'RECORD_FAILED']) {
  test(`SP-2: ${code} in thread guard prevents turn/start during delayed termination`, async () => {
    const h = harness({ resume: true, onEvent(event) {
      if (event.type === 'thread.started') throw new BridgeError(code, 'fixture rejected');
    } });
    await tick();
    assert.equal(h.sent.some(message => message.method === 'turn/start'), false);
    assert.equal(h.completions.length, 0);
    await h.close();
    assert.equal(h.completions[0].error.code, code);
  });
}

test('SP-2: stop while initialize is pending fences all later startup RPCs', async () => {
  const h = harness({ hold: 'initialize' }); await tick();
  const stopping = h.handle.stop();
  h.reply(h.sent.find(message => message.method === 'initialize')); await tick();
  assert.deepEqual(h.sent.map(message => message.method), ['initialize']);
  await h.close(); await stopping;
});

test('SP-3: a fresh run reports all requests, ignoring duplicate cumulative updates', async () => {
  const h = harness(); await tick();
  h.update(tokens(100, 10), tokens(100, 10));
  h.update(tokens(300, 30), tokens(200, 20));
  h.update(tokens(300, 30), tokens(200, 20));
  h.complete(); await h.close();
  assert.deepEqual(h.events.find(event => event.type === 'turn.completed').usage, {
    input_tokens: 300, cached_input_tokens: 150, cache_write_input_tokens: 30,
    output_tokens: 30, reasoning_output_tokens: 15,
  });
});

test('SP-3: resume subtracts replayed historical total and does not charge replay or duplicates', async () => {
  const h = harness({ resume: true, replay: { threadId, turnId: oldTurn,
    tokenUsage: { total: tokens(1000, 100), last: tokens(400, 40) },
  } }); await tick();
  h.update(tokens(1100, 110), tokens(100, 10));
  h.update(tokens(1300, 130), tokens(200, 20));
  h.update(tokens(1000, 100), tokens(400, 40), oldTurn);
  h.update(tokens(1300, 130), tokens(200, 20));
  h.complete(); await h.close();
  assert.deepEqual(h.events.find(event => event.type === 'turn.completed').usage, {
    input_tokens: 300, cached_input_tokens: 150, cache_write_input_tokens: 30,
    output_tokens: 30, reasoning_output_tokens: 15,
  });
});

test('SP-3: resume without a replay derives the historical base from the first request', async () => {
  const h = harness({ resume: true }); await tick();
  h.update(tokens(1100, 110), tokens(100, 10));
  h.update(tokens(1300, 130), tokens(200, 20));
  h.complete(); await h.close();
  assert.equal(h.events.find(event => event.type === 'turn.completed').usage.input_tokens, 300);
});
