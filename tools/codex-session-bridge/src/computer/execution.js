import { StringDecoder } from 'node:string_decoder';
import { spawnDirect, stopProcessTree } from '../process.js';
import { BridgeError, redact, publicError } from '../errors.js';

const OUTPUT_LIMIT = 1024 * 1024;
const CLEANUP_MS = 5000;

// One invocation owns its process, output budget and bounded termination lifecycle.
// Query, script and Git callers all use this same implementation.
export class ComputerExecution {
  constructor({ operation, operationId, executable, args, cwd, stdin, timeoutMs, audit, release, spawnProcess = spawnDirect, stopProcess = stopProcessTree }) {
    Object.assign(this, { operation, operationId, executable, args, cwd, stdin, timeoutMs, audit, release, spawnProcess, stopProcess });
    this.streams = Object.fromEntries(['stdout', 'stderr'].map(name => [name, { chunks: [], bytes: 0, truncated: false }]));
    this.bytes = 0;
    this.started = false;
    this.exited = false;
    this.closed = false;
    this.settled = false;
    this.failure = null;
    this.reason = 'exited';
    this.exitCode = null;
    this.signal = null;
    this.termination = { requested: false, tree_kill: 'not_requested' };
    this.stopPending = false;
    this.exitObserved = new Promise(resolve => { this.resolveExit = resolve; });
  }

  run() {
    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve; this.reject = reject;
      this.timer = setTimeout(() => this.interrupt(new BridgeError('QUERY_TIMEOUT', 'Computer execution timed out.'), 'timeout'), this.timeoutMs);
      try {
        this.child = this.spawnProcess(this.executable, this.args, { cwd: this.cwd, detached: process.platform !== 'win32' });
      } catch (error) {
        this.failure = new BridgeError('PROCESS_FAILED', redact(error.message));
        this.reason = 'spawn_error';
        this.closed = true;
        this.finish();
        return;
      }
      const child = this.child;
      for (const name of ['stdout', 'stderr']) {
        child[name].on('data', buffer => this.capture(name, buffer));
        child[name].on('error', error => this.interrupt(new BridgeError('STREAM_FAILED', redact(error.message)), 'stream_error'));
      }
      child.stdin.on('error', error => this.interrupt(new BridgeError('STDIN_FAILED', redact(error.message)), 'stdin_error'));
      child.once('spawn', () => {
        this.started = true;
        child.stdin.end(this.stdin, 'utf8');
      });
      child.once('error', error => {
        if (this.started) this.interrupt(new BridgeError('PROCESS_FAILED', redact(error.message)), 'stream_error');
        else {
          this.failure ??= new BridgeError('PROCESS_FAILED', redact(error.message));
          this.reason = 'spawn_error';
          this.closed = true;
          this.finish();
        }
      });
      child.once('exit', (code, signal) => {
        this.exited = true;
        this.exitCode = code; this.signal = signal;
        this.resolveExit();
        clearTimeout(this.timer);
        if (this.settled) {
          this.release();
          try { this.audit('process_exited', { exit_code: code, signal }); } catch { /* The returned snapshot already reports audit status. */ }
        } else this.armCleanup(); // A descendant can hold pipes after the root exits.
      });
      child.once('close', () => {
        this.closed = true;
        this.maybeFinish();
      });
    });
    return this.done;
  }

  capture(name, buffer) {
    if (this.settled) return; // Keep draining without retaining more memory.
    const stream = this.streams[name];
    const take = Math.min(buffer.length, OUTPUT_LIMIT - this.bytes);
    if (take) {
      stream.chunks.push(Buffer.from(buffer.subarray(0, take)));
      stream.bytes += take; this.bytes += take;
    }
    if (take < buffer.length) {
      stream.truncated = true;
      this.interrupt(new BridgeError('OUTPUT_LIMIT', 'Computer output exceeded 1 MiB.'), 'output_limit');
    }
  }

  armCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => {
      if (!this.failure) {
        this.failure = new BridgeError('STREAM_FAILED', 'Process exited but output pipes did not close within 5 seconds.');
        this.reason = 'stream_error';
      }
      this.finish();
    }, CLEANUP_MS);
  }

  interrupt(error, reason) {
    if (this.settled || this.termination.requested) return;
    if (!this.failure) { this.failure = error; this.reason = reason; }
    clearTimeout(this.timer);
    this.termination = { requested: true, tree_kill: 'unconfirmed' };
    this.stopPending = true;
    this.armCleanup();
    Promise.resolve().then(() => this.stopProcess(this.child)).then(outcome => {
      this.termination.tree_kill = outcome ?? 'unconfirmed';
    }, error => {
      this.termination.tree_kill = 'failed';
      this.termination.error = publicError(error);
    }).finally(() => { this.stopPending = false; this.maybeFinish(); });
  }

  maybeFinish() {
    if (this.closed && !this.stopPending) this.finish();
  }

  async shutdown() {
    if (!this.settled) {
      this.interrupt(new BridgeError('SHUTTING_DOWN', 'Execution interrupted by service shutdown.'), 'shutdown');
      // This invocation already has its single cleanup deadline; do not stack one.
      await this.done.catch(() => {});
    } else if (this.started && !this.exited) {
      // A later service shutdown is a separate stop request for retained ownership.
      // Do not mutate the earlier response or extend its execution/cleanup budget.
      let timer;
      try {
        await Promise.race([
          Promise.all([Promise.resolve().then(() => this.stopProcess(this.child)), this.exitObserved]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('STOP_FAILED', 'Owned process did not stop within 5 seconds.')), CLEANUP_MS); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    if (this.started && !this.exited) throw new BridgeError('STOP_FAILED', 'Owned process is still running after shutdown cleanup.');
  }

  decode(name, incomplete) {
    const stream = this.streams[name];
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(Buffer.concat(stream.chunks));
    if (decoder.lastNeed && (stream.truncated || incomplete)) {
      stream.truncated = true;
      stream.bytes -= decoder.lastTotal - decoder.lastNeed;
      return text; // Do not invent a replacement character for a cut code point.
    }
    return text + decoder.end();
  }

  finish() {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer); clearTimeout(this.cleanupTimer);
    const incomplete = this.started && (this.termination.requested || !this.closed || Object.values(this.streams).some(s => s.truncated));
    const stdout = this.decode('stdout', incomplete); const stderr = this.decode('stderr', incomplete);
    const result = {
      operation_id: this.operationId, exit_code: this.exitCode,
      stdout: redact(stdout), stderr: redact(stderr), signal: this.signal,
      completion_reason: this.reason,
      process_state: this.exited ? 'exited' : this.started ? 'running' : 'not_started',
      timeout_ms: this.timeoutMs,
      termination: structuredClone(this.termination),
      output: {
        limit_bytes: OUTPUT_LIMIT, stdout_bytes: this.streams.stdout.bytes, stderr_bytes: this.streams.stderr.bytes,
        stdout_truncated: this.streams.stdout.truncated, stderr_truncated: this.streams.stderr.truncated,
        incomplete, redacted: false,
      },
      audit: 'recorded',
    };
    result.output.redacted = result.stdout !== stdout || result.stderr !== stderr;
    const sensitive = ['git_diff', 'git_config_names'].includes(this.operation) && result.stdout !== stdout;
    if (sensitive) this.failure ??= new BridgeError('SENSITIVE_CONTENT', 'Git output resembles credentials; the operation cannot continue safely.');
    if (this.exitCode !== 0) this.failure ??= new BridgeError('PROCESS_EXIT_FAILED', 'Computer execution exited unsuccessfully.', { exit_code: this.exitCode, stderr: result.stderr });
    try {
      this.audit(this.failure ? 'failed' : 'completed', {
        exit_code: this.exitCode, error_code: this.failure?.code ?? null,
        completion_reason: result.completion_reason, process_state: result.process_state,
        stdout_bytes: result.output.stdout_bytes, stderr_bytes: result.output.stderr_bytes,
        incomplete, stdout_truncated: result.output.stdout_truncated, stderr_truncated: result.output.stderr_truncated,
        tree_kill: result.termination.tree_kill,
      });
    } catch {
      result.audit = 'failed';
      this.failure ??= new BridgeError('AUDIT_FAILED', 'Execution finished but its audit record could not be saved.');
    }
    for (const stream of Object.values(this.streams)) stream.chunks = [];
    if (this.exited || !this.started) this.release();
    if (this.failure) {
      // Git's content-refusal contract also applies to the new nested result.
      if (!sensitive) this.failure.details = { ...this.failure.details, result };
      this.reject(this.failure);
    } else this.resolve(result);
  }
}
