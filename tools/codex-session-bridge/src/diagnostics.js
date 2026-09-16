import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';

// Use the public MCP registration/list protocol; no tool is executed.
export async function toolSummary() {
  const server = createMcpServer({}, {});
  const client = new Client({ name: 'local-schema-summary', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    return { count: tools.length, sha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex') };
  } finally { await client.close(); await server.close(); }
}

export function activity(manager, computer, requests = 0) {
  return { codex: Object.values(manager.store.state.runs).filter(r => ['queued', 'running', 'stopping'].includes(r.status)).length, computer: computer.executions.size, requests };
}

export function createDiagnostics({ manager, computer, instance, token, summary, requests, shutdown, drain = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Control token must contain 32 random bytes.');
  return http.createServer(async (req, res) => {
    const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || req.headers.origin) return reply(403, { code: 'FORBIDDEN' });
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return reply(403, { code: 'FORBIDDEN' });
    const active = activity(manager, computer, requests());
    if (req.method === 'GET' && req.url === '/status') {
      const latest = Object.values(manager.store.state.runs).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return reply(200, { service: 'yuki-local-control', instance, pid: process.pid, at: new Date().toISOString(), active, closing: manager.closing, tools: summary,
        lastBridge: latest ? { status: latest.status, at: latest.finished_at ?? latest.started_at ?? latest.created_at, code: latest.error?.code ?? null, exitCode: latest.exit_code } : null });
    }
    if (req.method === 'POST' && req.url === '/stop') {
      if (Object.values(active).some(n => n > 0) && req.headers['x-confirm-impact'] !== 'yes') return reply(409, { code: 'ACTIVE_TASKS', active });
      // Close acceptance synchronously, before shutdown's first asynchronous boundary.
      drain(); manager.closing = true; computer.closing = true;
      reply(202, { stopping: true });
      setImmediate(() => shutdown()); return;
    }
    reply(404, { code: 'NOT_FOUND' });
  });
}
