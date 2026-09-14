import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ModelCatalog } from './catalog.js';
import { RuntimeStore } from './store.js';
import { CodexExecutor } from './executor.js';
import { SessionManager } from './manager.js';
import { createMcpServer } from './mcp.js';
import { createHttpServer } from './http.js';
import { publicError } from './errors.js';

const toolRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: {
  transport: { type: 'string', default: 'stdio' },
  port: { type: 'string', default: '7391' },
  runtime: { type: 'string', default: path.join(toolRoot, 'runtime') },
  'allow-cwd': { type: 'string', multiple: true },
  'codex-bin': { type: 'string', default: 'codex' },
  help: { type: 'boolean', default: false },
} });

if (values.help) {
  console.log('Codex Session Bridge\n--transport stdio|http (default stdio)\n--port 7391 (HTTP binds only 127.0.0.1)\n--allow-cwd ABSOLUTE_PATH (repeatable; required)\n--runtime ABSOLUTE_PATH (default tools/codex-session-bridge/runtime)\n--codex-bin EXECUTABLE (default codex)');
} else {
  let store;
  let manager;
  try {
    if (!values['allow-cwd']?.length || !['stdio', 'http'].includes(values.transport)) throw new Error('Specify --allow-cwd and a supported --transport.');
    if (!path.isAbsolute(values.runtime) || values['allow-cwd'].some(p => !path.isAbsolute(p))) throw new Error('Runtime and allowlist paths must be absolute.');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const catalog = new ModelCatalog(values['codex-bin']);
    // Fail startup if capabilities cannot be discovered. No guessed offline fallback.
    await catalog.list();
    store = new RuntimeStore(values.runtime);
    manager = new SessionManager({ store, catalog, executor: new CodexExecutor(values['codex-bin']), allowedCwds: values['allow-cwd'] });
    let server;
    let httpServer;
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        if (httpServer) { httpServer.close(); httpServer.closeIdleConnections(); }
        await manager.close();
        if (server) await server.close();
        process.exitCode = 0;
      } catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    if (values.transport === 'http') {
      httpServer = createHttpServer(manager);
      await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, '127.0.0.1', resolve); });
      console.error(`Codex Session Bridge ready at http://127.0.0.1:${port}/mcp`);
    } else {
      server = createMcpServer(manager);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      process.stdin.once('end', shutdown);
      console.error('Codex Session Bridge ready on stdio');
    }
  } catch (error) {
    console.error(JSON.stringify(publicError(error)));
    if (manager) await manager.close();
    else store?.close();
    process.exitCode = 1;
  }
}
