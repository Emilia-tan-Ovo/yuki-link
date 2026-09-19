import { randomUUID, createHash } from 'node:crypto';
import { spawnDirect, stopProcessTree } from '../process.js';
import { BridgeError, publicError } from '../errors.js';
import { TaskOutput, OUTPUT_BUDGETS } from './task-output.js';

export const TASK_BUDGETS = Object.freeze({ timeout_default_ms: 300000, timeout_max_ms: 1800000,
  script_bytes: 131072, active: 4, records: 64, mappings: 1024, retention_ms: 1800000,
  ...OUTPUT_BUDGETS, stop_ms: 5000 });

export class OwnedTasks {
  constructor(computer, scriptFile, now = Date.now) {
    this.computer = computer;
    this.scriptFile = scriptFile;
    this.epoch = randomUUID();
    this.records = new Map();
    this.requests = new Map();
    this.now = now;
    this.observers = new Set();
  }

  // Read-only observation; no script or raw process chunks cross this seam.
  subscribe(observer) { this.observers.add(observer); return () => this.observers.delete(observer); }
  identities() { return [...this.records.values()].filter(entry => entry.identity.ticket_id).map(entry => ({ ...entry.identity })); }
  publish(identity, event) {
    if (!identity.ticket_id) return;
    for (const observer of this.observers) {
      try { observer({ ...identity }, event); }
      catch { /* Recording must not interrupt the owned process. */ }
    }
  }

  expire() {
    for (const entry of this.records.values()) {
      if (entry.task?.finishedMs !== undefined && this.now() - entry.task.finishedMs >= TASK_BUDGETS.retention_ms) entry.task = null;
    }
  }

  start({ service_epoch, request_id, cwd, script, timeout_ms = TASK_BUDGETS.timeout_default_ms, ticket_id }, validateTicket) {
    if (service_epoch !== this.epoch) throw new BridgeError('TASK_EPOCH_EXPIRED', 'Read task_status before starting in this service instance.');
    if (typeof script !== 'string' || !script.trim() || Buffer.byteLength(script) > TASK_BUDGETS.script_bytes) throw new BridgeError('INVALID_SCRIPT', 'Provide a nonblank script of at most 128 KiB UTF-8.');
    const digest = createHash('sha256').update(JSON.stringify({ cwd, script, timeout_ms, ticket_id: ticket_id ?? null })).digest('hex');
    this.expire();
    const prior = this.requests.get(request_id);
    if (prior) {
      if (prior.digest !== digest) throw new BridgeError('REQUEST_CONFLICT', 'request_id was already accepted with different input.');
      const task = this.task(prior.id);
      return { task_id: prior.id, status: task.status, deduplicated: true };
    }
    if (this.computer.closing) throw new BridgeError('SHUTTING_DOWN', 'Computer tools are shutting down.');
    if (ticket_id !== undefined) {
      if (!validateTicket) throw new BridgeError('HARNESS_UNAVAILABLE', 'Explicit Ticket requires Harness attribution.');
      validateTicket(ticket_id); // Attribution validation, never a recording-health gate.
    }
    if (this.requests.size >= TASK_BUDGETS.mappings || [...this.records.values()].filter(entry => entry.task).length >= TASK_BUDGETS.records) throw new BridgeError('TASK_CAPACITY', 'Task record capacity reached; existing tasks remain queryable.');
    if (this.computer.executions.size >= 4) throw new BridgeError('COMPUTER_BUSY', 'Too many active computer executions.');
    cwd = this.computer.directory(cwd);
    const executable = this.computer.executable(this.computer.pwsh);
    const id = `${this.epoch}:${randomUUID()}`;
    try { this.computer.audit('task_start', 'started', { task_id: id }); }
    catch { throw new BridgeError('AUDIT_FAILED', 'Could not record task intent; no process was started.'); }
    const identity = { task_id: id, service_epoch: this.epoch, request_id, ticket_id: ticket_id ?? null,
      cwd, timeout_ms, created_at: new Date(this.now()).toISOString() };
    const task = new ComputerTask({ id, executable, cwd, script, timeoutMs: timeout_ms, scriptFile: this.scriptFile,
      now: this.now, ...this.computer.processAdapters,
      notify: event => this.publish(identity, event),
      audit: (status, metadata) => this.computer.audit('task_start', status, { task_id: id, ...metadata }),
      release: () => this.computer.executions.delete(task) });
    const entry = { id, digest, task, identity };
    this.requests.set(request_id, entry);
    this.records.set(id, entry);
    this.computer.executions.add(task);
    task.observe('accepted');
    task.start();
    return { task_id: id, status: task.status, deduplicated: false };
  }

  task(id) {
    this.expire();
    const entry = this.records.get(id);
    if (!entry) throw new BridgeError('TASK_NOT_FOUND', 'Unknown or expired task identifier.');
    if (!entry.task) throw new BridgeError('TASK_EXPIRED', 'Task result expired; it will not be executed again.', { task_id: id });
    return entry.task;
  }

  status({ task_id } = {}) {
    return task_id ? this.task(task_id).snapshot() : { service_epoch: this.epoch, budgets: TASK_BUDGETS };
  }

  observation(task_id) {
    const task = this.task(task_id);
    return { snapshot: task.snapshot(), lifecycle_next: task.lifecycleSeq };
  }

  output({ task_id, cursor = 0, limit = 100 }) {
    const task = this.task(task_id);
    return task.output.page(task_id, task.status, cursor, limit);
  }

  stop({ task_id }) {
    const task = this.task(task_id);
    task.stop('stop_requested');
    return task.snapshot();
  }
}

class ComputerTask {
  constructor(options) {
    Object.assign(this, options);
    this.status = 'starting'; this.rootState = 'not_started'; this.exitCode = null; this.signal = null;
    this.lifecycleSeq = 0;
    this.output = new TaskOutput(() => this.stop('output_limit'), event => {
      this.notify({ category: 'output', seq: event.seq, kind: 'output', source_at: null,
        payload: event, snapshot: this.snapshot() });
    });
    this.closed = false;
    this.reason = null;
    this.auditState = 'recorded';
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.createdAt = new Date(this.now()).toISOString();
    this.termination = { requested: false, tree_kill: 'not_requested', attempts: 0 };
  }

  observe(kind, payload = null) {
    this.notify({ category: 'lifecycle', seq: this.lifecycleSeq++, kind,
      source_at: new Date(this.now()).toISOString(), payload, snapshot: this.snapshot() });
  }

  start() {
    this.timer = setTimeout(() => this.stop('timeout'), this.timeoutMs);
    let child;
    try {
      child = (this.spawnProcess ?? spawnDirect)(this.executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.scriptFile], { cwd: this.cwd, detached: process.platform !== 'win32' });
    } catch (error) { this.spawnFailed(error); return; }
    this.child = child;
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', chunk => this.output.capture(stream, chunk));
      child[stream].once('end', () => { this.output.end(stream); this.observe('stream.end', { stream }); });
      child[stream].on('error', error => this.fail(error, 'stream_error'));
    }
    child.stdin.on('error', error => this.fail(error, 'stdin_error'));
    child.on('error', error => {
      if (this.rootState === 'not_started') this.spawnFailed(error);
      else this.fail(error, 'stream_error');
    });
    child.once('spawn', () => {
      if (!this.termination.requested) this.status = 'running';
      this.rootState = 'running';
      this.startedAt = new Date(this.now()).toISOString();
      this.observe('spawn');
      child.stdin.end(JSON.stringify({ script: this.script }), 'utf8');
      delete this.script;
    });
    child.once('exit', (code, signal) => {
      this.rootState = 'exited'; this.exitCode = code; this.signal = signal;
      if (!this.closed && !this.termination.requested) this.status = 'unknown';
      this.observe('root.exit');
      clearTimeout(this.timer);
      this.armCleanup();
      this.reconcile();
    });
    child.once('close', () => {
      this.closed = true;
      for (const stream of ['stdout', 'stderr']) this.output.end(stream);
      this.observe('pipes.closed');
      this.reconcile();
    });
  }

  spawnFailed(error) {
    this.reason = 'spawn_error'; this.error = publicError(error); this.closed = true;
    delete this.script;
    for (const name of ['stdout', 'stderr']) this.output.end(name);
    this.observe('error', { reason: 'spawn_error' });
    this.finish('failed');
  }

  fail(error, reason) {
    this.error ??= publicError(error);
    this.observe('error', { reason });
    this.stop(reason);
  }

  stop(reason) {
    if (this.finishedMs !== undefined || this.attempt?.pending) return;
    this.reason ??= reason;
    this.output.interrupt();
    clearTimeout(this.timer);
    this.termination.requested = true;
    this.observe('stop.requested', { reason });
    if (this.rootState === 'exited' || !this.child?.pid) {
      this.status = 'unknown';
      this.termination.requested = true;
      if (this.termination.tree_kill === 'not_requested') this.termination.tree_kill = 'failed';
      this.termination.error = { code: 'STOP_FAILED', message: 'No live owned root is available for a tree-stop attempt.' };
      this.observe('stop.result', { reason });
      this.reconcile();
      return;
    }
    this.status = 'stopping';
    this.termination = { requested: true, tree_kill: 'unconfirmed', attempts: this.termination.attempts + 1 };
    this.observe('stop.attempt', { reason });
    const attempt = { pending: true };
    this.attempt = attempt;
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    this.armCleanup();
    Promise.resolve().then(() => (this.stopProcess ?? stopProcessTree)(this.child)).then(outcome => {
      if (this.attempt === attempt) this.termination.tree_kill = outcome ?? 'unconfirmed';
    }, error => {
      if (this.attempt === attempt) { this.termination.tree_kill = 'failed'; this.termination.error = publicError(error); }
    }).finally(() => {
      attempt.pending = false;
      if (this.attempt === attempt) {
        if (this.termination.tree_kill !== 'succeeded') this.status = 'unknown';
        this.observe('stop.result', { reason });
        this.reconcile();
      }
    });
  }

  armCleanup() {
    if (this.cleanupTimer || this.finishedMs !== undefined) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      if (this.attempt) this.attempt.pending = false;
      if (this.rootState === 'exited' && !this.closed) this.reason ??= 'stream_error';
      this.status = 'unknown';
      this.output.interrupt();
      this.observe('cleanup.unconfirmed');
      this.reconcile();
    }, TASK_BUDGETS.stop_ms);
  }

  reconcile() {
    if (this.finishedMs !== undefined || this.rootState !== 'exited' || !this.closed || this.attempt?.pending) return;
    if (this.termination.requested && this.termination.tree_kill === 'unconfirmed') { this.status = 'unknown'; return; }
    const status = this.termination.requested
      ? this.reason === 'stop_requested' && this.termination.tree_kill === 'succeeded' ? 'stopped' : 'failed'
      : this.exitCode === 0 && !this.reason ? 'completed' : 'failed';
    this.finish(status);
  }

  finish(status) {
    if (this.finishedMs !== undefined) return;
    this.status = status;
    try {
      this.audit(status, { completion_reason: this.reason ?? 'exited', root_state: this.rootState, exit_code: this.exitCode,
        tree_kill: this.termination.tree_kill, ...this.output.metadata() });
    } catch {
      this.auditState = 'failed'; this.reason ??= 'audit_error';
      this.error ??= { code: 'AUDIT_FAILED', message: 'Task result is observable but its audit record could not be saved.' };
      if (this.status === 'completed') this.status = 'failed';
    }
    this.finishedMs = this.now();
    this.finishedAt = new Date(this.finishedMs).toISOString();
    this.observe('final');
    clearTimeout(this.timer); clearTimeout(this.cleanupTimer);
    this.release();
    this.resolveDone();
  }

  snapshot() {
    return { task_id: this.id, status: this.status, root_state: this.rootState, exit_code: this.exitCode, signal: this.signal,
      completion_reason: this.reason ?? (this.finishedMs !== undefined ? 'exited' : null), termination: structuredClone(this.termination), tracking_scope: 'foreground_root_and_attached_tree',
      timeout_ms: this.timeoutMs, output: this.output.metadata(),
      audit: this.auditState, error: this.error ?? null,
      created_at: this.createdAt, started_at: this.startedAt ?? null, finished_at: this.finishedAt ?? null };
  }

  async shutdown() {
    if (this.finishedMs !== undefined) return;
    this.stop('shutdown');
    let timer;
    try {
      await Promise.race([this.done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError('STOP_FAILED', 'Owned task termination remains unconfirmed.')), TASK_BUDGETS.stop_ms);
      })]);
    } finally { clearTimeout(timer); }
  }
}
