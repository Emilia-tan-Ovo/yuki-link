import { spawnDirect, readLines, stopProcessTree } from './process.js';
import { BridgeError, redact } from './errors.js';
import { resolveCodexExecutable } from './codex-executable.js';

export function execArguments(run, session) {
  const args = [
    '-a', 'never', 'exec', '--json', '--ignore-user-config',
    '-s', 'read-only', '-C', session.cwd,
    '-m', run.model, '-c', `model_reasoning_effort=${JSON.stringify(run.reasoning)}`,
    '-c', 'web_search="disabled"',
    '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
    '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
  ];
  if (session.codex_thread_id) args.push('resume', session.codex_thread_id);
  args.push('-');
  return args;
}

export class CodexExecutor {
  constructor(executable = 'codex', spawnChild = spawnDirect, resolveExecutable = resolveCodexExecutable) { this.executable = executable; this.spawnChild = spawnChild; this.resolveExecutable = resolveExecutable; }

  start(run, session, prompt, { onEvent, onStderr, onSpawn, onDone }) {
    const env = { ...process.env };
    // A bridge-created session must not impersonate the parent Codex task.
    delete env.CODEX_THREAD_ID;
    const { executable } = this.resolveExecutable(this.executable);
    const child = this.spawnChild(executable, execArguments(run, session), { cwd: session.cwd, env, detached: process.platform !== 'win32' });
    let failure = null;
    let stopped = false;
    const stop = async () => { stopped = true; await stopProcessTree(child); };
    const fail = error => {
      failure ??= error;
      stop().catch(() => {});
    };
    readLines(child.stdout, line => {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event.type !== 'string') throw new Error('Missing event type');
        onEvent(event);
      } catch (error) { fail(error instanceof BridgeError ? error : new BridgeError('INVALID_CODEX_OUTPUT', 'Codex stdout was not a valid JSONL event.')); }
    }, fail);
    readLines(child.stderr, line => onStderr(redact(line)), fail);
    child.once('spawn', () => {
      onSpawn(child.pid);
      // Prompt is data, including $, backticks, quotes, CRLF, and Windows paths.
      child.stdin.end(prompt, 'utf8');
    });
    child.stdin.on('error', error => { if (!stopped) failure ??= new BridgeError('STDIN_FAILED', redact(error.message)); });
    child.on('error', error => { failure ??= new BridgeError('SPAWN_FAILED', 'Codex launch failed after executable discovery; check the installation and session cwd.',
      { spawn_code: ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC'].includes(error.code) ? error.code : 'UNKNOWN' }); });
    child.once('close', (code, signal) => onDone({ code, signal, error: failure }));
    return { stop, child };
  }
}
