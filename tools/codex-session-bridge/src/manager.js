import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError, publicError, redact } from './errors.js';
import { isProcessAlive } from './process.js';

const ACTIVE = new Set(['queued', 'running', 'stopping']);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();

export class SessionManager {
  constructor({ store, catalog, executor, allowedCwds, defaultTimeoutMs = 300_000, maxOutputBytes = 16 * 1024 * 1024 }) {
    this.store = store;
    this.catalog = catalog;
    this.executor = executor;
    this.allowedCwds = allowedCwds.map(directory => realpathSync(directory));
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.running = new Map();
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
  }

  replay(requestId, hash) {
    if (!Object.hasOwn(this.store.state.requests, requestId)) return null;
    const recorded = this.store.state.requests[requestId];
    if (!recorded) return null;
    if (recorded.fingerprint !== hash) throw new BridgeError('REQUEST_ID_CONFLICT', 'This request_id was already used with different arguments.');
    return { ...this.accepted(this.store.state.runs[recorded.run_id]), deduplicated: true };
  }

  async start(input) {
    this.validateMessage(input);
    const hash = fingerprint(['start', input.cwd, input.prompt, input.sender ?? 'caller', input.model ?? null, input.reasoning ?? null, input.timeout_ms ?? null]);
    const replay = this.replay(input.request_id, hash);
    if (replay) return replay;
    const cwd = this.cwd(input.cwd);
    const config = await this.catalog.validate(input.model ?? 'gpt-6-astra', input.reasoning ?? 'high');
    // Recheck after the only asynchronous boundary: two clients can retry together.
    const concurrentReplay = this.replay(input.request_id, hash);
    if (concurrentReplay) return concurrentReplay;
    const session = { id: randomUUID(), codex_thread_id: null, cwd, model: config.model, reasoning: config.reasoning, created_at: now(), active_run_id: null, last_run_id: null };
    return this.enqueue(session, input, hash, config);
  }

  async send(input) {
    this.validateMessage(input);
    const hash = fingerprint(['send', input.session_id, input.prompt, input.sender ?? 'caller', input.model ?? null, input.reasoning ?? null, input.timeout_ms ?? null]);
    const replay = this.replay(input.request_id, hash);
    if (replay) return replay;
    const session = this.session(input.session_id);
    if (session.active_run_id) throw new BridgeError('SESSION_BUSY', 'This session already has an active run.', { run_id: session.active_run_id });
    if (!session.codex_thread_id) throw new BridgeError('SESSION_NOT_RESUMABLE', 'No Codex thread ID was persisted for this session. Start a new session with a new request_id.');
    this.cwd(session.cwd);
    const config = await this.catalog.validate(input.model ?? session.model, input.reasoning ?? session.reasoning);
    const concurrentReplay = this.replay(input.request_id, hash);
    if (concurrentReplay) return concurrentReplay;
    if (session.active_run_id) throw new BridgeError('SESSION_BUSY', 'This session already has an active run.', { run_id: session.active_run_id });
    return this.enqueue(session, input, hash, config);
  }

  enqueue(session, input, hash, config) {
    if (this.closing) throw new BridgeError('SHUTTING_DOWN', 'Bridge is shutting down.');
    const run = {
      id: randomUUID(), session_id: session.id, request_id: input.request_id,
      sender: redact(input.sender ?? 'caller'), ...config, status: 'queued', created_at: now(),
      started_at: null, finished_at: null, pid: null, event_count: 0,
      timeout_ms: input.timeout_ms ?? this.defaultTimeoutMs, error: null, exit_code: null,
      completed_event: false, final_response: '', config_source: 'explicit_codex_cli_arguments',
    };
    this.store.state.sessions[session.id] = session;
    this.store.state.runs[run.id] = run;
    Object.defineProperty(this.store.state.requests, input.request_id, { value: { fingerprint: hash, run_id: run.id }, enumerable: true, writable: true, configurable: true });
    session.active_run_id = run.id; session.last_run_id = run.id;
    this.store.append(run, 'message.sent', { sender: run.sender, text: input.prompt, model: run.model, reasoning: run.reasoning });
    this.store.save();
    // No process or model completion is awaited by a start/send tool call.
    setImmediate(() => {
      if (run.status === 'queued') this.launch(run, session, input.prompt);
    });
    return this.accepted(run);
  }

  accepted(run) { return { session_id: run.session_id, run_id: run.id, status: run.status, model: run.model, reasoning: run.reasoning, deduplicated: false }; }

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
          clearTimeout(live.timer);
          this.running.delete(run.id);
          run.exit_code = result.code; run.pid = null;
          const error = result.error ? publicError(result.error) : run.error;
          const success = result.code === 0 && run.completed_event && !error && !!session.codex_thread_id;
          this.finish(run, live.stopReason ?? (success ? 'completed' : 'failed'), error ?? (success || live.stopReason ? null : { code: 'CODEX_EXIT_FAILED', message: 'Codex exited without a successful turn completion.' }));
        },
      });
      live.timer = setTimeout(() => this.requestStop(run, 'timed_out', new BridgeError('RUN_TIMEOUT', 'Run exceeded its time limit.')), run.timeout_ms);
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

  session(id) { const value = this.store.state.sessions[id]; if (!Object.hasOwn(this.store.state.sessions, id)) throw new BridgeError('SESSION_NOT_FOUND', 'Unknown bridge session ID.'); return value; }
  run(id) { const value = this.store.state.runs[id]; if (!Object.hasOwn(this.store.state.runs, id)) throw new BridgeError('RUN_NOT_FOUND', 'Unknown bridge run ID.'); return value; }

  status({ session_id, run_id }) {
    if (!session_id && !run_id) throw new BridgeError('MISSING_ID', 'Provide session_id or run_id.');
    const run = run_id ? this.run(run_id) : null;
    const session = this.session(session_id ?? run.session_id);
    if (run && run.session_id !== session.id) throw new BridgeError('ID_MISMATCH', 'run_id belongs to a different session.');
    const selected = run ?? (session.last_run_id ? this.run(session.last_run_id) : null);
    return { session: structuredClone(session), run: selected ? structuredClone(selected) : null, session_status: session.active_run_id ? this.run(session.active_run_id).status : 'idle' };
  }

  output({ run_id, cursor = 0, limit = 100 }) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new BridgeError('INVALID_CURSOR', 'cursor must be non-negative; limit must be 1–200.');
    const run = this.run(run_id);
    return { run_id, status: run.status, ...this.store.output(run, cursor, limit), final_response: ACTIVE.has(run.status) ? null : run.final_response };
  }

  async close() {
    this.closing = true;
    for (const session of Object.values(this.store.state.sessions)) if (session.active_run_id) this.stop(session.id);
    const deadline = Date.now() + 10_000;
    while (this.running.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (this.running.size) throw new BridgeError('STOP_FAILED', 'Some owned runs have not stopped; retain the runtime lock.');
    this.store.close();
  }
}
