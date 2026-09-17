import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, openSync, closeSync, fstatSync, readSync, writeFileSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { BridgeError, redact } from '../errors.js';

const maxBytes = 256 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export class WorkspaceFiles {
  constructor(policy, audit) { this.policy = policy; this.audit = audit; }

  bytes(file) {
    if (!lstatSync(file).isFile()) throw new BridgeError('NOT_A_FILE', 'An ordinary file is required.');
    const descriptor = openSync(file, 'r');
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1) throw new BridgeError('LINK_NOT_ALLOWED', 'Only unlinked ordinary files are supported.');
      if (info.size > maxBytes) throw new BridgeError('FILE_TOO_LARGE', 'MVP file limit is 256 KiB.');
      // The file can grow after fstat. Read at most one byte beyond the limit
      // to detect overflow, and keep reading after short reads until EOF.
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) throw new BridgeError('FILE_TOO_LARGE', 'MVP file limit is 256 KiB.');
      return buffer.subarray(0, length);
    } finally { closeSync(descriptor); }
  }

  text(bytes) {
    if (bytes.includes(0)) throw new BridgeError('NOT_UTF8_TEXT', 'Only UTF-8 text files are supported.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new BridgeError('NOT_UTF8_TEXT', 'Only UTF-8 text files are supported.'); }
    if (redact(text) !== text) throw new BridgeError('SENSITIVE_CONTENT', 'Content resembles credentials and cannot be returned or written by this tool.');
    return text;
  }

  read({ path: input }) {
    const file = this.policy.resolve(input, { intent: 'text-read' });
    const bytes = this.bytes(file);
    const content = this.text(bytes);
    this.audit('filesystem_read', 'completed', { bytes: bytes.length });
    return { path: file, content, bytes: bytes.length, sha256: hash(bytes), encoding: 'utf-8' };
  }

  list({ path: input, cursor = 0, limit = 100 }) {
    const directory = this.policy.resolve(input);
    if (!lstatSync(directory).isDirectory()) throw new BridgeError('NOT_A_DIRECTORY', 'A directory is required.');
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new BridgeError('INVALID_CURSOR', 'Use a nonnegative cursor and limit 1–200.');
    const names = readdirSync(directory).sort();
    const permitted = [];
    for (const name of names) {
      try {
        const itemPath = this.policy.resolve(path.join(directory, name));
        const item = lstatSync(itemPath);
        permitted.push({ name, type: item.isDirectory() ? 'directory' : 'file', bytes: item.isFile() ? item.size : null });
      } catch (error) { if (!(error instanceof BridgeError)) throw error; }
    }
    if (cursor > permitted.length) throw new BridgeError('INVALID_CURSOR', 'Cursor is beyond the directory listing.');
    const entries = permitted.slice(cursor, cursor + limit);
    this.audit('filesystem_list', 'completed', { count: entries.length });
    return { path: directory, entries, next_cursor: cursor + entries.length, has_more: cursor + entries.length < permitted.length };
  }

  write({ path: input, content, expected_sha256 }) {
    const file = this.policy.resolve(input, { write: true, missing: true });
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxBytes) throw new BridgeError('FILE_TOO_LARGE', 'Content must be UTF-8 text up to 256 KiB.');
    const bytes = Buffer.from(content, 'utf8'); this.text(bytes);
    const desiredHash = hash(bytes);
    let exists = true;
    try { lstatSync(file); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (exists) {
      const previous = this.bytes(file);
      this.text(previous);
      const previousHash = hash(previous);
      // Existing no-op compatibility: no mutation, not a successful hash check.
      if (previousHash === desiredHash) return { path: file, sha256: desiredHash, bytes: bytes.length, changed: false };
      if (expected_sha256 === undefined) throw new BridgeError('FILE_EXISTS', 'Pass the current file SHA-256 to replace an existing file.');
      if (previousHash !== expected_sha256) throw new BridgeError('CONTENT_CONFLICT', 'The file content no longer matches expected_sha256.');
    } else if (expected_sha256 !== undefined) throw new BridgeError('CONTENT_CONFLICT', 'The file no longer exists.');
    this.audit('filesystem_write', 'started', { bytes: bytes.length, replacing: exists });
    if (!exists) {
      try { writeFileSync(file, bytes, { flag: 'wx', flush: true }); }
      catch (error) { if (error.code === 'EEXIST') throw new BridgeError('FILE_EXISTS', 'The target appeared before creation.'); throw error; }
    } else {
      const temporary = path.join(path.dirname(file), `.yuki-write-${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: 'wx', flush: true });
      try {
        this.policy.resolve(file, { write: true });
        if (hash(this.bytes(file)) !== expected_sha256) throw new BridgeError('CONTENT_CONFLICT', 'The file changed before replacement.');
        renameSync(temporary, file);
      } catch (error) { unlinkSync(temporary); throw error; }
    }
    this.audit('filesystem_write', 'completed', { bytes: bytes.length });
    return { path: file, sha256: desiredHash, bytes: bytes.length, changed: true };
  }

  move({ source, destination, expected_sha256 }) {
    source = this.policy.resolve(source, { write: true });
    destination = this.policy.resolve(destination, { write: true, missing: true });
    const bytes = this.bytes(source); this.text(bytes);
    const sha256 = hash(bytes);
    if (expected_sha256 !== sha256) throw new BridgeError('CONTENT_CONFLICT', 'Source content no longer matches expected_sha256.');
    if (source === destination) return { source, destination, sha256, changed: false };
    this.audit('filesystem_move', 'started', { bytes: bytes.length });
    // link() provides atomic no-clobber on the same filesystem; rename() can overwrite.
    try { linkSync(source, destination); }
    catch (error) {
      if (error.code === 'EEXIST') throw new BridgeError('FILE_EXISTS', 'Move destination already exists.');
      throw new BridgeError('MOVE_UNAVAILABLE', 'MVP moves require same-volume hard-link support. Neither file was removed.');
    }
    try { unlinkSync(source); }
    catch { throw new BridgeError('MOVE_INCOMPLETE', 'Destination was created but source could not be removed. Both names retain the same file; inspect them locally.'); }
    this.audit('filesystem_move', 'completed', { bytes: bytes.length });
    return { source, destination, sha256, changed: true };
  }
}
