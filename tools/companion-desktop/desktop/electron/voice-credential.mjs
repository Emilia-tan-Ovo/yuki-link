import { readFile, open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { normalizeCredential } from './credential.mjs';
const run = promisify(execFile);
export function voiceAclHelperPath({ isPackaged = false, resourcesPath } = {}) {
  return isPackaged ? join(resourcesPath, 'app.asar.unpacked', 'desktop', 'electron', 'private-voice-directory.ps1') : fileURLToPath(new URL('./private-voice-directory.ps1', import.meta.url));
}
export function privateVoiceDirectory(appPaths) {
  const helper = voiceAclHelperPath(appPaths);
  return async (directory, action) => {
    if (process.platform !== 'win32') throw Error('VOICE_STORAGE_UNAVAILABLE');
    await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', helper, '-Target', directory, '-Action', action], { windowsHide: true, timeout: 10000 });
  };
}
// Secret and private paths never leave main except the key sent to its own worker.
export class VoiceCredentialStore {
  constructor(directory, safeStorage, protect = privateVoiceDirectory()) { this.directory = join(directory, 'voice-private'); this.file = join(this.directory, 'voice-credential.bin'); this.crypto = safeStorage; this.protect = protect; this.queue = Promise.resolve(); }
  async read() {
    try {
      if (!this.crypto.isEncryptionAvailable()) return '';
      await this.protect(this.directory, 'verify');
      const info = await lstat(this.file); if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) return '';
      return normalizeCredential(this.crypto.decryptString(await readFile(this.file)));
    } catch { return ''; }
  }
  async importFile(file) {
    const operation = this.queue.then(async () => {
      if (!this.crypto.isEncryptionAvailable()) throw Error('VOICE_STORAGE_UNAVAILABLE');
      const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('VOICE_CREDENTIAL_INVALID');
      const raw = await readFile(file); let encrypted;
      try { encrypted = this.crypto.encryptString(normalizeCredential(raw.toString('utf8'))); } finally { raw.fill(0); }
      await mkdir(this.directory, { recursive: true }); await this.protect(this.directory, 'restrict');
      const temporary = join(this.directory, randomUUID() + '.tmp');
      try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
        await this.protect(this.directory, 'verify'); await rename(temporary, this.file);
      } finally { encrypted.fill(0); await unlink(temporary).catch(() => {}); }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
}
