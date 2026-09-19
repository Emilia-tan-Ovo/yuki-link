import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function ready(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('isolated YCA did not become ready');
}

test('service shutdown closes raw idle HTTP sockets that are not counted as active requests', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yca-shutdown-'));
  const runtime = path.join(root, 'runtime'), workspace = path.join(root, 'workspace');
  mkdirSync(runtime); mkdirSync(workspace);
  const mcpPort = await port(), controlPort = await port(), harnessPort = await port();
  const token = randomBytes(32).toString('hex'), instance = randomUUID();
  const entry = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [entry, '--transport', 'http', '--port', String(mcpPort), '--allow-cwd', workspace,
    '--runtime', runtime, '--pwsh-bin', process.execPath, '--control-port', String(controlPort), '--control-instance', instance,
    '--harness-port', String(harnessPort)], {
    env: { ...process.env, YUKI_CONTROL_TOKEN: token }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.resume();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let mcpSocket, controlSocket;
  t.after(async () => {
    mcpSocket?.destroy(); controlSocket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'yca-shutdown-')));
    rmSync(root, { recursive: true, force: true });
  });

  await ready(`http://127.0.0.1:${mcpPort}/healthz`);
  await ready(`http://127.0.0.1:${harnessPort}/`);
  const client = new Client({ name: 'harness-startup', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));
    const registered = await client.callTool({ name: 'harness_register_ticket', arguments: {
      project_key: 'startup', project_name: '生产入口隔离样本', ticket_key: 'one', title: '登记', reference: 'fixture:one',
    } });
    assert.notEqual(registered.isError, true);
    assert.match(await (await fetch(`http://127.0.0.1:${harnessPort}/`)).text(), /生产入口隔离样本/);
    assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/api/projects`)).status, 404);
  } finally { await client.close(); }
  mcpSocket = net.connect({ host: '127.0.0.1', port: mcpPort });
  controlSocket = net.connect({ host: '127.0.0.1', port: controlPort });
  await Promise.all([mcpSocket, controlSocket].map(socket => new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); })));

  const headers = { Authorization: `Bearer ${token}` };
  const status = await (await fetch(`http://127.0.0.1:${controlPort}/status`, { headers })).json();
  assert.deepEqual(status.active, { codex: 0, computer: 0, requests: 0 });

  const stop = await fetch(`http://127.0.0.1:${controlPort}/stop`, { method: 'POST', headers });
  assert.equal(stop.status, 202);
  assert.deepEqual(await stop.json(), { stopping: true });
  const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('YCA did not exit after accepted shutdown')), 3000))]);
  assert.equal(result.code, 0);
});

test('computer STOP_FAILED still stops Codex while retaining writer and read-only observation', { timeout: 15000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yca-shutdown-'));
  const runtime = path.join(root, 'runtime'), workspace = path.join(root, 'workspace');
  mkdirSync(runtime); mkdirSync(workspace);
  const mcpPort = await port(), controlPort = await port(), harnessPort = await port();
  const token = randomBytes(32).toString('hex');
  // Isolated source adapters: no real model/process tree. Exercise the production
  // entry point, real manager lifecycle, public stop and read-only observation.
  const preload = `
    import { ComputerTools } from ${JSON.stringify(new URL('../src/computer/tools.js', import.meta.url).href)};
    import { BridgeError } from ${JSON.stringify(new URL('../src/errors.js', import.meta.url).href)};
    import { CodexExecutor } from ${JSON.stringify(new URL('../src/executor.js', import.meta.url).href)};
    import { ModelCatalog } from ${JSON.stringify(new URL('../src/catalog.js', import.meta.url).href)};
    import { PermissionResolver } from ${JSON.stringify(new URL('../src/permissions.js', import.meta.url).href)};
    ComputerTools.prototype.close = async function () { this.closing = true; throw new BridgeError('STOP_FAILED', 'fixture computer still running'); };
    ModelCatalog.prototype.validate = async () => ({ model: 'fixture', reasoning: 'low' });
    PermissionResolver.prototype.resolve = async () => ({ version: 1, kind: 'native', stored: true,
      sandbox_mode: 'read-only', approval_policy: 'never', approvals_reviewer: 'user', workspace_write: null,
      source: 'fixture', resolved_at: new Date().toISOString() });
    CodexExecutor.prototype.start = (_run, _session, _prompt, callbacks) => {
      callbacks.onSpawn(null);
      return { stop: async () => callbacks.onDone({ code: 1 }) };
    };
  `;
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
    fileURLToPath(new URL('../src/main.js', import.meta.url)), '--transport', 'http', '--port', String(mcpPort),
    '--runtime', runtime, '--allow-cwd', workspace, '--control-port', String(controlPort),
    '--control-instance', randomUUID(), '--harness-port', String(harnessPort)], {
    env: { ...process.env, YUKI_CONTROL_TOKEN: token }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const client = new Client({ name: 'dual-source-shutdown', version: '1' });
  t.after(async () => {
    await client.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  await ready(`http://127.0.0.1:${mcpPort}/healthz`);
  const ui = `http://127.0.0.1:${harnessPort}`;
  await ready(ui + '/');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const ticket = await call('harness_register_ticket', { project_key: 'dual', project_name: 'dual', ticket_key: 'SPEC-1', title: '双来源关停', reference: 'fixture:SPEC-1' });
  const run = await call('codex_start_session', { cwd: workspace, request_id: randomUUID(), prompt: 'fixture only' });
  await call('harness_attach', { ticket_id: ticket.ticket_id, session_id: run.session_id });
  const headers = { Authorization: `Bearer ${token}` };
  const statusUrl = `http://127.0.0.1:${controlPort}/status`;
  assert.equal((await (await fetch(statusUrl, { headers })).json()).active.codex, 1);
  const response = await fetch(`http://127.0.0.1:${controlPort}/stop`, { method: 'POST', headers: { ...headers, 'x-confirm-impact': 'yes' } });
  assert.equal(response.status, 202);
  const deadline = Date.now() + 1500;
  let status;
  do {
    status = await (await fetch(statusUrl, { headers })).json();
    if (status.active.codex === 0 && diagnostics.includes('STOP_FAILED')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(status.active.codex, 0, 'computer stop failure must not skip the accepted Codex stop');
  assert.match(diagnostics, /STOP_FAILED/);
  assert.equal(existsSync(path.join(runtime, 'bridge.lock')), true);
  assert.equal(child.exitCode, null, 'failure must not pretend normal service exit');
  const home = await fetch(ui + '/'), cookie = home.headers.get('set-cookie').split(';')[0];
  const detail = await (await fetch(ui + '/api/tickets/' + ticket.ticket_id, { headers: { cookie } })).json();
  assert.ok(detail.records.some(r => r.data.kind === 'event' && r.data.event.kind === 'run.stopped'));
});

test('shutdown persists synchronous and owned task results before releasing the runtime writer', { timeout: 20000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yca-shutdown-'));
  const runtime = path.join(root, 'runtime'), workspace = path.join(root, 'workspace');
  mkdirSync(runtime); mkdirSync(workspace);
  const mcpPort = await port(), controlPort = await port();
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)),
    '--transport', 'http', '--port', String(mcpPort), '--runtime', runtime, '--allow-cwd', workspace,
    '--control-port', String(controlPort), '--control-instance', randomUUID()], {
    env: { ...process.env, YUKI_CONTROL_TOKEN: token }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.resume();
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const client = new Client({ name: 'shutdown-history', version: '1' });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  t.after(async () => {
    await client.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  await ready(`http://127.0.0.1:${mcpPort}/healthz`);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const registration = await client.callTool({ name: 'harness_register_ticket', arguments: {
    project_key: 'shutdown', project_name: 'shutdown', ticket_key: 'sync', title: 'sync', reference: 'fixture:shutdown',
  } });
  const ticket_id = registration.structuredContent.ticket_id;
  const epoch = (await client.callTool({ name: 'task_status', arguments: {} })).structuredContent.service_epoch;
  const task = await client.callTool({ name: 'task_start', arguments: {
    ticket_id, service_epoch: epoch, request_id: 'shutdown-owned', cwd: workspace,
    script: "[Console]::Out.WriteLine('任务关闭前输出'); Set-Content './task-started.txt' 'started'; Start-Sleep -Seconds 20",
  } });
  assert.notEqual(task.isError, true);
  const observation = new AbortController();
  const request = fetch(url, { method: 'POST', signal: observation.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'powershell_execute', arguments: {
      ticket_id, cwd: workspace, script: "[Console]::Out.Write('关闭前输出'); Set-Content './started.txt' 'started'; Start-Sleep -Seconds 20",
    } } }) }).then(r => r.text(), () => 'disconnected');
  const deadline = Date.now() + 10000;
  while ((!existsSync(path.join(workspace, 'started.txt')) || !existsSync(path.join(workspace, 'task-started.txt'))) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(existsSync(path.join(workspace, 'started.txt')), true);
  assert.equal(existsSync(path.join(workspace, 'task-started.txt')), true);
  const stop = await fetch(`http://127.0.0.1:${controlPort}/stop`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-confirm-impact': 'yes' } });
  assert.equal(stop.status, 202);
  while (existsSync(path.join(runtime, 'bridge.lock')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 2));
  assert.equal(existsSync(path.join(runtime, 'bridge.lock')), false, diagnostics + '\n' + readFileSync(path.join(runtime, 'harness/history.jsonl'), 'utf8'));
  // Snapshot at ownership release, not after process exit when late writes could hide the bug.
  const atRelease = readFileSync(path.join(runtime, 'harness/history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  observation.abort();
  await request;
  const terminal = atRelease.find(r => r.data.kind === 'computer_call' && r.data.call.stage === 'result');
  assert.ok(terminal, 'result must be durable before another writer can acquire runtime');
  assert.equal(terminal.data.call.error.details.result.completion_reason, 'shutdown');
  assert.match(terminal.data.call.error.details.result.stdout, /关闭前输出/);
  const taskFinal = atRelease.find(r => r.data.kind === 'owned_task' && r.data.task.kind === 'final');
  assert.ok(taskFinal, 'owned task terminal must be saved under the same writer lock');
  assert.equal(taskFinal.data.task.binding.task_id, task.structuredContent.task_id);
  assert.equal(taskFinal.data.task.snapshot.completion_reason, 'shutdown');
  assert.equal(taskFinal.data.task.snapshot.root_state, 'exited');
  assert.equal(taskFinal.data.task.snapshot.output.pipes_closed, true);
  assert.ok(atRelease.some(r => r.data.kind === 'owned_task' && r.data.task.kind === 'output' && r.data.task.payload.text.includes('任务关闭前输出')));
  assert.equal(await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown result saved but service did not exit')), 5000))]), 0);
});
