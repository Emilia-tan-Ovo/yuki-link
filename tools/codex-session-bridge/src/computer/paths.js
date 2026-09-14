import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeError } from '../errors.js';

const installation = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const secretName = /^(?:\.env(?:\..*)?|\.git|\.codex|\.agents|\.ssh|\.aws|\.azure|\.kube|\.npmrc|\.netrc|runtime|secrets?|credentials?|select-key|tunnel-client|auth\.json|.*(?:api[-_]?key|runtime[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token).*|.*\.(?:key|pem|pfx|p12))$/i;

export class PathPolicy {
  constructor(readRoots, writeRoots, runtime) {
    this.readRoots = readRoots.map(root => realpathSync(root));
    this.writeRoots = writeRoots.map(root => realpathSync(root));
    this.runtime = path.resolve(runtime);
  }

  resolve(input, { write = false, missing = false } = {}) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) throw new BridgeError('INVALID_PATH', 'Use an absolute local filesystem path.');
    if (process.platform === 'win32' && (input.startsWith('\\\\') || input.slice(2).includes(':'))) throw new BridgeError('INVALID_PATH', 'Network/device paths and alternate data streams are not supported.');
    const target = path.resolve(input);
    const parts = target.slice(path.parse(target).root.length).split(path.sep);
    if (parts.some(part => secretName.test(part))) throw new BridgeError('PROTECTED_PATH', 'Credential, agent configuration, Git metadata and runtime paths are protected.');
    if (process.platform === 'win32' && parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new BridgeError('INVALID_PATH', 'Ambiguous Windows filename.');
    if (inside(this.runtime, target)) throw new BridgeError('PROTECTED_PATH', 'Agent runtime is private.');
    if (write && (inside(installation, target) || /^(?:AGENTS|CLAUDE)\.md$/i.test(path.basename(target)))) throw new BridgeError('PROTECTED_PATH', 'The agent installation and instruction files cannot be changed through these tools.');
    const roots = write ? this.writeRoots : this.readRoots;
    if (!roots.some(root => inside(root, target))) throw new BridgeError('PATH_NOT_ALLOWED', 'Path is outside the permitted directories.');
    // Walk every component, including junctions. Never follow a user-created link.
    let current = path.parse(target).root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try { info = lstatSync(current); }
      catch (error) {
        if (error.code === 'ENOENT' && missing && index === parts.length - 1) return target;
        throw new BridgeError(error.code === 'ENOENT' ? 'PATH_NOT_FOUND' : 'PATH_UNAVAILABLE', 'Path is missing or inaccessible.');
      }
      if (info.isSymbolicLink()) throw new BridgeError('LINK_NOT_ALLOWED', 'Symlinks and junctions are not accepted.');
      if (info.isFile() && info.nlink !== 1) throw new BridgeError('LINK_NOT_ALLOWED', 'Hard-linked files are not accepted.');
      if (!info.isDirectory() && !info.isFile()) throw new BridgeError('PATH_NOT_ALLOWED', 'Only ordinary files and directories are supported.');
    }
    if (!roots.some(root => inside(root, realpathSync(target)))) throw new BridgeError('PATH_NOT_ALLOWED', 'Resolved path is outside permitted directories.');
    return target;
  }
}
