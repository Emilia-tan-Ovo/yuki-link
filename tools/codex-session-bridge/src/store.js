import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isProcessAlive } from './process.js';
import { BridgeError, redact } from './errors.js';

export class RuntimeStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.stateFile = path.join(this.directory, 'sessions.json');
    this.lockFile = path.join(this.directory, 'bridge.lock');
    this.lockToken = randomUUID();
    mkdirSync(path.join(this.directory, 'runs'), { recursive: true });
    this.acquire();
    try {
      this.state = existsSync(this.stateFile)
        ? JSON.parse(readFileSync(this.stateFile, 'utf8'))
        : { version: 1, sessions: {}, runs: {}, requests: {} };
      if (this.state.version !== 1 || !this.state.sessions || !this.state.runs || !this.state.requests) throw new BridgeError('STATE_INVALID', 'Unsupported runtime state; preserve the runtime directory for inspection.');
    } catch (error) { this.close(); throw error; }
  }

  acquire() {
    try {
      const descriptor = openSync(this.lockFile, 'wx');
      closeSync(descriptor);
      writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, token: this.lockToken }), { encoding: 'utf8', flush: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(this.lockFile, 'utf8')); }
      catch { throw new BridgeError('RUNTIME_LOCKED', 'Runtime lock is unreadable. Inspect it before restarting.'); }
      if (isProcessAlive(owner.pid)) throw new BridgeError('RUNTIME_LOCKED', 'Another bridge owns this runtime directory.');
      unlinkSync(this.lockFile);
      this.acquire();
    }
  }

  save() {
    const temporary = this.stateFile + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', flush: true });
    renameSync(temporary, this.stateFile);
  }

  eventFile(runId) {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new BridgeError('INVALID_RUN_ID', 'Invalid run ID.');
    return path.join(this.directory, 'runs', runId + '.jsonl');
  }

  append(run, type, data) {
    const event = { seq: run.event_count, at: new Date().toISOString(), session_id: run.session_id, run_id: run.id, type, data };
    appendFileSync(this.eventFile(run.id), JSON.stringify(event, (_key, value) => typeof value === 'string' ? redact(value) : value) + '\n', { encoding: 'utf8', flush: true });
    run.event_count++;
    return event;
  }

  readEvents(run) {
    const file = this.eventFile(run.id);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const lines = text.split('\n');
    // Ignore a partially written final record after a crash.
    if (lines.at(-1) !== '') lines.pop();
    return lines.filter(Boolean).map(line => JSON.parse(line));
  }

  output(run, cursor = 0, limit = 100) {
    const events = this.readEvents(run);
    if (cursor > events.length) throw new BridgeError('INVALID_CURSOR', 'Cursor is beyond this run output.');
    const selected = [];
    let bytes = 0;
    for (const event of events.slice(cursor, cursor + limit)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (selected.length && bytes + size > 512 * 1024) break;
      selected.push(event); bytes += size;
    }
    return { events: selected, next_cursor: cursor + selected.length, has_more: cursor + selected.length < events.length };
  }

  eventBytes(run) {
    const file = this.eventFile(run.id);
    return existsSync(file) ? statSync(file).size : 0;
  }

  repairTail(run) {
    const file = this.eventFile(run.id);
    if (!existsSync(file)) { run.event_count = 0; return; }
    const text = readFileSync(file, 'utf8');
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    // Validate all complete records; never silently discard damaged history.
    const events = complete.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (complete !== text) writeFileSync(file, complete, { encoding: 'utf8', flush: true });
    run.event_count = events.length;
  }

  close() {
    if (!existsSync(this.lockFile)) return;
    const owner = JSON.parse(readFileSync(this.lockFile, 'utf8'));
    if (owner.token === this.lockToken) unlinkSync(this.lockFile);
  }
}
