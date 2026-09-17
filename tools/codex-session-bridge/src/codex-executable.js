import path from 'node:path';
import { statSync, readdirSync, accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BridgeError } from './errors.js';

// Cache successful probes only. Every launch still stats the file, so removal or
// replacement invalidates the cache, including while YCA remains running.
const verified = new Map();
const safeCode = code => ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC', 'ETIMEDOUT'].includes(code) ? code : 'ENOEXEC';

export function resolveCodexExecutable(configured = 'codex', { env = process.env, platform = process.platform } = {}) {
  const variable = name => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const deadline = Date.now() + 4000;
  const attempted = new Set();
  const check = file => {
    if (attempted.has(file)) return 'ENOENT';
    attempted.add(file);
    try {
      if (/\.(cmd|bat|ps1)$/i.test(file) || (platform === 'win32' && !/\.(exe|com)$/i.test(file))) return 'ENOEXEC';
      const stat = statSync(file);
      if (!stat.isFile()) return 'ENOEXEC';
      accessSync(file, constants.X_OK);
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (verified.get(file) === stamp) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return 'ETIMEDOUT';
      // No shell/shims or login/model call. Raw output is never returned.
      const probe = spawnSync(file, ['--version'], { shell: false, windowsHide: true, env,
        timeout: Math.min(1500, remaining), maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      if (probe.error || probe.status !== 0) return safeCode(probe.error?.code);
      if (verified.size >= 32) verified.clear();
      verified.set(file, stamp);
      return null;
    } catch (error) { return safeCode(error.code); }
  };
  const explicit = path.isAbsolute(configured) || configured.includes('/') || configured.includes('\\');
  let configuredCode = 'ENOENT';
  if (explicit) {
    const executable = path.resolve(configured);
    configuredCode = check(executable);
    if (!configuredCode) return { executable, source: 'configured', refreshed: false };
  }
  const fromPath = () => (variable('PATH') ?? '').split(platform === 'win32' ? ';' : ':')
    .map(p => p.replace(/^"|"$/g, '')).filter(p => path.isAbsolute(p))
    .map(p => path.join(p, platform === 'win32' ? 'codex.exe' : 'codex'));
  const desktop = () => {
    const local = variable('LOCALAPPDATA');
    if (platform !== 'win32' || !local || !path.isAbsolute(local)) return [];
    const root = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
        const file = path.join(root, e.name, 'codex.exe');
        try { return [{ file, modified: statSync(file).mtimeMs }]; } catch { return []; }
      }).sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file)).map(e => e.file);
    } catch { return []; }
  };
  // Preserve PATH precedence for the default CLI. A stale explicit preference
  // tries the per-user Desktop installation first, without depending on PATH.
  const sources = explicit ? [['desktop', desktop], ['path', fromPath]] : [['path', fromPath], ['desktop', desktop]];
  let discoveryCode = 'ENOENT';
  for (const [source, candidates] of sources) {
    for (const executable of candidates()) {
      const code = check(executable);
      if (!code) return { executable, source, refreshed: explicit, configured_status: explicit ? configuredCode : undefined };
      if (code !== 'ENOENT') discoveryCode = code;
    }
  }
  throw new BridgeError('CODEX_EXECUTABLE_UNAVAILABLE',
    'Configured Codex executable is missing or unusable, and automatic discovery found no usable native CLI. Check the Codex installation or --codex-bin; PATH alone may not be the cause.',
    { configured_status: configuredCode, discovery_status: discoveryCode, spawn_code: configuredCode !== 'ENOENT' ? configuredCode : discoveryCode });
}
