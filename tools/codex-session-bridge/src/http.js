import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';

export function createHttpServer(manager, computer, observation = {}) {
  return http.createServer(async (request, response) => {
    // Loopback binding alone does not protect against browser DNS rebinding.
    const host = request.headers.host ?? '';
    const expected = `127.0.0.1:${request.socket.localPort}`;
    if (host !== expected && host !== `localhost:${request.socket.localPort}`) {
      response.writeHead(403).end('Invalid Host'); return;
    }
    if (request.headers.origin && request.headers.origin !== `http://${host}`) {
      response.writeHead(403).end('Invalid Origin'); return;
    }
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: manager.closing ? 'stopping' : 'ok', service: 'yuki-computer-agent', version: '0.2.0' })); return;
    }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (observation.draining) { response.writeHead(503).end('Stopping'); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415).end(); return; }
    let bytes = 0;
    const chunks = [];
    observation.active = (observation.active ?? 0) + 1;
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { response.writeHead(413).end('Request too large'); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { response.writeHead(400).end('Invalid JSON'); return; }
      // MCP connections are stateless; Codex sessions belong to the shared manager.
      const server = createMcpServer(manager, computer);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500).end('MCP request failed');
      else response.end();
    } finally { observation.active--; }
  });
}
