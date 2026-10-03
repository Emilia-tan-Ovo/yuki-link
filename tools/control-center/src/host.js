import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { run, fail } from './common.js';

export class WindowsHost {
  constructor(pwsh) { this.pwsh = pwsh; }
  async portOwner(port) {
    const result = await run(this.pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../scripts/process.ps1', import.meta.url))], {
      input: JSON.stringify({ action: 'port-owner', port }), timeout: 5000,
    });
    if (result.code !== 0) throw fail('PROCESS_OBSERVATION_FAILED');
    const value = JSON.parse(result.output);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  async terminateTree(executable, markers, identity) {
    if (!identity?.pid || !identity.created) throw fail('OWNERSHIP_CHANGED');
    const result = await run(this.pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../scripts/process.ps1', import.meta.url))], {
      input: JSON.stringify({ action: 'terminate-tree', executable, markers, pid: identity.pid, created: identity.created }), timeout: 20_000,
    });
    if (result.code !== 0 || result.output.trim() !== 'true') throw fail('OWNERSHIP_CHANGED');
  }
  async inspect(executable, markers, pid) {
    const result = await run(this.pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../scripts/process.ps1', import.meta.url))], {
      input: JSON.stringify({ executable, markers, pid }), timeout: 5000,
    });
    if (result.code !== 0) throw fail('PROCESS_OBSERVATION_FAILED');
    return JSON.parse(result.output);
  }
  async free(port) {
    return new Promise((resolve, reject) => {
      const socket = net.createServer();
      socket.once('error', () => reject(fail('PORT_CONFLICT')));
      socket.listen(port, '127.0.0.1', () => socket.close(resolve));
    });
  }
}
export function matches(actual, owned) { return Boolean(actual?.matches && owned?.pid === actual.pid && owned.created === actual.created); }
