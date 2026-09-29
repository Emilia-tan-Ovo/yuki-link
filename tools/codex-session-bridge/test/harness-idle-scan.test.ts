import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Harness } from '../src/harness/harness.ts';
import { CodexSource } from '../src/harness/codex-source.ts';
import type { SourceRun, SourceEvent } from '../src/harness/model.ts';

test('idle Harness skips unchanged source history, but append/replacement/error invalidate the observation', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-idle-'));
  const file = path.join(root, 'events.jsonl');
  const session = { id: randomUUID(), cwd: root, codex_thread_id: null, permissions: null };
  const run: SourceRun = { id: randomUUID(), session_id: session.id, created_at: new Date().toISOString(),
    model: 'fixture', reasoning: 'medium', status: 'completed', config_source: 'fixture', timeout_ms: null, exit_code: 0 };
  const event = (seq: number): SourceEvent => ({ seq, at: run.created_at, session_id: session.id, run_id: run.id, type: 'fixture', data: { text: 'history' } });
  writeFileSync(file, JSON.stringify(event(0)) + '\n', 'utf8');
  let reads = 0;
  const source = new CodexSource({ allowedCwds: [root], store: { directory: root, state: { runs: { [run.id]: run } },
    eventFile: () => file, readEvents: () => { reads++; return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } },
    session: () => session, status: () => ({ run, session_status: 'completed' }),
    stopRun: () => ({ outcome: 'idle' }), lookupRequest: () => null });
  source.attribution = () => ({ state: 'matched', expected_worktree: root, observed: {}, mismatches: [], unknown: [], source: 'fixture' });
  source.session = () => session;
  const harness = new Harness(path.join(root, 'runtime'), source);
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  const ticket = harness.register({ project_key: 'idle', project_name: 'idle', ticket_key: 'scan', title: 'scan', reference: 'fixture:scan' });
  harness.attach({ ticket_id: ticket.ticket_id, session_id: session.id });
  const afterAttach = reads;
  for (let n = 0; n < 20; n++) harness.scan();
  assert.equal(reads, afterAttach, '20 idle ticks must not reparse unchanged completed history');
  appendFileSync(file, JSON.stringify(event(1)) + '\n', 'utf8');
  harness.scan();
  assert.equal(reads, afterAttach + 1);
  assert.equal(harness.imported.has(run.id + ':1'), true);
  renameSync(file, file + '.old');
  writeFileSync(file, readFileSync(file + '.old'), 'utf8');
  harness.scan();
  assert.equal(reads, afterAttach + 2, 'same-size replacement is not the same file revision');
  appendFileSync(file, '{partial', 'utf8');
  harness.scan();
  assert.equal(harness.sourceFailure, 'SOURCE_UNAVAILABLE');
  writeFileSync(file, readFileSync(file + '.old'), 'utf8');
  harness.scan();
  assert.equal(harness.sourceFailure, null);
  assert.equal(reads, afterAttach + 3, 'repaired source is read again');
});
