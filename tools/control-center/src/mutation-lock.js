import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fail } from './common.js';

const script = fileURLToPath(new URL('../scripts/mutation-lock.ps1', import.meta.url));

// The Windows kernel owns this mutex for the lifetime of the helper thread.
// It releases on process death, so no filesystem read/unlink reclaim race or
// PID reuse decision can make a second supervisor enter the critical section.
export async function acquireMutationLock(stateFile, pwsh = 'pwsh.exe') {
  const digest = createHash('sha256').update(path.resolve(stateFile).toLowerCase()).digest('hex');
  const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, digest], {
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
  }).catch(error => { child.stdin.end(); child.kill(); throw error; });
  if (outcome !== 'ACQUIRED') {
    child.stdin.end();
    await exited;
    throw fail(outcome === 'BUSY' ? 'LIVE_SUPERVISOR_OWNER' : 'MUTATION_LOCK_UNAVAILABLE');
  }
  let lost = false;
  child.once('exit', () => { lost = true; });
  return {
    assertHeld() { if (lost || child.exitCode !== null) throw fail('MUTATION_LOCK_UNAVAILABLE'); },
    async release() {
      child.stdin.end('\n');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill();
    },
  };
}
