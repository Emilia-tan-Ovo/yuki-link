import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const deploymentProtocol = 1;

// Capture once in the service process. Later Git changes must not relabel code
// already loaded in memory. This is local provenance, not a remote attestation.
export function sourceVersion() {
  try {
    const cwd = fileURLToPath(new URL('../../../', import.meta.url));
    const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit = git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(commit)) return null;
    return { commit, dirty: Boolean(git(['status', '--porcelain', '--untracked-files=all'])) };
  } catch { return null; }
}
