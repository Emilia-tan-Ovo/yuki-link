import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tunnelEvents } from '../src/tunnel-events.js';
import { Events } from '../src/common.js';

test('diagnostic projection removes keys, URLs, headers and arbitrary child text; logs rotate', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-log-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'yuki-cc-log-'))); rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'native.log');
  writeFileSync(file, JSON.stringify({ time: '2026-09-16T12:00:00Z', msg: 'poll failed; backing off', component: 'controlplane',
    error: '401 Authorization: Bearer fake-private-value; Cookie: session=private; api_key=sk-secret-test', tunnel_id: 'private-tunnel', command: 'private-command', env: { token: 'private-token' } }) + '\n'
    + JSON.stringify({ time: '2026-09-16T12:00:01Z', msg: 'unknown arbitrary secret', component: 'private-token' }) + '\n');
  const text = JSON.stringify(tunnelEvents(file)); assert.match(text, /AUTH_REQUIRED/); assert.ok(!/private|Bearer|Cookie|api_key|secret|command/.test(text));
  const events = new Events(root); writeFileSync(events.file, 'x'.repeat(300 * 1024)); events.add('yca', 'start', 'Bearer secret');
  assert.ok(readFileSync(events.file + '.1').length >= 300 * 1024);
  assert.ok(!readFileSync(events.file, 'utf8').includes('secret'));
});
