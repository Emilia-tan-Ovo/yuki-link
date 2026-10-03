import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, realpathSync, statSync } from 'node:fs';
import { PathPolicy } from '../computer/paths.js';
import { OwnedTasks } from '../computer/tasks.js';
import { BridgeError } from '../errors.js';

// Only the process/paths seam required by OwnedTasks. No WorkspaceFiles,
// general shell/query API, Companion or tunnel is constructed here.
export class EngineeringTaskHost {
  constructor({ roots, runtime, pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh', processAdapters = {} }) {
    this.paths = new PathPolicy(roots, roots, runtime, []);
    this.pwsh = pwsh;
    this.processAdapters = processAdapters;
    this.executions = new Set();
    this.closing = false;
    this.auditFile = path.join(runtime, 'engineering-task-audit.jsonl');
    this.tasks = new OwnedTasks(this, fileURLToPath(new URL('../computer/execute.ps1', import.meta.url)));
  }
  directory(cwd) {
    const resolved = this.paths.resolve(cwd);
    if (!statSync(resolved).isDirectory()) throw new BridgeError('NOT_A_DIRECTORY', 'Engineering worktree unavailable.');
    return resolved;
  }
  executable(name) {
    const candidates = path.isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(path.delimiter)
      .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, name));
    for (const candidate of candidates) {
      try {
        const executable = realpathSync.native(candidate);
        if (!statSync(executable).isFile()) continue;
        if (this.paths.writeRoots.some(root => {
          const relative = path.relative(root, executable);
          return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
        })) continue;
        return executable;
      } catch { /* Refresh PATH on each execution; do not cache an executable. */ }
    }
    throw new BridgeError('EXECUTABLE_UNAVAILABLE', 'Trusted PowerShell executable unavailable.');
  }
  audit(operation, status, metadata) {
    appendFileSync(this.auditFile, JSON.stringify({ at: new Date().toISOString(), operation, status, ...metadata }) + '\n',
      { encoding: 'utf8', flush: true });
  }
  async close() {
    this.closing = true;
    const results = await Promise.allSettled([...this.executions].map(execution => execution.shutdown()));
    if (results.some(result => result.status === 'rejected'))
      throw new BridgeError('STOP_FAILED', 'Engineering process shutdown not confirmed; retain writer.');
  }
}
