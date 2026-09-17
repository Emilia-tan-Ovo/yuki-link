import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ComputerTools } from '../../src/computer/tools.js';
import { createHttpServer } from '../../src/http.js';
import { SessionManager } from '../../src/manager.js';
import { RuntimeStore } from '../../src/store.js';
import { CodexExecutor } from '../../src/executor.js';

// Real HTTP/MCP and disk are the agreed seam. Model entry points are forbidden,
// including the executor, so a successful file call cannot hide a model attempt.
export async function connectText(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-text-'));
  const workspace = path.join(root, '工作区 空格');
  const outside = path.join(root, '外部资料');
  mkdirSync(workspace); mkdirSync(outside);
  const runtime = path.join(root, 'private-state');
  const blocked = () => { throw new Error('Model execution forbidden in file tests'); };
  const executor = new CodexExecutor('unused-codex', blocked);
  const store = new RuntimeStore(runtime);
  const manager = new SessionManager({ store, catalog: { list: blocked }, executor, allowedCwds: [workspace] });
  const guards = [t.mock.method(manager, 'start', blocked), t.mock.method(manager, 'send', blocked), t.mock.method(executor, 'start', blocked)];
  const computer = new ComputerTools({ readRoots: [workspace], writeRoots: [workspace], runtime });
  const server = createHttpServer(manager, computer);
  const client = new Client({ name: 'text-test', version: '1' });
  t.after(async () => {
    await client.close(); await computer.close(); await manager.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-text-')));
    rmSync(root, { recursive: true, force: true });
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0, 'No model start/send/executor calls');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...(result.structuredContent ?? JSON.parse(result.content[0].text)), isError: result.isError === true };
  };
  return { root, workspace, outside, runtime, call, client, computer };
}
