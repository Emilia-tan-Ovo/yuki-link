import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnDirect, stopProcessTree, isProcessAlive } from '../src/process.js';
import { connectTasks, waitTask, pause } from './helpers/task-fixture.js';

const quote = value => `'${value.replaceAll("'", "''")}'`;
const fixture = fileURLToPath(new URL('./helpers/task-process.cjs', import.meta.url));

test('real foreground tree runs beyond 30s, reconnects without replay and stops without affecting a control process', { timeout: 55000 }, async t => {
  const control = spawnDirect(process.execPath, [fixture, 'control'], { detached: process.platform !== 'win32' });
  control.stdin.end(); control.stdout.resume(); control.stderr.resume();
  t.after(async () => {
    if (control.exitCode === null) {
      const closed = new Promise(resolve => control.once('close', resolve));
      await stopProcessTree(control); await closed;
    }
  });
  const { call, client, connect, workspace, activity } = await connectTasks(t);
  const { service_epoch } = await call('task_status');
  const args = { service_epoch, request_id: randomUUID(), cwd: workspace, timeout_ms: 60000,
    script: `Add-Content './once.txt' 'START' -Encoding utf8 -NoNewline\n& ${quote(process.execPath)} ${quote(fixture)} parent` };
  const began = Date.now();
  const accepted = await call('task_start', args);
  assert.equal(accepted.isError, false);
  assert.ok(Date.now() - began < 5000, 'start returns before task completion');
  await waitTask(call, accepted.task_id, s => s.status === 'running');
  let initial;
  for (let i = 0; i < 100; i++) {
    initial = await call('task_output', { task_id: accepted.task_id });
    if (initial.events.some(e => e.text.includes('"parent"'))) break;
    await pause(30);
  }
  const parent = initial.events.map(e => { try { return JSON.parse(e.text); } catch { return {}; } }).find(e => e.kind === 'parent');
  assert.ok(parent?.pid && parent.child);
  assert.ok(isProcessAlive(parent.pid) && isProcessAlive(parent.child));
  await client.close();
  await pause(Math.max(0, 31000 - (Date.now() - began)));
  const other = await connect();
  const recovered = await other.call('task_start', args);
  assert.equal(recovered.task_id, accepted.task_id);
  assert.equal(recovered.deduplicated, true);
  assert.equal((await other.call('task_status', { task_id: accepted.task_id })).status, 'running');
  const later = await other.call('task_output', { task_id: accepted.task_id, cursor: initial.next_cursor });
  assert.ok(later.events.length > 0 && later.next_cursor > initial.next_cursor);
  assert.equal(readFileSync(path.join(workspace, 'once.txt'), 'utf8'), 'START');
  assert.equal(activity().computer, 1);
  const requested = await other.call('task_stop', { task_id: accepted.task_id });
  assert.equal(requested.status, 'stopping');
  const stopped = await waitTask(other.call, accepted.task_id, s => s.status === 'stopped');
  assert.equal(stopped.termination.tree_kill, 'succeeded');
  for (let i = 0; i < 50 && (isProcessAlive(parent.pid) || isProcessAlive(parent.child)); i++) await pause(20);
  assert.equal(isProcessAlive(parent.pid), false);
  assert.equal(isProcessAlive(parent.child), false);
  assert.equal(isProcessAlive(control.pid), true);
  assert.equal(activity().computer, 0);
  t.diagnostic('Isolated real MCP/PowerShell foreground tree >30s, different clients, zero model calls; not resident-service acceptance.');
});

test('real PowerShell task keeps UTF-8, natural failure, timeout and output-limit evidence', async t => {
  const { call, workspace } = await connectTasks(t);
  const { service_epoch } = await call('task_status');
  for (const [script, reason, code] of [
    [`[Console]::Out.WriteLine("中文 '单引号'"); [Console]::Error.WriteLine("诊断"); exit 7`, 'exited', 7],
    ['[Console]::Out.WriteLine("BEFORE"); Start-Sleep -Seconds 10', 'timeout', null],
    ['[Console]::Out.WriteLine("BEFORE"); [Console]::Out.Write("x" * 70000); Start-Sleep -Seconds 10', 'output_limit', null],
  ]) {
    const start = await call('task_start', { service_epoch, request_id: randomUUID(), cwd: workspace, script, timeout_ms: reason === 'timeout' ? 3000 : 10000 });
    assert.equal(start.isError, false);
    const end = await waitTask(call, start.task_id, s => s.status === 'failed');
    assert.equal(end.completion_reason, reason);
    if (code !== null) assert.equal(end.exit_code, code);
    assert.equal(end.root_state, 'exited');
    const output = await call('task_output', { task_id: start.task_id });
    assert.ok(output.events.length > 0);
    if (reason === 'exited') assert.deepEqual(output.events.map(e => e.text).sort(), [`中文 '单引号'${os.EOL}`, `诊断${os.EOL}`].sort());
  }
});
