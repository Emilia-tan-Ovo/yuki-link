import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError, publicError, redact } from './errors.js';
import { isProcessAlive } from './process.js';
import { permissionSelectionFingerprint, sessionPermissionSnapshot, validatePermissionSelection } from './permissions.js';
import { DEFAULT_MODEL, DEFAULT_REASONING } from './model-policy.js';

const ACTIVE = new Set(['queued', 'running', 'stopping']);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();

export class SessionManager {
  constructor({ store, catalog, executor, permissionResolver, allowedCwds, timers = globalThis, maxOutputBytes = 16 * 1024 * 1024 }) {
    this.store = store;
    this.catalog = catalog;
    this.executor = executor;
    this.permissionResolver = permissionResolver;
    this.allowedCwds = allowedCwds.map(directory => realpathSync(directory));
    this.timers = timers;
    this.maxOutputBytes = maxOutputBytes;
    this.running = new Map();
    this.observationWaiters = new Set();
    this.closing = false;
    this.recover();
  }

  recover() {
    for (const run of Object.values(this.store.state.runs)) {
      if (!ACTIVE.has(run.status)) continue;
      if (isProcessAlive(run.pid)) throw new BridgeError('ORPHAN_PROCESS', 'A previous run process may still be alive. Inspect it before restarting; the bridge will not kill an unowned PID.', { run_id: run.id, pid: run.pid });
      this.store.repairTail(run);
      // Recover the thread ID if the process crashed between appending its event and saving state.
      const session = this.store.state.sessions[run.session_id];
      const events = this.store.readEvents(run);
      for (const event of events) {
        if (event.type === 'codex' && event.data.type === 'thread.started') {
          session.codex_thread_id = event.data.thread_id;
          session.model = run.model; session.reasoning = run.reasoning;
        }
      }
      run.status = 'interrupted'; run.finished_at = now(); run.pid = null;
      run.error = { code: 'BRIDGE_RESTARTED', message: 'The bridge restarted before the run completed. No automatic replay was performed.' };
      session.active_run_id = null;
      this.store.append(run, 'run.interrupted', run.error);
    }
    this.store.save();
  }

  cwd(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new BridgeError('INVALID_CWD', 'cwd must be an absolute local path.');
    let canonical;
    try { canonical = realpathSync(directory); if (!statSync(canonical).isDirectory()) throw new Error(); }
    catch { throw new BridgeError('INVALID_CWD', 'cwd must be an existing directory.'); }
    const permitted = this.allowedCwds.some(root => {
      const relative = path.relative(root, canonical);
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    });
    if (!permitted) throw new BridgeError('CWD_NOT_ALLOWED', 'cwd is outside the local administrator allowlist.');
    return canonical;
  }

  validateMessage(input) {
    if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.request_id)) throw new BridgeError('INVALID_REQUEST_ID', 'request_id must contain 1–128 letters, digits, dots, colons, underscores or hyphens.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 128 * 1024) throw new BridgeError('INVALID_PROMPT', 'prompt must contain text and be at most 128 KiB in UTF-8.');
    if (input.timeout_ms !== undefined && (!Number.isInteger(input.timeout_ms) || input.timeout_ms < 1000 || input.timeout_ms > 1_800_000)) throw new BridgeError('INVALID_TIMEOUT', 'timeout_ms must be 1000–1800000.');
    if (input.sender !== undefined && (typeof input.sender !== 'string' || input.sender.length > 80)) throw new BridgeError('INVALID_SENDER', 'sender must be at most 80 characters.');
    for (const key of ['model', 'reasoning']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 128 || !input[key].length)) throw new BridgeError('INVALID_MODEL_CONFIG', `${key} must be a non-empty string of at most 128 characters.`);
    validatePermissionSelection(input.permissions);
  }

  replay(requestId, hash, compatibleHashes = []) {
    if (!Object.hasOwn(this.store.state.requests, requestId)) return null;
    const recorded = this.store.state.requests[requestId];
    if (!recorded) return null;
    if (recorded.fingerprint !== hash && !compatibleHashes.includes(recorded.fingerprint)) throw new BridgeError('REQUEST_ID_CONFLICT', 'This request_id was already used with different arguments.');
    return { ...this.accepted(this.store.state.runs[recorded.run_id]), deduplicated: true };
  }

  async start(input) { return this.startWithGuard(input, null); }

  // Internal orchestration seam. The guard runs after async config/permission
  // resolution and before RuntimeStore accepts the request. It must be synchronous.
  async startGuarded(input, guard) {
    if (typeof guard !== 'function') throw new BridgeError('INVALID_DISPATCH_GUARD', 'A synchronous dispatch guard is required.');
    return this.startWithGuard(input, guard);
  }

  async startWithGuard(input, guard) {
    this.validateMessage(input);
    const permissionKey = permissionSelectionFingerprint(input.permissions);
    const legacyHash = input.permissions === undefined
      ? fingerprint(['start', input.cwd, input.prompt, input.sender ?? 'caller', input.model ?? null, input.reasoning ?? null, input.timeout_ms ?? null])
      : null;
    const hash = fingerprint(['start', input.cwd, input.prompt, input.sender ?? 'caller', input.model ?? null, input.reasoning ?? null, input.timeout_ms ?? null, permissionKey]);
    const replay = this.replay(input.request_id, hash, legacyHash ? [legacyHash] : []);
    if (replay) return replay;
    const cwd = this.cwd(input.cwd);
    if (!this.permissionResolver) throw new BridgeError('PERMISSION_RESOLUTION_FAILED', 'No Codex permission resolver is configured.');
    const [config, permissions] = await Promise.all([
      this.catalog.validate(input.model ?? DEFAULT_MODEL, input.reasoning ?? DEFAULT_REASONING),
      this.permissionResolver.resolve(cwd, input.permissions),
    ]);
    // Recheck after asynchronous capability/config discovery: two clients can retry together.
    const concurrentReplay = this.replay(input.request_id, hash, legacyHash ? [legacyHash] : []);
    if (concurrentReplay) return concurrentReplay;
    const session = { id: randomUUID(), codex_thread_id: null, cwd, model: config.model, reasoning: config.reasoning, permissions, created_at: now(), active_run_id: null, last_run_id: null };
    if (guard) {
      const result = guard(Object.freeze({ request_id: input.request_id, fingerprint: hash, cwd,
        config: structuredClone(config), permissions: structuredClone(permissions), launch: Object.freeze({
          prompt_sha256: createHash('sha256').update(input.prompt).digest('hex'),
          prompt_utf8_bytes: Buffer.byteLength(input.prompt, 'utf8'), sender: input.sender ?? null,
          model: input.model ?? null, reasoning: input.reasoning ?? null, timeout_ms: input.timeout_ms ?? null,
          permission_selection: permissionKey,
        }) }));
      if (result && typeof result.then === 'function') throw new BridgeError('INVALID_DISPATCH_GUARD', 'The dispatch guard must not await.');
    }
    return this.enqueue(session, input, hash, config, Boolean(guard));
  }

  async send(input) {
    if (input.permissions !== undefined) throw new BridgeError('PERMISSION_CHANGE_REQUIRES_NEW_SESSION', 'Create a new session to use a different Codex permission mode.');
    this.validateMessage(input);
    const hash = fingerprint(['send', input.session_id, input.prompt, input.sender ?? 'caller', input.model ?? null, input.reasoning ?? null, input.timeout_ms ?? null]);
    const replay = this.replay(input.request_id, hash);
    if (replay) return replay;
    const session = this.session(input.session_id);
    sessionPermissionSnapshot(session);
    if (session.active_run_id) throw new BridgeError('SESSION_BUSY', 'This session already has an active run.', { run_id: session.active_run_id });
    if (!session.codex_thread_id) throw new BridgeError('SESSION_NOT_RESUMABLE', 'No Codex thread ID was persisted for this session. Start a new session with a new request_id.');
    this.cwd(session.cwd);
    const config = await this.catalog.validate(input.model ?? session.model, input.reasoning ?? session.reasoning);
    const concurrentReplay = this.replay(input.request_id, hash);
    if (concurrentReplay) return concurrentReplay;
    if (session.active_run_id) throw new BridgeError('SESSION_BUSY', 'This session already has an active run.', { run_id: session.active_run_id });
    return this.enqueue(session, input, hash, config);
  }

  enqueue(session, input, hash, config, immediate = false) {
    if (this.closing) throw new BridgeError('SHUTTING_DOWN', 'Bridge is shutting down.');
    const run = {
      id: randomUUID(), session_id: session.id, request_id: input.request_id,
      sender: redact(input.sender ?? 'caller'), ...config, status: 'queued', created_at: now(),
      started_at: null, finished_at: null, pid: null, event_count: 0,
      timeout_ms: input.timeout_ms ?? null, error: null, exit_code: null,
      completed_event: false, final_response: '', config_source: Object.hasOwn(session, 'permissions') ? 'session_permission_snapshot' : 'legacy_explicit_codex_cli_arguments',
    };
    const previousSession = Object.hasOwn(this.store.state.sessions, session.id) ? structuredClone(session) : null;
    try {
      this.store.state.sessions[session.id] = session;
      this.store.state.runs[run.id] = run;
      Object.defineProperty(this.store.state.requests, input.request_id, { value: { fingerprint: hash, run_id: run.id }, enumerable: true, writable: true, configurable: true });
      session.active_run_id = run.id; session.last_run_id = run.id;
      this.store.append(run, 'message.sent', { sender: run.sender, text: input.prompt, model: run.model, reasoning: run.reasoning });
      this.store.save();
    } catch {
      // save() atomically replaces the snapshot only after all writes succeed.
      // A leftover unreferenced log is diagnostic evidence, never a runnable job.
      delete this.store.state.runs[run.id];
      delete this.store.state.requests[input.request_id];
      if (previousSession) Object.assign(session, previousSession);
      else delete this.store.state.sessions[session.id];
      throw new BridgeError('PERSISTENCE_FAILED', 'Could not durably accept this request. No process was launched. Retry the same request_id after fixing local storage.');
    }
    // No process or model completion is awaited by a start/send tool call.
    if (immediate) this.launch(run, session, input.prompt);
    else setImmediate(() => {
      if (run.status === 'queued') this.launch(run, session, input.prompt);
    });
    return this.accepted(run);
  }

  // Read-only, exact durable lookup for orchestration reconciliation.
  lookupRequest(requestId) {
    if (typeof requestId !== 'string' || !Object.hasOwn(this.store.state.requests, requestId)) return null;
    const request = this.store.state.requests[requestId];
    if (!request || typeof request.fingerprint !== 'string' || typeof request.run_id !== 'string') {
      throw new BridgeError('RUNTIME_STATE_CONFLICT', 'Runtime request mapping is invalid.', { request_id: requestId });
    }
    const run = this.store.state.runs[request.run_id];
    if (!run || run.request_id !== requestId) throw new BridgeError('RUNTIME_STATE_CONFLICT', 'Runtime request does not match its run.', { request_id: requestId });
    const session = this.store.state.sessions[run.session_id];
    if (!session || session.id !== run.session_id) throw new BridgeError('RUNTIME_STATE_CONFLICT', 'Runtime run does not match a session.', { request_id: requestId });
    return { request_id: requestId, fingerprint: request.fingerprint, session_id: session.id,
      run_id: run.id, status: run.status };
  }

  accepted(run) {
    const session = this.store.state.sessions[run.session_id];
    return { session_id: run.session_id, run_id: run.id, status: run.status, model: run.model, reasoning: run.reasoning, permissions: sessionPermissionSnapshot(session), timeout_ms: run.timeout_ms ?? null, deduplicated: false };
  }

  launch(run, session, prompt) {
    run.status = 'running'; run.started_at = now();
    this.store.append(run, 'run.started', { model: run.model, reasoning: run.reasoning });
    this.store.save();
    const live = { handle: null, timer: null, stopReason: null };
    this.running.set(run.id, live);
    try {
      live.handle = this.executor.start(run, session, prompt, {
        onSpawn: pid => { run.pid = pid; this.store.save(); },
        onEvent: event => {
          if (live.stopReason) return;
          if (this.store.eventBytes(run) + Buffer.byteLength(JSON.stringify(event)) > this.maxOutputBytes) return this.requestStop(run, 'failed', new BridgeError('OUTPUT_LIMIT', 'Run output limit exceeded.'));
          if (event.type === 'thread.started') {
            if (typeof event.thread_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(event.thread_id)) throw new BridgeError('INVALID_THREAD_ID', 'Codex returned an invalid thread ID.');
            if (session.codex_thread_id && session.codex_thread_id !== event.thread_id) throw new BridgeError('THREAD_MISMATCH', 'Codex resumed a different thread.');
          }
          this.store.append(run, 'codex', event);
          if (event.type === 'thread.started') {
            session.codex_thread_id = event.thread_id;
            session.model = run.model; session.reasoning = run.reasoning;
            this.store.save();
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') run.final_response = redact(event.item.text ?? '');
          if (event.type === 'turn.completed') { run.completed_event = true; run.usage = event.usage; }
          if (event.type === 'turn.failed') run.error = { code: 'CODEX_TURN_FAILED', message: redact(event.error?.message ?? 'Codex turn failed.') };
          // A transient error event can be followed by a successful retry; retain it in the log.
        },
        onStderr: line => {
          if (live.stopReason) return;
          if (this.store.eventBytes(run) + Buffer.byteLength(line) > this.maxOutputBytes) return this.requestStop(run, 'failed', new BridgeError('OUTPUT_LIMIT', 'Run output limit exceeded.'));
          this.store.append(run, 'stderr', { text: line });
        },
        onDone: result => {
          if (live.timer !== null) this.timers.clearTimeout(live.timer);
          this.running.delete(run.id);
          run.exit_code = result.code; run.pid = null;
          const error = result.error ? publicError(result.error) : run.error;
          const success = result.code === 0 && run.completed_event && !error && !!session.codex_thread_id;
          this.finish(run, live.stopReason ?? (success ? 'completed' : 'failed'), error ?? (success || live.stopReason ? null : { code: 'CODEX_EXIT_FAILED', message: 'Codex exited without a successful turn completion.' }));
        },
      });
      if (run.timeout_ms !== null && this.running.has(run.id)) {
        live.timer = this.timers.setTimeout(() => this.requestStop(run, 'timed_out', new BridgeError('RUN_TIMEOUT', 'Run exceeded its time limit.')), run.timeout_ms);
      }
    } catch (error) {
      this.running.delete(run.id);
      this.finish(run, 'failed', publicError(error));
    }
  }

  finish(run, status, error = null) {
    run.status = status; run.error = error; run.finished_at = now();
    const session = this.session(run.session_id);
    if (session.active_run_id === run.id) session.active_run_id = null;
    this.store.append(run, `run.${status}`, { error, exit_code: run.exit_code });
    this.store.save();
  }

  requestStop(run, reason, error = null) {
    const live = this.running.get(run.id);
    if (!live || live.stopReason) return;
    live.stopReason = reason;
    if (error) run.error = publicError(error);
    run.status = 'stopping'; this.store.save();
    live.handle.stop().catch(stopError => {
      run.error = publicError(stopError);
      this.store.append(run, 'stop.failed', run.error); this.store.save();
      // Keep the session locked; do not pretend a still-running process stopped.
    });
  }

  stop(sessionId) {
    const session = this.session(sessionId);
    if (!session.active_run_id) return { session_id: sessionId, status: 'idle', stopped: false };
    const run = this.run(session.active_run_id);
    if (run.status === 'queued') this.finish(run, 'stopped');
    else this.requestStop(run, 'stopped');
    return { ...this.accepted(run), stopped: run.status === 'stopped' };
  }

  // Harness-only exact target guard. The public MCP stop(session_id) contract
  // intentionally remains unchanged.
  stopRun(sessionId, runId) {
    const session = this.session(sessionId);
    const run = this.run(runId);
    if (run.session_id !== session.id) throw new BridgeError('ID_MISMATCH', 'run_id belongs to a different session.');
    if (!ACTIVE.has(run.status)) return { outcome: 'already_terminal', ...this.accepted(run) };
    if (session.active_run_id !== run.id) return { outcome: 'active_run_changed', ...this.accepted(run), active_run_id: session.active_run_id };
    if (run.status === 'queued') this.finish(run, 'stopped');
    else this.requestStop(run, 'stopped');
    return { outcome: 'requested', ...this.accepted(run) };
  }

  session(id) { const value = this.store.state.sessions[id]; if (!Object.hasOwn(this.store.state.sessions, id)) throw new BridgeError('SESSION_NOT_FOUND', 'Unknown bridge session ID.'); return value; }
  run(id) { const value = this.store.state.runs[id]; if (!Object.hasOwn(this.store.state.runs, id)) throw new BridgeError('RUN_NOT_FOUND', 'Unknown bridge run ID.'); return value; }

  status({ session_id, run_id }) {
    if (!session_id && !run_id) throw new BridgeError('MISSING_ID', 'Provide session_id or run_id.');
    const run = run_id ? this.run(run_id) : null;
    const session = this.session(session_id ?? run.session_id);
    if (run && run.session_id !== session.id) throw new BridgeError('ID_MISMATCH', 'run_id belongs to a different session.');
    const selected = run ?? (session.last_run_id ? this.run(session.last_run_id) : null);
    const sessionView = structuredClone(session);
    sessionView.permissions = sessionPermissionSnapshot(session);
    return { session: sessionView, run: selected ? structuredClone(selected) : null, session_status: session.active_run_id ? this.run(session.active_run_id).status : 'idle' };
  }

  async output({ run_id, cursor = 0, limit = 100, wait_ms = 0 }, { signal } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new BridgeError('INVALID_CURSOR', 'cursor must be non-negative; limit must be 1–200.');
    if (!Number.isInteger(wait_ms) || wait_ms < 0 || wait_ms > 60_000) throw new BridgeError('INVALID_WAIT', 'wait_ms must be 0–60000.');
    if (signal?.aborted) throw new BridgeError('OBSERVATION_CANCELLED', 'Output observation was cancelled. The run continues independently.');
    const run = this.run(run_id);
    const snapshot = () => {
      const output = this.store.output(run, cursor, limit);
      const returnReason = output.events.length ? 'events' : (ACTIVE.has(run.status) ? 'wait_elapsed' : 'terminal');
      return { run_id, status: run.status, ...output, final_response: ACTIVE.has(run.status) ? null : run.final_response, return_reason: returnReason };
    };
    let result = snapshot();
    if (result.return_reason !== 'wait_elapsed' || wait_ms === 0) return result;
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let unsubscribe = () => {};
      const onAbort = () => finish(new BridgeError('OBSERVATION_CANCELLED', 'Output observation was cancelled. The run continues independently.'));
      const ready = () => run.event_count > cursor || !ACTIVE.has(run.status);
      const waiter = { cancel: error => finish(error) };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer !== null) this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.observationWaiters.delete(waiter);
        if (error) reject(error); else resolve();
      };
      this.observationWaiters.add(waiter);
      unsubscribe = this.store.subscribe(run.id, finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = this.timers.setTimeout(finish, wait_ms);
      if (ready()) finish();
    });
    result = snapshot();
    return result;
  }

  // Stop this execution source without releasing the shared runtime writer.
  // Other sources may still have unconfirmed processes or pending records.
  async stopRuns() {
    this.closing = true;
    for (const session of Object.values(this.store.state.sessions)) if (session.active_run_id) this.stop(session.id);
    const deadline = Date.now() + 10_000;
    while (this.running.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (this.running.size) {
      for (const waiter of [...this.observationWaiters]) waiter.cancel(new BridgeError('BRIDGE_CLOSED', 'Bridge closed while observing output.'));
      throw new BridgeError('STOP_FAILED', 'Some owned runs have not stopped; retain the runtime lock.');
    }
    for (const waiter of [...this.observationWaiters]) waiter.cancel(new BridgeError('BRIDGE_CLOSED', 'Bridge closed while observing output.'));
  }

  async close() {
    await this.stopRuns();
    this.harness?.close();
    this.store.close();
  }
}
