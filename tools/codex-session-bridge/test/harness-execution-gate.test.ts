import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { Harness } from '../src/harness/harness.ts';

type Wire = Record<string, any>;
type HealthState = 'recording' | 'recording-failed' | 'collection-failed';

const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const cwd = 'C:\\fixture';

const toolInputs: Record<string, Wire> = {
  codex_list_models: {},
  codex_start_session: { cwd, request_id: 'start', prompt: 'start' },
  codex_send_message: { session_id: id, request_id: 'send', prompt: 'send' },
  codex_get_status: { session_id: id },
  codex_get_output: { run_id: otherId },
  codex_stop_session: { session_id: id },
  task_status: {},
  task_start: { service_epoch: id, request_id: 'task', cwd, script: 'exit 0' },
  task_output: { task_id: 'task-1' },
  task_stop: { task_id: 'task-1' },
  powershell: { cwd, query: 'location' },
  powershell_execute: { cwd, script: 'exit 0' },
  filesystem_list: { path: cwd },
  filesystem_read: { path: cwd + '\\input.txt' },
  filesystem_write: { path: cwd + '\\output.txt', content: 'content' },
  filesystem_move: { source: cwd + '\\input.txt', destination: cwd + '\\moved.txt', expected_sha256: 'a'.repeat(64) },
  git_status: { cwd },
  git_diff: { cwd, path: cwd + '\\input.txt' },
};

const newSideEffects = ['codex_start_session', 'codex_send_message', 'task_start', 'powershell_execute', 'filesystem_write', 'filesystem_move'];
const observe = ['codex_list_models', 'codex_get_status', 'codex_get_output', 'task_status', 'task_output',
  'powershell', 'filesystem_list', 'filesystem_read', 'git_status', 'git_diff'];
const manageExisting = ['codex_stop_session', 'task_stop'];

function workflowInput() {
  const hash = 'b'.repeat(64), at = new Date().toISOString();
  return {
    ticket_id: id, request_id: 'workflow', expected_revision: null, schema_version: 1,
    snapshot: {
      phase: 'review', actor: { name: 'Emilia', method: 'deterministic' },
      checkpoint: { artifact_id: 'checkpoint', ticket_key: 'HARNESS-004', worktree: cwd, branch: 'fixture',
        fixed_point: hash, head: hash, phase: 'review', schema_version: 1 },
      subject: { subject_id: 'implementation', fixed_point: hash, head: hash, scope: ['src/mcp.js'],
        staged: [], unstaged: [], untracked: [], ticket_ref: 'issue:44', spec_ref: 'issue:39',
        standards: ['AGENTS.md'], tests: ['node --test test/harness-execution-gate.test.ts'] },
      artifacts: [{ artifact_id: 'checkpoint', role: 'checkpoint', kind: 'file', location: cwd + '\\checkpoint.md',
        revision: hash, source_schema: 'checkpoint-v1', source: 'engineering-workflow', observed_at: at, integrity: 'observed' }],
      reviews: [], findings: [],
      acceptance: { acceptance_id: null, status: 'not-recorded', actor: { name: 'Emilia', method: 'deterministic' },
        subject_ref: null, criteria: [], evidence: [], evidence_refs: [], execution_refs: [],
        applicability: 'not-applicable', reason: '尚未验收' },
      closeout: { status: 'pending', artifact_refs: [], evidence: [], applicability: 'not-applicable', reason: '尚未收尾' },
      runtime_refs: [],
    },
  };
}

const recordOnlyInputs: Record<string, Wire> = {
  harness_register_ticket: { project_key: 'P', project_name: 'Project', ticket_key: 'HARNESS-004', title: 'Gate', reference: 'issue:44' },
  harness_attach: { ticket_id: id, session_id: otherId },
  harness_record_workflow: workflowInput(),
};

async function fixture(t: TestContext, initial: HealthState | 'unavailable') {
  let state = initial;
  const calls = new Map<string, number>();
  const hit = (name: string) => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return { tool: name, preserved: true };
  };
  const harness = initial === 'unavailable' ? undefined : {
    health() {
      return { state, reason: state === 'recording' ? null : `fixture-${state}`, source_id: id,
        observed_at: new Date().toISOString(), sources: {} };
    },
    executionGate(category: Parameters<Harness['executionGate']>[0]) {
      return Harness.prototype.executionGate.call(this as unknown as Harness, category);
    },
    register: () => hit('harness_register_ticket'),
    attach: () => hit('harness_attach'),
    recordWorkflow: () => hit('harness_record_workflow'),
    computerCalls: {
      async run(_name: string, _ticketId: string, _input: Wire, action: () => unknown) {
        return { isError: false, response: await action() };
      },
    },
    taskHistory: { validateTicket() {}, receipt: () => ({ state }) },
  };
  const manager: Wire = {
    ...(harness ? { harness } : {}),
    catalog: { list: () => hit('codex_list_models') },
    start: () => hit('codex_start_session'), send: () => hit('codex_send_message'),
    status: () => hit('codex_get_status'), output: () => hit('codex_get_output'), stop: () => hit('codex_stop_session'),
  };
  const computer: Wire = {
    closing: false,
    tasks: { status: () => hit('task_status'), start: () => hit('task_start'), output: () => hit('task_output'), stop: () => hit('task_stop') },
    powershell: () => hit('powershell'), powershellExecute: () => hit('powershell_execute'),
    filesystem: { list: () => hit('filesystem_list'), read: () => hit('filesystem_read'),
      write: () => hit('filesystem_write'), move: () => hit('filesystem_move') },
    gitQuery: (_input: Wire, operation: string) => hit(operation === 'status' ? 'git_status' : 'git_diff'),
  };
  const server = createHttpServer(manager, computer);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'harness-execution-gate-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),
  ));
  t.after(async () => {
    await client.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  return {
    calls,
    call: (name: string, args = toolInputs[name]) => client.callTool({ name, arguments: args }),
    setState(next: HealthState) { state = next; },
  };
}

for (const [state, code] of [['recording-failed', 'RECORDING_FAILED'], ['collection-failed', 'COLLECTION_FAILED'],
  ['unavailable', 'HARNESS_UNAVAILABLE']] as const) {
  test(`公开 MCP gate 在 ${state} 时拒绝全部 new-side-effect`, async t => {
    const f = await fixture(t, state);
    for (const name of newSideEffects) {
      const result = await f.call(name);
      assert.equal(result.isError, true, name);
      assert.equal((result.structuredContent as Wire).error.code, code, name);
      assert.equal(f.calls.get(name) ?? 0, 0, `${name} action 不得执行`);
    }
  });

  test(`observe/manage-existing 在 ${state} 时继续并报告 evidence gap`, async t => {
    const f = await fixture(t, state);
    for (const name of [...observe, ...manageExisting]) {
      const args = name === 'filesystem_read' ? { ...toolInputs[name], ticket_id: id } : toolInputs[name];
      const result = await f.call(name, args);
      assert.equal(result.isError, undefined, name);
      const body = result.structuredContent as Wire;
      assert.equal(body.preserved, true, name);
      assert.equal(body.harness_recording.state, state, name);
      assert.equal(body.evidence_gap.state, state, name);
      assert.equal(f.calls.get(name), 1, name);
    }
  });
}

test('record-only 在 collection-failed 可记录并显式报告 collector gap', async t => {
  const f = await fixture(t, 'collection-failed');
  for (const [name, input] of Object.entries(recordOnlyInputs)) {
    const result = await f.call(name, input);
    assert.equal(result.isError, undefined, name);
    const body = result.structuredContent as Wire;
    assert.equal(body.harness_recording.state, 'collection-failed', name);
    assert.equal(body.evidence_gap.state, 'collection-failed', name);
    assert.equal(f.calls.get(name), 1, name);
  }
});

for (const [state, code] of [['recording-failed', 'RECORDING_FAILED'], ['unavailable', 'HARNESS_UNAVAILABLE']] as const) {
  test(`record-only 在 ${state} fail-closed`, async t => {
    const f = await fixture(t, state);
    for (const [name, input] of Object.entries(recordOnlyInputs)) {
      const result = await f.call(name, input);
      assert.equal(result.isError, true, name);
      assert.equal((result.structuredContent as Wire).error.code, code, name);
      assert.equal(f.calls.get(name) ?? 0, 0, `${name} action 不得执行`);
    }
  });
}

test('health 恢复不重放被拒动作，只有新的显式调用才执行', async t => {
  const f = await fixture(t, 'collection-failed');
  const rejected = await f.call('filesystem_write');
  assert.equal(rejected.isError, true);
  assert.equal(f.calls.get('filesystem_write') ?? 0, 0);

  f.setState('recording');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.get('filesystem_write') ?? 0, 0, '恢复本身不得重放 action');

  const accepted = await f.call('filesystem_write', { ...toolInputs.filesystem_write, content: 'fresh explicit call' });
  assert.equal(accepted.isError, undefined);
  assert.equal(f.calls.get('filesystem_write'), 1);
  assert.equal((accepted.structuredContent as Wire).evidence_gap, undefined);
});
