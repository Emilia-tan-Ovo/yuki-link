import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeError } from '../errors.js';

// The JavaScript realpath implementation preserves Windows 8.3 names.
const canonicalPath = realpathSync.native;
const installation = canonicalPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const controlInstallation = path.resolve(installation, '../control-center');
const controlConfiguration = path.resolve(installation, '../../.local/control-center');
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const secretName = /^(?:\.env(?:\..*)?|\.git|\.codex|\.agents|\.ssh|\.aws|\.azure|\.kube|\.npmrc|\.netrc|runtime|secrets?|credentials?|select-key|tunnel-client|auth\.json|.*(?:api[-_]?key|runtime[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token).*|.*\.(?:key|pem|pfx|p12))$/i;

export class PathPolicy {
  constructor(readRoots, writeRoots, runtime) {
    this.readRoots = readRoots.map(root => canonicalPath(root));
    this.writeRoots = writeRoots.map(root => canonicalPath(root));
    this.runtime = canonicalPath(runtime);
  }

  resolve(input, { write = false, missing = false, intent } = {}) {
    // Only a complete text read can cross read roots; directory and mutation
    // callers retain their existing policy, including during canonical recursion.
    const textRead = intent === 'text-read' && !write && !missing;
    if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) throw new BridgeError('INVALID_PATH', 'Use an absolute local filesystem path.');
    // Windows accepts forward and mixed separators in UNC paths too.
    if (process.platform === 'win32' && (input.replaceAll('/', '\\').startsWith('\\\\') || input.slice(2).includes(':'))) throw new BridgeError('INVALID_PATH', 'Network/device paths and alternate data streams are not supported.');
    const target = path.resolve(input);
    const parts = target.slice(path.parse(target).root.length).split(path.sep);
    if (parts.some((part, index) => {
      // Exempt this component only, never all descendants of a Skill directory.
      const skillContainer = textRead && /^(?:\.agents|\.codex)$/i.test(part)
        && /^skills$/i.test(parts[index + 1] ?? '') && index + 2 < parts.length;
      return secretName.test(part) && !skillContainer;
    })) throw new BridgeError('PROTECTED_PATH', 'Credential, agent configuration, Git metadata and runtime paths are protected.');
    if (process.platform === 'win32' && parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new BridgeError('INVALID_PATH', 'Ambiguous Windows filename.');
    if (inside(this.runtime, target)) throw new BridgeError('PROTECTED_PATH', 'Agent runtime is private.');
    if (inside(controlConfiguration, target)) throw new BridgeError('PROTECTED_PATH', 'Local control configuration is private.');
    if (write && (inside(installation, target) || inside(controlInstallation, target) || /^(?:AGENTS|CLAUDE)\.md$/i.test(path.basename(target)))) throw new BridgeError('PROTECTED_PATH', 'The agent installation and instruction files cannot be changed through these tools.');
    const roots = write ? this.writeRoots : this.readRoots;
    if (!textRead && !roots.some(root => inside(root, target))) throw new BridgeError('PATH_NOT_ALLOWED', 'Path is outside the permitted directories.');
    // Walk every component, including junctions. Never follow a user-created link.
    let current = path.parse(target).root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try { info = lstatSync(current); }
      catch (error) {
        if (error.code === 'ENOENT' && missing && index === parts.length - 1) {
          const canonical = path.join(canonicalPath(path.dirname(target)), path.basename(target));
          // Revalidate canonical parent names too: Windows 8.3 aliases can hide
          // protected directories even when the new leaf does not exist yet.
          if (canonical !== target) return this.resolve(canonical, { write, missing, intent });
          return target;
        }
        throw new BridgeError(error.code === 'ENOENT' ? 'PATH_NOT_FOUND' : 'PATH_UNAVAILABLE', 'Path is missing or inaccessible.');
      }
      if (info.isSymbolicLink()) throw new BridgeError('LINK_NOT_ALLOWED', 'Symlinks and junctions are not accepted.');
      if (info.isFile() && info.nlink !== 1) throw new BridgeError('LINK_NOT_ALLOWED', 'Hard-linked files are not accepted.');
      if (!info.isDirectory() && !info.isFile()) throw new BridgeError('PATH_NOT_ALLOWED', 'Only ordinary files and directories are supported.');
    }
    const canonical = canonicalPath(target);
    if (!textRead && !roots.some(root => inside(root, canonical))) throw new BridgeError('PATH_NOT_ALLOWED', 'Resolved path is outside permitted directories.');
    // Root containment alone is insufficient: aliases must not bypass .git,
    // runtime, credential names, instruction files or our own installation.
    if (canonical !== target) return this.resolve(canonical, { write, missing, intent });
    return canonical;
  }
}
