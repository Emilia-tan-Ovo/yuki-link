import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PathPolicy } from './paths.js';
import { WorkspaceFiles } from './filesystem.js';
import { ComputerExecution } from './execution.js';
import { BridgeError } from '../errors.js';

const queryFile = fileURLToPath(new URL('./query.ps1', import.meta.url));
const scriptFile = fileURLToPath(new URL('./execute.ps1', import.meta.url));

export class ComputerTools {
  constructor({ readRoots, writeRoots, runtime, controlRoots = [], pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh', git = process.platform === 'win32' ? 'git.exe' : 'git', spawnProcess, stopProcess, appendAudit = appendFileSync }) {
    mkdirSync(runtime, { recursive: true });
    this.paths = new PathPolicy(readRoots, writeRoots, runtime, controlRoots);
    this.auditFile = path.join(runtime, 'computer-audit.jsonl');
    this.appendAudit = appendAudit;
    this.filesystem = new WorkspaceFiles(this.paths, this.audit.bind(this));
    this.pwsh = pwsh;
    this.git = git;
    this.processAdapters = { spawnProcess, stopProcess };
    this.executions = new Set();
    this.closing = false;
  }

  audit(operation, status, metadata) {
    // Never log scripts, file contents, subprocess streams, environment or key refs.
    this.appendAudit(this.auditFile, JSON.stringify({ at: new Date().toISOString(), operation, status, ...metadata }) + '\n', { encoding: 'utf8', flush: true });
  }

  directory(cwd) {
    const resolved = this.paths.resolve(cwd);
    if (!statSync(resolved).isDirectory()) throw new BridgeError('NOT_A_DIRECTORY', 'cwd must be a directory.');
    return resolved;
  }

  executable(name) {
    if (path.isAbsolute(name)) return realpathSync.native(name);
    // Do not let Windows search the request's cwd for pwsh.exe/git.exe.
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      try {
        const executable = realpathSync.native(path.join(directory, name));
        if (!statSync(executable).isFile()) continue;
        const writable = this.paths.writeRoots.some(root => {
          const relative = path.relative(root, executable);
          return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        });
        if (!writable) return executable;
      } catch { /* Try the next absolute PATH entry. */ }
    }
    throw new BridgeError('EXECUTABLE_UNAVAILABLE', 'The required executable was not found in a trusted PATH directory.');
  }

  async powershell({ cwd, query, timeout_ms = 10_000 }) {
    if (!['version', 'location', 'system', 'processes'].includes(query)) throw new BridgeError('QUERY_NOT_ALLOWED', 'Only version, location, system and processes queries are supported.');
    cwd = this.directory(cwd);
    const result = await this.execute('powershell', this.executable(this.pwsh), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', queryFile], cwd, JSON.stringify({ query }), timeout_ms, { query });
    try { result.data = JSON.parse(result.stdout); }
    catch { throw new BridgeError('INVALID_QUERY_OUTPUT', 'PowerShell did not return valid JSON.', { result }); }
    return result;
  }

  async powershellExecute({ cwd, script, timeout_ms = 30_000 }) {
    if (typeof script !== 'string' || !script.trim() || Buffer.byteLength(script, 'utf8') > 131072) {
      throw new BridgeError('INVALID_SCRIPT', 'Provide a nonblank script of at most 128 KiB UTF-8.');
    }
    cwd = this.directory(cwd);
    return this.execute('powershell_execute', this.executable(this.pwsh), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptFile], cwd, JSON.stringify({ script }), timeout_ms);
  }

  async gitQuery({ cwd, path: file, staged = false }, kind) {
    cwd = this.directory(cwd);
    const executable = this.executable(this.git);
    const common = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
    const root = await this.execute('git_root', executable, [...common, 'rev-parse', '--show-toplevel'], cwd, '', 10_000);
    const repository = this.directory(root.stdout.trim());
    // status/diff may invoke clean/process filters, even with --no-ext-diff.
    // Read key names only (never configuration values) and disable every driver
    // for this process. Include global and repository config through Git itself.
    const config = await this.execute('git_config_names', executable, [...common, 'config', '--list', '--name-only', '--null', '--includes'], repository, '', 10_000);
    const drivers = new Set(config.stdout.split('\0').map(key => /^filter\.(.*)\.(?:clean|process|required)$/i.exec(key)?.[1]).filter(Boolean));
    for (const driver of drivers) common.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`);
    if (kind === 'status') return this.execute('git_status', executable, [...common, 'status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all'], repository, '', 10_000);
    file = this.paths.resolve(file);
    if (!statSync(file).isFile()) throw new BridgeError('NOT_A_FILE', 'Diff requires one existing allowed file, not a directory.');
    const relative = path.relative(repository, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new BridgeError('PATH_NOT_ALLOWED', 'File is outside this repository.');
    // Inspect only an allowed text file. No external diff/textconv programs or submodules.
    this.filesystem.text(this.filesystem.bytes(file));
    return this.execute('git_diff', executable, [...common, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(staged ? ['--cached'] : []), '--', relative], repository, '', 10_000);
  }

  execute(operation, executable, args, cwd, stdin, timeoutMs, metadata = {}) {
    if (this.closing) throw new BridgeError('SHUTTING_DOWN', 'Computer tools are shutting down.');
    if (this.executions.size >= 4) throw new BridgeError('COMPUTER_BUSY', 'Too many active computer executions.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) throw new BridgeError('INVALID_TIMEOUT', 'Computer query timeout must be 1000–30000 ms.');
    const operationId = randomUUID();
    try { this.audit(operation, 'started', { operation_id: operationId, ...metadata }); }
    catch { throw new BridgeError('AUDIT_FAILED', 'Could not record execution intent; no process was started.'); }
    const execution = new ComputerExecution({
      operation, operationId, executable, args, cwd, stdin, timeoutMs,
      ...this.processAdapters,
      audit: (status, result) => this.audit(operation, status, { operation_id: operationId, ...metadata, ...result }),
      release: () => this.executions.delete(execution),
    });
    this.executions.add(execution);
    return execution.run();
  }

  async close() {
    this.closing = true;
    const outcomes = await Promise.allSettled([...this.executions].map(execution => execution.shutdown()));
    if (outcomes.some(outcome => outcome.status === 'rejected')) {
      throw new BridgeError('STOP_FAILED', 'Could not confirm all owned computer processes stopped during shutdown.');
    }
  }
}
