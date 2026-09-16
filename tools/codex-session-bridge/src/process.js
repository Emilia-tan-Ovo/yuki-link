import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError } from './errors.js';

export function spawnDirect(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// A decoder must retain incomplete UTF-8 characters across pipe chunks.
export function readLines(stream, onLine, onError, maxBytes = 2 * 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let failed = false;
  const accept = (text, final = false) => {
    if (failed) return;
    buffer += text;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > maxBytes) { failed = true; return onError(new BridgeError('OUTPUT_LIMIT', 'A subprocess output line is too large.')); }
      if (line) {
        try { onLine(line); }
        catch (error) { failed = true; return onError(error); }
      }
    }
    if (Buffer.byteLength(buffer) > maxBytes) { failed = true; return onError(new BridgeError('OUTPUT_LIMIT', 'A subprocess output line is too large.')); }
    if (final && buffer) {
      try { onLine(buffer); buffer = ''; }
      catch (error) { failed = true; onError(error); }
    }
  };
  stream.on('data', chunk => accept(decoder.write(chunk)));
  stream.on('end', () => accept(decoder.end(), true));
  stream.on('error', onError);
}

// Only called with a ChildProcess owned by this bridge, never an input PID.
export async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return 'unconfirmed';
  if (process.platform === 'win32') {
    return await new Promise((resolve, reject) => {
      const killer = spawnDirect('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
      const timer = setTimeout(() => { killer.kill(); reject(new BridgeError('STOP_FAILED', 'Process-tree termination timed out.')); }, 5000);
      killer.stdout.resume(); killer.stderr.resume(); killer.stdin.end();
      killer.on('error', error => { clearTimeout(timer); reject(error); });
      killer.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve('succeeded');
        else if (child.exitCode !== null || child.signalCode !== null) resolve('unconfirmed');
        else reject(new BridgeError('STOP_FAILED', 'Could not terminate the owned process tree.'));
      });
    });
  } else {
    // Executor children are detached process-group leaders on POSIX.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; return 'unconfirmed'; }
    return 'succeeded';
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
