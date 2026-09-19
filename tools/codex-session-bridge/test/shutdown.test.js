import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
