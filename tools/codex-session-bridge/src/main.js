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
import { ComputerTools } from './computer/tools.js';

const toolRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: {
  transport: { type: 'string', default: 'stdio' },
  port: { type: 'string', default: '7391' },
  runtime: { type: 'string', default: path.join(toolRoot, 'runtime') },
  'allow-cwd': { type: 'string', multiple: true },
  'read-root': { type: 'string', multiple: true },
  'pwsh-bin': { type: 'string', default: process.platform === 'win32' ? 'pwsh.exe' : 'pwsh' },
  'codex-bin': { type: 'string', default: 'codex' },
  help: { type: 'boolean', default: false },
} });

if (values.help) {
  console.log('Yuki Computer Agent\n--transport stdio|http (default stdio)\n--port 7391 (HTTP binds only 127.0.0.1)\n--allow-cwd ABSOLUTE_PATH (repeatable; required; Codex cwd and filesystem write roots)\n--read-root ABSOLUTE_PATH (repeatable; optional additional read roots)\n--runtime ABSOLUTE_PATH (default tools/codex-session-bridge/runtime)\n--codex-bin EXECUTABLE (default codex)\n--pwsh-bin EXECUTABLE (default pwsh.exe on Windows)');
} else {
  let store;
  let manager;
  let computer;
  try {
    if (!values['allow-cwd']?.length || !['stdio', 'http'].includes(values.transport)) throw new Error('Specify --allow-cwd and a supported --transport.');
    if (!path.isAbsolute(values.runtime) || [...values['allow-cwd'], ...(values['read-root'] ?? [])].some(p => !path.isAbsolute(p))) throw new Error('Runtime and allowlist paths must be absolute.');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const catalog = new ModelCatalog(values['codex-bin']);
    // Codex capability discovery is lazy; unavailable Codex must not block computer tools.
    store = new RuntimeStore(values.runtime);
    manager = new SessionManager({ store, catalog, executor: new CodexExecutor(values['codex-bin']), allowedCwds: values['allow-cwd'] });
    computer = new ComputerTools({ readRoots: [...values['allow-cwd'], ...(values['read-root'] ?? [])], writeRoots: values['allow-cwd'], runtime: values.runtime, pwsh: values['pwsh-bin'] });
    let server;
    let httpServer;
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        if (httpServer) { httpServer.close(); httpServer.closeIdleConnections(); }
        await manager.close();
        await computer.close();
        if (server) await server.close();
        process.exitCode = 0;
      } catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    if (values.transport === 'http') {
      httpServer = createHttpServer(manager, computer);
      await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, '127.0.0.1', resolve); });
      console.error(`Yuki Computer Agent ready at http://127.0.0.1:${port}/mcp`);
    } else {
      server = createMcpServer(manager, computer);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      process.stdin.once('end', shutdown);
      console.error('Yuki Computer Agent ready on stdio');
    }
  } catch (error) {
    console.error(JSON.stringify(publicError(error)));
    if (manager) await manager.close();
    else store?.close();
    await computer?.close();
    process.exitCode = 1;
  }
}
