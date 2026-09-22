import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnDirect } from '../src/process.js';
import { connectTasks, processFixture, waitTask, pause } from './helpers/task-fixture.js';

test('MCP starts an owned task and retains natural results independently of models', async t => {
  const { call, workspace, activity } = await connectTasks(t, {
    spawnProcess: () => processFixture(p => { p.stdout.write('你好\n'); p.stderr.write('diagnostic\n'); p.endProcess(0); }),
    stopProcess: async p => { p.endProcess(1); return 'succeeded'; },
  });
  const info = await call('task_status');
  assert.equal(info.isError, false);
  const started = await call('task_start', { service_epoch: info.service_epoch, request_id: randomUUID(), cwd: workspace, script: "'你好'" });
  assert.equal(started.isError, false);
  assert.equal(started.deduplicated, false);
  const result = await waitTask(call, started.task_id, s => s.status === 'completed');
  assert.equal(result.exit_code, 0);
  assert.equal(result.root_state, 'exited');
  const output = await call('task_output', { task_id: started.task_id });
  assert.deepEqual(output.events.map(({ stream, text }) => ({ stream, text })), [
    { stream: 'stdout', text: '你好\n' }, { stream: 'stderr', text: 'diagnostic\n' },
  ]);
  assert.equal(output.next_cursor, 2);
  assert.equal(output.has_more, false);
  assert.equal(activity().computer, 0);
});

test('line events preserve split UTF-8, redact split tokens, and expose only immutable complete lines', async t => {
  let child;
  const { call, workspace } = await connectTasks(t, {
    spawnProcess: () => child = processFixture(), stopProcess: async p => { p.endProcess(1); return 'succeeded'; },
  }, () => child.endProcess());
  const { service_epoch } = await call('task_status');
  const start = await call('task_start', { service_epoch, request_id: 'lines', cwd: workspace, script: "'lines'" });
  child.stdout.write(Buffer.from([0xe4, 0xb8]));
  child.stdout.write(Buffer.concat([Buffer.from([0xad]), Buffer.from(' sk-abcdef')]));
  assert.deepEqual((await call('task_output', { task_id: start.task_id })).events, []);
  child.stdout.write('ghijklmnop\r\n');
  child.stderr.write('password=abc'); child.stderr.write('def\n');
  child.stdout.write('tail');
  const first = await call('task_output', { task_id: start.task_id, limit: 1 });
  assert.deepEqual(first.events, [{ seq: 0, stream: 'stdout', text: '中 [REDACTED]\r\n' }]);
  assert.equal(first.has_more, true);
  assert.equal(first.output.redacted, true);
  child.endProcess();
  await waitTask(call, start.task_id, s => s.status === 'completed');
  const rest = await call('task_output', { task_id: start.task_id, cursor: first.next_cursor });
  assert.deepEqual(rest.events.map(e => e.text), ['password=[REDACTED]\n', 'tail']);
  assert.deepEqual((await call('task_output', { task_id: start.task_id, limit: 1 })).events, first.events);
  assert.equal((await call('task_output', { task_id: start.task_id, cursor: 99 })).error.code, 'INVALID_CURSOR');
});

test('MCP bounds output bytes, lines, events and JSON pages without leaking a cut token', async t => {
  for (const mode of ['line', 'bytes', 'events', 'page', 'stop-tail']) await t.test(mode, async t => {
    let child; let finishStop;
    const { call, workspace } = await connectTasks(t, {
      spawnProcess: () => child = processFixture(),
      stopProcess: p => mode === 'stop-tail' ? new Promise(resolve => { finishStop = () => { p.endProcess(1); resolve('succeeded'); }; }) : (p.endProcess(1), Promise.resolve('succeeded')),
    }, () => { child.endProcess(1); finishStop?.(); });
    const { service_epoch } = await call('task_status');
    const start = await call('task_start', { service_epoch, request_id: mode, cwd: workspace, script: "'output'" });
    child.stdout.write('saved\n');
    if (mode === 'line') child.stdout.write('sk-' + 'a'.repeat(65540));
    if (mode === 'bytes') for (let i = 0; i < 18; i++) child.stdout.write('x'.repeat(65535) + '\n');
    if (mode === 'events') child.stdout.write('x\n'.repeat(4100));
    if (mode === 'page') {
      for (let i = 0; i < 4; i++) child.stdout.write('\u0001'.repeat(60000) + '\n');
      child.endProcess();
    }
    if (mode === 'stop-tail') {
      child.stderr.write('Bearer abc');
      await call('task_stop', { task_id: start.task_id });
      child.stderr.write('defghijklmnop\nsafe\n');
      finishStop();
    }
    const result = await waitTask(call, start.task_id, s => ['failed', 'completed', 'stopped'].includes(s.status));
    const first = await call('task_output', { task_id: start.task_id, limit: 200 });
    assert.equal(first.events[0].text, 'saved\n');
    const { isError, ...page } = first;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 524288);
    assert.ok(first.output.stdout_bytes + first.output.stderr_bytes <= 1048576);
    if (mode === 'page') {
      assert.equal(first.has_more, true);
      const next = await call('task_output', { task_id: start.task_id, cursor: first.next_cursor });
      assert.equal(first.events.length + next.events.length, 3); // Remaining pages are still bounded, too.
      assert.equal(next.has_more, true);
    } else if (mode === 'stop-tail') {
      assert.deepEqual(first.events.map(e => e.text), ['saved\n', 'safe\n']);
      assert.equal(result.status, 'stopped');
    } else {
      assert.equal(result.status, 'failed');
      assert.equal(result.completion_reason, 'output_limit');
      assert.equal(first.output.stdout_truncated, true);
      assert.equal(first.output.incomplete, true);
      assert.ok(!JSON.stringify(first.events).includes('sk-'));
    }
  });
});

test('timeout preserves its cause and late evidence resolves an unconfirmed stop without replay', async t => {
  let child; let resolveStop; let stops = 0;
  const { call, workspace, activity } = await connectTasks(t, {
    spawnProcess: () => child = processFixture(p => p.stdout.write('before timeout\n')),
    stopProcess: () => { stops++; return new Promise(resolve => { resolveStop = resolve; }); },
  }, () => { child.endProcess(1); resolveStop?.('succeeded'); });
  const { service_epoch } = await call('task_status');
  const start = await call('task_start', { service_epoch, request_id: 'timeout', cwd: workspace, script: "'slow'", timeout_ms: 1000 });
  const stopping = await waitTask(call, start.task_id, s => s.status === 'stopping', 2500);
  assert.equal(stopping.completion_reason, 'timeout');
  await call('task_stop', { task_id: start.task_id });
  assert.equal(stops, 1, 'an in-flight attempt is not duplicated');
  child.endProcess(1);
  const unknown = await waitTask(call, start.task_id, s => s.status === 'unknown', 6500);
  assert.equal(unknown.root_state, 'exited');
  assert.equal(unknown.termination.tree_kill, 'unconfirmed');
  assert.equal(activity().computer, 1);
  resolveStop('succeeded');
  const final = await waitTask(call, start.task_id, s => s.status === 'failed');
  assert.equal(final.completion_reason, 'timeout');
  assert.equal(activity().computer, 0);
});

test('MCP retains failed stops and shared slots, then accepts an explicit successful retry', async t => {
  const children = []; let stops = 0;
  const { call, workspace, activity } = await connectTasks(t, {
    spawnProcess: () => { const p = processFixture(p => p.stdout.write('before\n')); children.push(p); return p; },
    stopProcess: async p => { stops++; if (stops === 1) throw new Error('injected stop failure'); p.endProcess(1); return 'succeeded'; },
  }, () => children.forEach(p => p.endProcess(1)));
  const { service_epoch } = await call('task_status');
  const args = { service_epoch, cwd: workspace, script: "'running'" };
  const tasks = [];
  for (let i = 0; i < 4; i++) tasks.push(await call('task_start', { ...args, request_id: String(i) }));
  assert.equal(activity().computer, 4);
  assert.equal((await call('task_start', { ...args, request_id: 'overflow' })).error.code, 'COMPUTER_BUSY');
  assert.equal((await call('powershell_execute', { cwd: workspace, script: "'short'" })).error.code, 'COMPUTER_BUSY');
  assert.equal((await call('task_start', { ...args, request_id: '0' })).task_id, tasks[0].task_id);
  await call('task_stop', { task_id: tasks[0].task_id });
  const failed = await waitTask(call, tasks[0].task_id, s => s.termination?.tree_kill === 'failed');
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.root_state, 'running');
  assert.equal(activity().computer, 4);
  assert.equal((await call('task_output', { task_id: tasks[0].task_id })).events[0].text, 'before\n');
  await call('task_stop', { task_id: tasks[0].task_id });
  const stopped = await waitTask(call, tasks[0].task_id, s => s.status === 'stopped');
  assert.equal(stopped.termination.attempts, 2);
  assert.equal(activity().computer, 3);
  assert.equal((await call('task_stop', { task_id: 'not-owned' })).error.code, 'TASK_NOT_FOUND');
  assert.equal(stops, 2);
});

test('MCP recovers acceptance across clients and preserves conflicts after record expiry', async t => {
  let time = Date.now(); let spawns = 0;
  const { call, connect, workspace } = await connectTasks(t, {
    taskNow: () => time,
    spawnProcess: () => { spawns++; return processFixture(p => p.endProcess()); },
    stopProcess: async p => { p.endProcess(1); return 'succeeded'; },
  });
  const { service_epoch } = await call('task_status');
  const args = { service_epoch, request_id: 'recover', cwd: workspace, script: "'one'" };
  const original = await call('task_start', args);
  await waitTask(call, original.task_id, s => s.status === 'completed');
  const other = await connect();
  const recovered = await other.call('task_start', { ...args, timeout_ms: 300000 });
  assert.equal(recovered.task_id, original.task_id);
  assert.equal(recovered.deduplicated, true);
  assert.equal((await call('task_start', { ...args, script: "'two'" })).error.code, 'REQUEST_CONFLICT');
  assert.equal((await call('task_start', { ...args, service_epoch: randomUUID() })).error.code, 'TASK_EPOCH_EXPIRED');
  time += 1800001;
  assert.equal((await call('task_status', { task_id: original.task_id })).error.code, 'TASK_EXPIRED');
  assert.equal((await call('task_start', args)).error.code, 'TASK_EXPIRED');
  assert.equal((await call('task_start', { ...args, script: "'two'" })).error.code, 'REQUEST_CONFLICT');
  assert.equal(spawns, 1);
});

test('MCP distinguishes audit and process failures while retaining the accepted task and safe metadata', async t => {
  for (const mode of ['audit-start', 'audit-end', 'spawn', 'stdin', 'stdout', 'exit']) await t.test(mode, async t => {
    let spawns = 0; let child;
    const { call, workspace, root, activity } = await connectTasks(t, {
      spawnProcess: () => {
        spawns++;
        if (mode === 'spawn') throw new Error('injected spawn failure');
        return child = processFixture(p => {
          p.stdout.write('retained\n');
          if (['stdin', 'stdout'].includes(mode)) p[mode].emit('error', new Error('injected stream error'));
          else p.endProcess(mode === 'exit' ? 7 : 0);
        });
      },
      stopProcess: async p => { p.endProcess(1); return 'succeeded'; },
      appendAudit: (file, line, options) => {
        const record = JSON.parse(line);
        if (mode === 'audit-start' && record.status === 'started' || mode === 'audit-end' && record.status === 'completed') throw new Error('audit unavailable');
        appendFileSync(file, line, options);
      },
    }, () => child?.endProcess(1));
    const { service_epoch } = await call('task_status');
    const args = { service_epoch, request_id: mode, cwd: workspace, script: "'private-script-body'" };
    const start = await call('task_start', args);
    if (mode === 'audit-start') {
      assert.equal(start.error.code, 'AUDIT_FAILED'); assert.equal(spawns, 0); return;
    }
    assert.equal(start.isError, false);
    const result = await waitTask(call, start.task_id, s => s.status === 'failed');
    assert.equal(result.completion_reason, { 'audit-end': 'audit_error', spawn: 'spawn_error', stdin: 'stdin_error', stdout: 'stream_error', exit: 'exited' }[mode]);
    assert.equal(result.audit, mode === 'audit-end' ? 'failed' : 'recorded');
    if (mode === 'spawn') { assert.equal(result.root_state, 'not_started'); assert.equal(result.exit_code, null); }
    else assert.equal((await call('task_output', { task_id: start.task_id })).events[0].text, 'retained\n');
    if (mode === 'exit') assert.equal(result.exit_code, 7);
    assert.equal((await call('task_start', args)).task_id, start.task_id);
    assert.equal(spawns, 1);
    assert.equal(activity().computer, 0);
    const audit = readFileSync(path.join(root, 'runtime', 'computer-audit.jsonl'), 'utf8');
    assert.ok(!audit.includes('private-script-body') && !audit.includes('retained'));
  });
});

test('root exit with open pipes remains owned and never kills a stale root PID', async t => {
  let child; let stops = 0; let time = Date.now();
  const { call, workspace, activity } = await connectTasks(t, {
    taskNow: () => time, spawnProcess: () => child = processFixture(p => { p.stdout.write('root done\n'); p.endProcess(0, false); }),
    stopProcess: async () => { stops++; throw new Error('must not kill an exited root'); },
  }, () => child.endProcess());
  const { service_epoch } = await call('task_status');
  const started = await call('task_start', { service_epoch, request_id: 'pipes', cwd: workspace, script: "'pipes'" });
  const unknown = await waitTask(call, started.task_id, s => s.status === 'unknown', 6500);
  assert.equal(unknown.root_state, 'exited');
  assert.equal(unknown.completion_reason, null, 'root exit is immediately unknown; cleanup/stop supplies the later reason');
  assert.equal(unknown.output.pipes_closed, false);
  time += 3600000;
  assert.equal((await call('task_status', { task_id: started.task_id })).status, 'unknown');
  await call('task_stop', { task_id: started.task_id });
  assert.equal(stops, 0);
  assert.equal(activity().computer, 1);
  child.stdout.write('late output\n');
  child.endProcess();
  const final = await waitTask(call, started.task_id, s => s.status === 'failed');
  assert.equal(final.output.incomplete, true);
  assert.equal(final.output.pipes_closed, true);
  assert.deepEqual((await call('task_output', { task_id: started.task_id })).events.map(e => e.text), ['root done\n', 'late output\n']);
  assert.equal(activity().computer, 0);
});

test('late root exit after stop failure becomes failed, never stopped', async t => {
  let child;
  const { call, workspace } = await connectTasks(t, {
    spawnProcess: () => child = processFixture(), stopProcess: async () => { throw new Error('stop denied'); },
  }, () => child.endProcess());
  const { service_epoch } = await call('task_status');
  const start = await call('task_start', { service_epoch, request_id: 'late', cwd: workspace, script: "'late'" });
  await call('task_stop', { task_id: start.task_id });
  await waitTask(call, start.task_id, s => s.status === 'unknown');
  child.endProcess(0);
  const final = await waitTask(call, start.task_id, s => s.status === 'failed');
  assert.equal(final.termination.tree_kill, 'failed');
  assert.equal(final.exit_code, 0);
});

test('record and tombstone capacities refuse new work while recovery, query and stop stay available', async t => {
  let time = Date.now(); let spawns = 0;
  const { call, workspace } = await connectTasks(t, {
    taskNow: () => time, spawnProcess: () => { spawns++; return processFixture(p => p.endProcess()); },
    stopProcess: async p => { p.endProcess(); return 'succeeded'; },
  });
  const { service_epoch, budgets } = await call('task_status');
  assert.equal(budgets.records, 64); assert.equal(budgets.mappings, 1024); assert.equal(budgets.active, 4);
  const args = { service_epoch, cwd: workspace, script: "'capacity'" };
  let last;
  for (let round = 0; round < 16; round++) {
    for (let i = 0; i < 64; i++) {
      const id = round * 64 + i;
      last = await call('task_start', { ...args, request_id: String(id) });
      assert.equal(last.isError, false);
    }
    await waitTask(call, last.task_id, s => s.status === 'completed');
    assert.equal((await call('task_start', { ...args, request_id: 'new' })).error.code, 'TASK_CAPACITY');
    assert.equal((await call('task_start', { ...args, request_id: String(round * 64 + 63) })).task_id, last.task_id);
    assert.equal((await call('task_stop', { task_id: last.task_id })).status, 'completed');
    assert.equal((await call('task_output', { task_id: last.task_id })).isError, false);
    time += 1800001;
  }
  assert.equal((await call('task_start', { ...args, request_id: 'new' })).error.code, 'TASK_CAPACITY');
  assert.equal((await call('task_start', { ...args, request_id: '0' })).error.code, 'TASK_EXPIRED');
  assert.equal((await call('task_start', { ...args, request_id: '0', script: "'changed'" })).error.code, 'REQUEST_CONFLICT');
  assert.equal(spawns, 1024);
});

test('closing computer tools stops owned tasks and blocks new work without calling a model', async t => {
  let child; let stops = 0;
  const { call, workspace, computer, activity } = await connectTasks(t, {
    spawnProcess: () => child = processFixture(p => p.stdout.write('before shutdown\n')),
    stopProcess: async p => { stops++; p.endProcess(1); return 'succeeded'; },
  }, () => child.endProcess(1));
  const { service_epoch } = await call('task_status');
  const args = { service_epoch, request_id: 'shutdown', cwd: workspace, script: "'running'" };
  const started = await call('task_start', args);
  await computer.close();
  const final = await call('task_status', { task_id: started.task_id });
  assert.equal(final.status, 'failed');
  assert.equal(final.completion_reason, 'shutdown');
  assert.equal(stops, 1); assert.equal(activity().computer, 0);
  assert.equal((await call('task_start', { ...args, request_id: 'new' })).error.code, 'SHUTTING_DOWN');
  assert.equal((await call('task_start', args)).task_id, started.task_id);
});

test('service epochs reject previous IDs, concurrent retries execute once and invalid inputs have no effects', async t => {
  let spawns = 0;
  const options = { spawnProcess: () => { spawns++; return processFixture(p => p.endProcess()); }, stopProcess: async () => 'succeeded' };
  const first = await connectTasks(t, options);
  const second = await connectTasks(t, options);
  const { service_epoch } = await first.call('task_status');
  const args = { service_epoch, request_id: 'concurrent', cwd: first.workspace, script: "'once'" };
  const [a, b] = await Promise.all([first.call('task_start', args), first.call('task_start', args)]);
  assert.equal(a.task_id, b.task_id); assert.equal(spawns, 1);
  assert.equal((await second.call('task_start', args)).error.code, 'TASK_EPOCH_EXPIRED');
  for (const name of ['task_status', 'task_output', 'task_stop']) assert.equal((await second.call(name, { task_id: a.task_id })).error.code, 'TASK_NOT_FOUND');
  for (const overrides of [{ timeout_ms: 999 }, { timeout_ms: 1800001 }, { script: '' }, { script: '   ' }, { script: '中'.repeat(50000) }, { pid: 1 }, { query: 'version' }]) {
    const reply = await first.client.callTool({ name: 'task_start', arguments: { ...args, request_id: randomUUID(), ...overrides } });
    assert.equal(reply.isError, true);
  }
  assert.equal(spawns, 1);
  const tools = (await first.client.listTools()).tools;
  assert.equal(tools.length, 25);
  assert.equal(tools.find(t => t.name === 'task_start').annotations.destructiveHint, true);
  assert.equal(tools.find(t => t.name === 'task_output').annotations.readOnlyHint, true);
});

test('asynchronous OS spawn failure remains a queryable failed task with no invented exit code', async t => {
  const { call, workspace, activity } = await connectTasks(t, {
    spawnProcess: (_exe, _args, options) => spawnDirect(path.join(options.cwd, 'nonexistent-task-executable.exe'), [], options),
  });
  const { service_epoch } = await call('task_status');
  const result = await call('task_start', { service_epoch, request_id: 'missing', cwd: workspace, script: "'unused'" });
  const failed = await waitTask(call, result.task_id, s => s.status === 'failed');
  assert.equal(failed.root_state, 'not_started');
  assert.equal(failed.exit_code, null);
  assert.equal(failed.completion_reason, 'spawn_error');
  assert.equal(activity().computer, 0);
});

test('shutdown failure remains observable, retains the slot, and can be retried after late evidence', async t => {
  let child; let stops = 0;
  const { call, workspace, computer, activity } = await connectTasks(t, {
    spawnProcess: () => child = processFixture(), stopProcess: async () => { stops++; throw new Error('shutdown stop failed'); },
  }, () => child.endProcess());
  const { service_epoch } = await call('task_status');
  const start = await call('task_start', { service_epoch, request_id: 'shutdown-fail', cwd: workspace, script: "'wait'" });
  const began = Date.now();
  await assert.rejects(computer.close(), { code: 'STOP_FAILED' });
  assert.ok(Date.now() - began < 7000);
  assert.equal(activity().computer, 1);
  const status = await call('task_status', { task_id: start.task_id });
  assert.equal(status.status, 'unknown');
  assert.equal(status.completion_reason, 'shutdown');
  assert.equal(status.termination.tree_kill, 'failed');
  child.endProcess(1);
  await waitTask(call, start.task_id, s => s.status === 'failed');
  await computer.close();
  assert.equal(activity().computer, 0); assert.equal(stops, 1);
});
