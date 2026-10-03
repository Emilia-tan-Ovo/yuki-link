import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fail } from './common.js';

const script = fileURLToPath(new URL('../scripts/mutation-lock.ps1', import.meta.url));

// The kernel mutex serializes reservation changes; the durable reservation
// keeps a still-running Node callback authoritative after its helper exits.
export async function acquireMutationLock(stateFile, pwsh = 'pwsh.exe', identity = null) {
  const digest = createHash('sha256').update(path.resolve(stateFile).toLowerCase()).digest('hex');
  const reservationFile = `${path.resolve(stateFile)}.mutation-owner.json`;
  const nonce = randomUUID();
  const args = mode => ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, digest,
    reservationFile, nonce, String(process.pid), identity?.instance ?? '', identity?.configId ?? '', mode];
  const owned = () => {
    try {
      const record = JSON.parse(readFileSync(reservationFile, 'utf8'));
      return record.nonce === nonce && record.pid === process.pid;
    } catch { return false; }
  };
  const settleReservation = async () => {
    if (!owned()) return;
    for (let attempt = 0; attempt < 20; attempt++) {
      const settle = spawn(pwsh, args('settle'), { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let response = '';
      settle.stdout.on('data', chunk => { response += chunk.toString('utf8'); });
      await new Promise(resolve => { settle.once('error', resolve); settle.once('exit', resolve); });
      if (response.includes('SETTLED') && !owned()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw fail('MUTATION_LOCK_UNAVAILABLE');
  };
  const child = spawn(pwsh, args('acquire'), {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.once('exit', resolve));
  let line = '';
  const outcome = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(fail('MUTATION_LOCK_UNAVAILABLE')), 10_000);
    const done = value => { clearTimeout(timeout); resolve(value); };
    const bad = () => { clearTimeout(timeout); reject(fail('MUTATION_LOCK_UNAVAILABLE')); };
    child.once('error', bad);
    child.once('exit', bad);
    child.stdout.on('data', chunk => {
      line += chunk.toString('utf8');
      if (line.length > 100 || line.includes('\n')) {
        const first = line.split(/\r?\n/, 1)[0].trim();
        done(first);
      }
    });
  }).catch(async error => { child.stdin.end(); child.kill(); await settleReservation(); throw error; });
  if (outcome !== 'ACQUIRED') {
    child.stdin.end();
    await exited;
    await settleReservation();
    throw fail(outcome === 'BUSY' ? 'LIVE_SUPERVISOR_OWNER' : 'MUTATION_LOCK_UNAVAILABLE');
  }
  return {
    assertHeld() { if (!owned()) throw fail('MUTATION_LOCK_UNAVAILABLE'); },
    async release() {
      child.stdin.end('RELEASE\n');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill();
      // A killed helper cannot settle; do so only after the callback has
      // returned. Other actors continue to see BUSY until this completes.
      await settleReservation();
    },
    // Used only by a regression that kills the helper during a unit call.
    helperPid: child.pid,
  };
}
