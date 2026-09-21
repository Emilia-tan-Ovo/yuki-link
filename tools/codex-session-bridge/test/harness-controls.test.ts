import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { RuntimeStore } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { createHarnessRuntime, createHarnessServer } from '../src/harness/runtime.ts';

type Callbacks = {
  onSpawn(pid: number | null): void;
  onEvent(event: Record<string, unknown>): void;
  onStderr(text: string): void;
  onDone(result: { code: number; signal?: string | null; error?: unknown }): void;
};

const tick = () => new Promise(resolve => setImmediate(resolve));

function initializeRepository(directory: string) {
  execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Harness Fixture'], { cwd: directory, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'harness@example.invalid'], { cwd: directory, stdio: 'ignore' });
  writeFileSync(path.join(directory, 'tracked.txt'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: directory, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: directory, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
}

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-controls-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  const store = new RuntimeStore(path.join(root, 'runtime'));
  const calls: Array<{ callbacks: Callbacks; stopCalls: number }> = [];
  const manager: any = new SessionManager({
    store,
    allowedCwds: [workspace],
    catalog: { validate: async () => ({ model: 'fixture', reasoning: 'low' }) },
    permissionResolver: { resolve: async () => ({ version: 1, kind: 'native', stored: true,
      sandbox_mode: 'danger-full-access', approval_policy: 'on-request', approvals_reviewer: 'user',
      workspace_write: null, source: 'fixture', resolved_at: new Date().toISOString() }) },
    executor: { start: (_run: unknown, _session: unknown, _prompt: string, callbacks: Callbacks) => {
      const call = { callbacks, stopCalls: 0 };
      calls.push(call);
      callbacks.onSpawn(null);
      return { stop: async () => { call.stopCalls++; } };
    } },
  });
  const opened: string[] = [];
  manager.harness = createHarnessRuntime(manager, [], undefined, { openFolder: (directory: string) => { opened.push(directory); } });
  const server = createHarnessServer(manager.harness);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = await fetch(base);
  const cookie = home.headers.get('set-cookie')!.split(';')[0];
  const { csrf } = await (await fetch(base + '/api/session', { headers: { cookie } })).json() as { csrf: string };
  const post = async (route: string, body: unknown = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { cookie, origin: base,
      'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const postForm = async (route: string) => {
    const response = await fetch(base + route, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base,
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
    return { status: response.status, location: response.headers.get('location'), body: await response.json() as any };
  };
  t.after(async () => {
    manager.harness.close();
    server.close(); server.closeAllConnections();
    for (const call of calls) call.callbacks.onDone({ code: 1 });
    await tick();
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  return { manager, workspace, calls, opened, base, cookie, csrf, post, postForm };
}

test('public Ticket controls refresh and exact-stop an existing run without starting or continuing work', async t => {
  const f = await fixture(t);
  const started = await f.manager.start({ cwd: f.workspace, request_id: 'existing', prompt: 'existing work' });
  await tick();
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Existing controls', reference: 'fixture:#48', expected_worktree: f.workspace });
  f.manager.harness.attach({ ticket_id: ticket.ticket_id, session_id: started.session_id, run_id: started.run_id });

  const beforeRuns = Object.keys(f.manager.store.state.runs).length;
  const refreshed = await f.post(`/api/tickets/${ticket.ticket_id}/refresh`);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.runs[0].execution.status, 'running');
  assert.equal(refreshed.body.runs[0].observation.state, 'current');
  assert.equal(Object.keys(f.manager.store.state.runs).length, beforeRuns);
  assert.equal(f.calls.length, 1);

  const stopped = await f.post(`/api/tickets/${ticket.ticket_id}/runs/${started.run_id}/stop`);
  assert.equal(stopped.status, 202);
  assert.equal(stopped.body.outcome, 'requested');
  assert.equal(stopped.body.execution.status, 'stopping');
  assert.equal(f.calls[0].stopCalls, 1);
  assert.notEqual(stopped.body.execution.status, 'stopped');

  const page = await fetch(`${f.base}/api/ui/tickets/${ticket.ticket_id}`, { headers: { cookie: f.cookie } }).then(r => r.text());
  assert.doesNotMatch(page, /<button[^>]*>[^<]*(?:start|send|resume|continue)/i);
  assert.match(page, /停止请求已发送|stopping/);
});

test('exact run guard never stops a newer active run in the same session', async t => {
  const f = await fixture(t);
  const first = await f.manager.start({ cwd: f.workspace, request_id: 'first', prompt: 'first' });
  await tick();
  f.calls[0].callbacks.onEvent({ type: 'thread.started', thread_id: randomUUID() });
  f.calls[0].callbacks.onEvent({ type: 'turn.completed' });
  f.calls[0].callbacks.onDone({ code: 0 });
  await tick();
  const second = await f.manager.send({ session_id: first.session_id, request_id: 'second', prompt: 'second' });
  await tick();
  // Simulate a stale non-terminal target observed before a newer active run won
  // the session slot. The guard must key off the active identity, not status.
  f.manager.run(first.run_id).status = 'running';
  const result = f.manager.stopRun(first.session_id, first.run_id);
  assert.equal(result.outcome, 'active_run_changed');
  assert.equal(f.calls[1].stopCalls, 0);
  assert.equal(f.manager.status({ run_id: second.run_id }).run.status, 'running');
});

test('run stop request failure is a public API and form failure', async t => {
  const f = await fixture(t);
  const started = await f.manager.start({ cwd: f.workspace, request_id: 'stop-failure', prompt: 'existing work' });
  await tick();
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Stop failure', reference: 'fixture:#48', expected_worktree: f.workspace });
  f.manager.harness.attach({ ticket_id: ticket.ticket_id, session_id: started.session_id, run_id: started.run_id });
  f.manager.stopRun = () => { throw new Error('stop failed'); };
  const route = `/api/tickets/${ticket.ticket_id}/runs/${started.run_id}/stop`;

  const api = await f.post(route);
  assert.equal(api.status, 503);
  assert.equal(api.body.outcome, 'request_failed');
  const form = await f.postForm(route);
  assert.equal(form.status, 503);
  assert.equal(form.location, null);
  assert.equal(form.body.outcome, 'request_failed');
});

test('worktree open ignores client paths and uses the canonical registered Ticket directory', async t => {
  const f = await fixture(t);
  const fixedPoint = initializeRepository(f.workspace);
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Open worktree', reference: 'fixture:#48', expected_worktree: f.workspace, fixed_point: fixedPoint });
  const response = await f.post(`/api/tickets/${ticket.ticket_id}/worktree/open`, { path: 'C:\\not-the-ticket' });
  assert.equal(response.status, 202);
  assert.equal(response.body.outcome, 'open_requested');
  assert.deepEqual(f.opened, [f.workspace]);
});

test('worktree open fails closed when the registered directory is replaced by a file', async t => {
  const f = await fixture(t);
  const fixedPoint = initializeRepository(f.workspace);
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Open worktree', reference: 'fixture:#48', expected_worktree: f.workspace, fixed_point: fixedPoint });
  rmSync(f.workspace, { recursive: true, force: true });
  writeFileSync(f.workspace, 'not a directory', 'utf8');

  const response = await f.post(`/api/tickets/${ticket.ticket_id}/worktree/open`);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'WORKTREE_UNAVAILABLE');
  assert.deepEqual(f.opened, []);
});

test('worktree open rejects a different repository recreated at the same allowlisted path', async t => {
  const f = await fixture(t);
  const fixedPoint = initializeRepository(f.workspace);
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Open worktree', reference: 'fixture:#48', expected_worktree: f.workspace, fixed_point: fixedPoint });
  rmSync(f.workspace, { recursive: true, force: true });
  mkdirSync(f.workspace);
  initializeRepository(f.workspace);

  const response = await f.post(`/api/tickets/${ticket.ticket_id}/worktree/open`);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'WORKTREE_MISMATCH');
  assert.deepEqual(f.opened, []);
});

test('POST controls require the loopback session, exact Origin, CSRF and JSON content type', async t => {
  const f = await fixture(t);
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Protected controls', reference: 'fixture:#48', expected_worktree: f.workspace });
  const route = `${f.base}/api/tickets/${ticket.ticket_id}/refresh`;
  assert.equal((await fetch(route, { method: 'POST' })).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { cookie: f.cookie, origin: f.base,
    'content-type': 'application/json', 'x-csrf-token': 'wrong' }, body: '{}' })).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { cookie: f.cookie, origin: f.base,
    'content-type': 'text/plain', 'x-csrf-token': f.csrf }, body: '{}' })).status, 415);
  const form = await fetch(route, { method: 'POST', redirect: 'manual', headers: { cookie: f.cookie, origin: f.base,
    'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: f.csrf }) });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('location'), `/tickets/${ticket.ticket_id}`);
});

test('observation failure stays separate from a running execution and recovers without replay', async t => {
  const f = await fixture(t);
  const started = await f.manager.start({ cwd: f.workspace, request_id: 'observe', prompt: 'existing work' });
  await tick();
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Observation', reference: 'fixture:#48', expected_worktree: f.workspace });
  f.manager.harness.attach({ ticket_id: ticket.ticket_id, session_id: started.session_id, run_id: started.run_id });
  const original = f.manager.store.readEvents.bind(f.manager.store);
  f.manager.store.readEvents = () => { throw new Error('source unavailable'); };
  const unavailable = await f.post(`/api/tickets/${ticket.ticket_id}/refresh`);
  assert.equal(unavailable.body.runs[0].execution.status, 'running');
  assert.equal(unavailable.body.runs[0].observation.state, 'unavailable');
  assert.equal(f.calls.length, 1);
  f.manager.store.readEvents = original;
  const recovered = await f.post(`/api/tickets/${ticket.ticket_id}/refresh`);
  assert.equal(recovered.body.runs[0].observation.state, 'current');
  assert.equal(f.calls.length, 1);
});

test('recording failure does not block manage-existing and recovery does not replay the stop', async t => {
  const f = await fixture(t);
  const started = await f.manager.start({ cwd: f.workspace, request_id: 'degraded', prompt: 'existing work' });
  await tick();
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Degraded recording', reference: 'fixture:#48', expected_worktree: f.workspace });
  f.manager.harness.attach({ ticket_id: ticket.ticket_id, session_id: started.session_id, run_id: started.run_id });
  f.manager.harness.journal.failure = 'JOURNAL_WRITE_FAILED';
  const stopped = await f.post(`/api/tickets/${ticket.ticket_id}/runs/${started.run_id}/stop`);
  assert.equal(stopped.status, 202);
  assert.equal(stopped.body.outcome, 'requested');
  assert.equal(stopped.body.evidence_gap.state, 'recording-failed');
  assert.equal(f.calls[0].stopCalls, 1);
  f.manager.harness.journal.failure = null;
  await f.post(`/api/tickets/${ticket.ticket_id}/refresh`);
  assert.equal(f.calls[0].stopCalls, 1);
});

test('control intent and result records remain readable after Harness restart', async t => {
  const f = await fixture(t);
  const started = await f.manager.start({ cwd: f.workspace, request_id: 'durable', prompt: 'existing work' });
  await tick();
  const ticket = f.manager.harness.register({ project_key: 'P', project_name: 'Harness', ticket_key: 'HARNESS-008',
    title: 'Durable controls', reference: 'fixture:#48', expected_worktree: f.workspace });
  f.manager.harness.attach({ ticket_id: ticket.ticket_id, session_id: started.session_id, run_id: started.run_id });
  await f.post(`/api/tickets/${ticket.ticket_id}/refresh`);
  f.manager.harness.close();
  f.manager.harness = createHarnessRuntime(f.manager, [], undefined, { openFolder: (directory: string) => { f.opened.push(directory); } });
  const records = f.manager.harness.detail(ticket.ticket_id).records.filter((record: any) => record.data.kind === 'control_action');
  assert.deepEqual(records.map((record: any) => record.data.control.stage), ['requested', 'result']);
  assert.deepEqual(records.map((record: any) => record.data.control.action), ['refresh', 'refresh']);
  assert.equal(f.calls.length, 1);
});
