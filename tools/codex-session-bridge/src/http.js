import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCompanionMcpServer, createMcpServer } from './mcp.js';

export function createHttpServer(manager, computer, observation = {}, options = {}) {
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
    if (options.handle && request.url?.startsWith('/engineering/')) {
      if (observation.draining) { response.writeHead(503).end('Stopping'); return; }
      observation.active = (observation.active ?? 0) + 1;
      try { await options.handle(request, response); }
      finally { observation.active--; }
      return;
    }
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(options.identity?.() ?? { status: manager.closing ? 'stopping' : 'ok', service: 'yuki-computer-agent', version: '0.2.0' })); return;
    }
    if (!(options.mcpFactory ? ['/mcp'] : ['/mcp','/companion-mcp']).includes(request.url)) { response.writeHead(404).end(); return; }
    if (observation.draining) { response.writeHead(503).end('Stopping'); return; }
    if (options.mcpGuard && !options.mcpGuard(request, response)) return;
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
      // This bridge is still a legacy MCP server. Hosted ChatGPT probes modern MCP first;
      // reject discovery at the JSON-RPC layer so an auto-negotiating client can fall back
      // to the legacy initialize -> tools/list flow instead of treating HTTP 400 as fatal.
      if (body?.jsonrpc === '2.0' && body.method === 'server/discover' && body.id !== undefined) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' },
        }));
        return;
      }
      // MCP connections are stateless; Codex sessions belong to the shared manager.
      const server = options.mcpFactory ? options.mcpFactory()
        : request.url === '/companion-mcp' ? createCompanionMcpServer(manager) : createMcpServer(manager, computer);
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
