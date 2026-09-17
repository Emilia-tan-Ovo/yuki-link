import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ComputerTools } from '../../src/computer/tools.js';
import { createHttpServer } from '../../src/http.js';
import { activity } from '../../src/diagnostics.js';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function connectTasks(t, options = {}, cleanup = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-task-'));
  const workspace = path.join(root, '工作区 空格');
  mkdirSync(workspace);
  const calls = { model: 0 };
  const unavailable = () => { calls.model++; throw new Error('Model disabled in task tests'); };
  const manager = { closing: false, store: { state: { runs: {} } }, start: unavailable, send: unavailable,
    catalog: { list: unavailable }, executor: { start: unavailable } };
  const computer = new ComputerTools({ readRoots: [workspace], writeRoots: [workspace], runtime: path.join(root, 'runtime'), ...options });
  const server = createHttpServer(manager, computer);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const clients = [];
  const connect = async () => {
    const client = new Client({ name: 'owned-task-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url));
    clients.push(client);
    return { client, call: async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return { ...(response.structuredContent ?? JSON.parse(response.content[0].text)), isError: response.isError === true };
    } };
  };
  t.after(async () => {
    try { await cleanup(); await computer.close(); }
    finally {
      await Promise.all(clients.map(client => client.close()));
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      assert.equal(calls.model, 0, 'computer tools must make zero model/catalog calls');
      assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-task-')));
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { ...await connect(), connect, workspace, computer, root, url, calls, activity: () => activity(manager, computer) };
}

export function processFixture(start = () => {}) {
  const child = new EventEmitter();
  child.pid = 1234567; // Synthetic; always pair with a synthetic stop adapter.
  child.exitCode = null; child.signalCode = null;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.endProcess = (code = 0, close = true) => {
    if (child.exitCode === null) { child.exitCode = code; child.emit('exit', code, null); }
    if (close) { child.stdout.end(); child.stderr.end(); child.emit('close', code, null); }
  };
  queueMicrotask(() => { child.emit('spawn'); start(child); });
  return child;
}

export async function waitTask(call, task_id, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let snapshot;
  do {
    snapshot = await call('task_status', { task_id });
    if (predicate(snapshot)) return snapshot;
    await pause(20);
  } while (Date.now() < deadline);
  assert.fail(`Task did not reach expected state: ${JSON.stringify(snapshot)}`);
}
