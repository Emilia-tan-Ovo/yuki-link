import { openSync, closeSync, fstatSync, readSync } from 'node:fs';

const actions = new Map([
  ['poll timed out; backing off', 'poll-timeout'], ['poll failed; backing off', 'poll-failed'],
  ['poller recovered; polling operational', 'poll-recovered'],
  ['dispatcher forwarded command to MCP server', 'forwarded-to-mcp'],
  ['control-plane proxy closed long poll; lowering future poll timeout', 'poll-timeout-adjusted'],
]);
// Read a bounded tail and project known fields into a fixed vocabulary. Raw log
// strings (including URLs, request IDs, headers and response payloads) never leave.
export function tunnelEvents(file) {
  let fd;
  try {
    fd = openSync(file, 'r'); const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 32 * 1024)); readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    let lines = buffer.toString('utf8').split('\n'); if (size > buffer.length) lines.shift();
    return lines.flatMap(line => {
      try {
        const e = JSON.parse(line), action = actions.get(e.msg);
        if (!action || !Number.isFinite(Date.parse(e.time))) return [];
        return [{ at: new Date(e.time).toISOString(), component: e.component === 'dispatcher' ? 'dispatcher' : 'controlplane', action,
          code: /\b401\b|\b403\b/.test(e.error ?? '') ? 'AUTH_REQUIRED' : /timeout|timed out/i.test(e.error ?? '') ? 'HTTP_TIMEOUT' : /unexpected EOF/.test(e.error ?? '') ? 'UNEXPECTED_EOF' : null }];
      } catch { return []; }
    }).slice(-12);
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}
