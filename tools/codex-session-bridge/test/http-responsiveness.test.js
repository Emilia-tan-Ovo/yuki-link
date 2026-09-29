import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Harness } from '../src/harness/harness.ts';
import { WorkflowHistory } from '../src/harness/workflow.ts';
import { connectTasks, waitTask, pause } from './helpers/task-fixture.js';

test('周期工作流 Git 扫描与活动 task 不阻塞普通 GET 和 MCP 探测', { timeout: 40000 }, async t => {
  let harness, drained = false;
  const f = await connectTasks(t, process.env.YCA_TEST_PWSH ? { pwsh: process.env.YCA_TEST_PWSH } : {}, async () => {
    if (harness) {
      clearInterval(harness.timer); harness.timer = null;
      if (!drained) await harness.workflowHistory.scanBackground();
      harness.close();
    }
  });
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args],
    { cwd: f.workspace, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const source = { session() { throw Error('No model'); }, runs: () => [], events: () => [], attribution: () => ({}) };
  harness = new Harness(f.root + '/history', source);
  let initialAssessment;
  // Match the production cardinality, with actual Git and isolated history.
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    const ticket = { id, key: 'HTTP', reference: 'fixture', expected_worktree: f.workspace };
    harness.tickets.set(id, ticket);
    const snapshot = { checkpoint: { worktree: f.workspace, ticket_key: 'HTTP', branch: 'main', head },
      subject: { subject_id: randomUUID(), ticket_ref: 'fixture', head, staged: [], unstaged: [], untracked: [] },
      artifacts: [], runtime_refs: [] };
    const assessment = initialAssessment ??= harness.workflowHistory.source.assess(ticket, snapshot);
    harness.workflowHistory.current.set(id, { ticket_id: id, conversation_id: randomUUID(), workflow_revision: 1, snapshot, assessment });
  }
  const { service_epoch } = await f.call('task_status');
  const task = await f.call('task_start', { service_epoch, request_id: randomUUID(), cwd: f.workspace,
    script: '[Console]::Out.WriteLine("ACTIVE"); Start-Sleep -Seconds 25', timeout_ms: 30000 });
  assert.equal(task.isError, false);
  await waitTask(f.call, task.task_id, value => value.status === 'running');
  harness.start(100);
  let completed = 0;
  const assessAsync = harness.workflowHistory.source.assessAsync.bind(harness.workflowHistory.source);
  harness.workflowHistory.source.assessAsync = async (...args) => { const result = await assessAsync(...args); completed++; return result; };
  // Requests span the timer firing; elapsed time includes a stalled client loop.
  const timings = [];
  try {
    for (let round = 0; round < 3; round++) {
      for (const route of ['/', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const started = performance.now();
        const response = await fetch(new URL(route, f.url), { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        const elapsed = performance.now() - started;
        timings.push(Math.round(elapsed));
        assert.equal(response.status, 404);
        assert.ok(elapsed < 1000, `${route} took ${Math.round(elapsed)}ms`);
        await pause(40);
      }
      const started = performance.now();
      assert.equal((await f.call('task_status', { task_id: task.task_id })).status, 'running');
      assert.ok(performance.now() - started < 1000, 'MCP probe exceeded 1s');
    }
  } finally {
    clearInterval(harness.timer); harness.timer = null;
    t.diagnostic(`GET milliseconds: ${timings.join(', ')}`);
    if (timings.length === 9) {
      await harness.workflowHistory.scanBackground();
      drained = true;
      assert.equal(completed, 20, 'timer ticks must share one scan, with all workflows refreshed');
      const [id, workflow] = harness.workflowHistory.current.entries().next().value;
      const workflowSource = harness.workflowHistory.source;
      const ticket = harness.tickets.get(id);
      writeFileSync(f.workspace + '/changed.txt', 'changed\n', 'utf8');
      const changed = await workflowSource.assessAsync(ticket, workflow.snapshot);
      assert.ok(changed.reasons.some(reason => reason.code === 'SUBJECT_CONTENT_CHANGED'));
      const synchronous = workflowSource.assess(ticket, workflow.snapshot);
      assert.deepEqual({ ...changed, checked_at: null }, { ...synchronous, checked_at: null });
      workflowSource.git = () => 'missing-yuki-test-git-executable';
      const unavailable = await workflowSource.assessAsync(ticket, workflow.snapshot);
      assert.equal(unavailable.state, 'unknown');
      assert.ok(unavailable.reasons.some(reason => reason.code === 'GIT_UNAVAILABLE'));
    }
    await f.call('task_stop', { task_id: task.task_id });
    await waitTask(f.call, task.task_id, value => value.status === 'stopped');
  }
});

test('后台扫描串行合并，丢弃新 revision、显式刷新和关闭后的旧结果', async () => {
  const old = { state: 'unknown', checked_at: '2026-01-01T00:00:00.000Z', reasons: [], artifacts: [], runtime: [] };
  const fresh = { ...old, state: 'verified' };
  const workflow = { ticket_id: 'ticket', conversation_id: 'conversation', workflow_revision: 1,
    snapshot: { subject: { subject_id: 'subject' } }, assessment: old };
  const writes = [];
  let release, calls = 0;
  const source = { assess: () => fresh, assessAsync: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
  const history = new WorkflowHistory({ records: [], append(data) { writes.push(data); return { data }; } }, () => ({}), source);
  history.current.set('ticket', workflow);
  const first = history.scanBackground();
  assert.equal(history.scanBackground(), first);
  assert.equal(calls, 1);
  history.current.set('ticket', { ...workflow });
  release(fresh); await first;
  assert.equal(writes.length, 0, 'old revision result discarded');

  const second = history.scanBackground();
  history.scan();
  release(old); await second;
  assert.equal(history.assessments.get('ticket'), fresh, 'explicit refresh remains authoritative');
  assert.equal(writes.length, 1);

  const third = history.scanBackground();
  history.close();
  release(old); await third;
  await history.scanBackground();
  assert.equal(calls, 3);
  assert.equal(writes.length, 1, 'no writes after close');
});
