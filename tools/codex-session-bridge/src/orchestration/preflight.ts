import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const invalidation = 'Reprobe after PATH, executable, worktree, Node, package manifest or lockfile changes.';

export function inspectHostCapabilities(worktree: string, env: NodeJS.ProcessEnv = process.env,
  versionProbe: (executable: string, args: string[], environment: NodeJS.ProcessEnv) => string | null
    = (executable, args, environment) => {
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024,
      windowsHide: true, env: environment });
    return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
  }) {
  const observed_at = new Date().toISOString(), root = realpathSync(worktree), pathValue = env.PATH ?? '';
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const find = (name: string) => {
    for (const directory of pathValue.split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      for (const extension of extensions) {
        const candidate = path.join(directory, name + extension.toLowerCase());
        try {
          const stat = lstatSync(candidate);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const canonical = realpathSync(candidate);
          if (inside(root, canonical)) continue;
          return { state: 'available' as const, canonical_path: canonical,
            identity: { size: stat.size, mtime_ms: stat.mtimeMs } };
        } catch { /* Continue searching PATH. */ }
      }
    }
    return { state: 'unavailable' as const, reason: 'not-on-target-process-path' };
  };
  const rg = find('rg'), git = find('git'), pwsh = find('pwsh'), npm = find('npm');
  const verified = (candidate: ReturnType<typeof find>, args: string[]) => {
    if (candidate.state !== 'available') return candidate;
    try {
      const version = versionProbe(candidate.canonical_path, args, env);
      return version ? { ...candidate, version }
        : { state: 'unavailable' as const, reason: 'version-probe-failed' };
    } catch { return { state: 'unavailable' as const, reason: 'version-probe-failed' }; }
  };
  const checkedRg = verified(rg, ['--version']);
  const checkedGit = verified(git, ['--version']);
  const checkedPwsh = verified(pwsh, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  return { observed_at, worktree: root, path_digest: sha(pathValue), invalidation,
    rg: checkedRg, git: checkedGit, pwsh: checkedPwsh, npm, node: { path: process.execPath, version: process.version },
    fallbacks: [checkedGit.state === 'available' ? 'git grep' : null,
      checkedPwsh.state === 'available' ? 'PowerShell Select-String' : null]
      .filter((value): value is string => Boolean(value)) };
}

export function inspectDependency(worktree: string, packageDirectory: string) {
  const observed_at = new Date().toISOString(), root = realpathSync(worktree);
  const directory = path.resolve(root, packageDirectory), relative = path.relative(root, directory);
  const base = { package_directory: packageDirectory, observed_at, worktree: root,
    node: { path: process.execPath, version: process.version }, invalidation };
  if (!inside(root, directory) || relative !== packageDirectory.replaceAll('/', path.sep))
    return { ...base, state: 'blocked' as const, reason: 'invalid-package-path' };
  try {
    if (!inside(root, realpathSync(directory))) throw new Error('package-outside-worktree');
    const packageFile = path.join(directory, 'package.json'), lockFile = path.join(directory, 'package-lock.json');
    const manifestBytes = readFileSync(packageFile);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const wanted = { ...manifest.dependencies, ...manifest.devDependencies };
    if (!Object.keys(wanted).length && !existsSync(lockFile)) return { ...base,
      manifest_sha256: sha(manifestBytes), lock_sha256: null, state: 'ready' as const,
      reason: 'no-dependencies', modules_mtime_ms: null };
    const lockBytes = readFileSync(lockFile);
    const lock = JSON.parse(lockBytes.toString('utf8'));
    const locked = { ...lock.packages?.['']?.dependencies, ...lock.packages?.['']?.devDependencies };
    const evidence = { manifest_sha256: sha(manifestBytes), lock_sha256: sha(lockBytes) };
    if (JSON.stringify(Object.entries(wanted).sort()) !== JSON.stringify(Object.entries(locked).sort()))
      return { ...base, ...evidence, state: 'blocked' as const, reason: 'lockfile-drift' };
    if (!Object.keys(wanted).length) return { ...base, ...evidence, state: 'ready' as const,
      reason: null, modules_mtime_ms: null };
    const modules = path.join(directory, 'node_modules');
    if (!existsSync(modules)) return { ...base, ...evidence, state: 'missing' as const, reason: 'node-modules-missing' };
    if (lstatSync(modules).isSymbolicLink() || !statSync(modules).isDirectory()
      || !inside(root, realpathSync(modules))) return { ...base, ...evidence, state: 'blocked' as const, reason: 'modules-untrusted' };
    const require = createRequire(packageFile);
    for (const name of Object.keys(wanted)) {
      let resolved = false;
      try { resolved = statSync(require.resolve(name)).isFile(); } catch { /* Some ESM packages expose subpaths only. */ }
      if (!resolved) {
        try {
          const installed = path.join(modules, name), packageJson = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
          if (name.startsWith('@types/')) {
            const typings = path.resolve(installed, packageJson.types ?? packageJson.typings ?? 'index.d.ts');
            resolved = inside(realpathSync(installed), realpathSync(typings)) && statSync(typings).isFile();
          }
          const exports = packageJson.exports;
          const leaves = (value: unknown): string[] => typeof value === 'string' ? [value]
            : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [];
          resolved ||= leaves(exports).some(value => {
            if (!value.startsWith('./') || value.includes('*')) return false;
            const target = path.resolve(installed, value);
            try { return inside(realpathSync(installed), realpathSync(target)) && statSync(target).isFile(); }
            catch { return false; }
          });
        } catch { /* A missing package remains missing. */ }
      }
      if (!resolved) return { ...base, ...evidence, state: 'missing' as const,
        reason: 'module-unresolved', module: name };
    }
    return { ...base, ...evidence, state: 'ready' as const, reason: null,
      modules_mtime_ms: statSync(modules).mtimeMs };
  } catch {
    return { ...base, state: 'blocked' as const, reason: 'package-or-lockfile-unavailable' };
  }
}
