import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const digest = value => hash(JSON.stringify(value));
export function fail(code, details) { return Object.assign(new Error(code), { code, details }); }
export function relativeName(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(part =>
    !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || /^(?:AGENTS\.md|CLAUDE\.md|config\.toml|\.git|\.agents|\.codex|\.env(?:\..*)?)$/i.test(part))) throw fail('INVALID_RELATIVE_PATH');
  return value;
}
// This is validation against accidental redirection, not an OS sandbox or atomic CAS.
export function safePath(input, missing = false) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)
      || (process.platform === 'win32' && (input.replaceAll('/', '\\').startsWith('\\\\') || input.slice(2).includes(':')))) throw fail('INVALID_PATH');
  const absolute = path.resolve(input);
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  if (parts.some(part => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail('INVALID_PATH');
  let current = path.parse(absolute).root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (missing && error.code === 'ENOENT') return path.join(fs.realpathSync.native(path.dirname(current)), ...parts.slice(i)); throw error; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw fail('LINK_NOT_ALLOWED');
    if (!stat.isFile() && !stat.isDirectory()) throw fail('INVALID_FILE_TYPE');
  }
  const canonical = fs.realpathSync.native(current);
  if (canonical.toLowerCase() !== absolute.toLowerCase()) throw fail('PATH_ALIAS');
  return canonical;
}
export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
export function bytes(file) {
  safePath(file);
  const fd = fs.openSync(file, 'r');
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw fail('INVALID_FILE_TYPE');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let length = 0, count;
    do { count = fs.readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
    if (length === buffer.length) throw fail('FILE_TOO_LARGE');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
export function text(buffer) {
  try { if (buffer.includes(0)) throw Error(); return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw fail('NOT_UTF8_TEXT'); }
}
export const readJson = file => JSON.parse(text(bytes(file)));
export function writeNew(file, value) {
  safePath(file, true);
  fs.writeFileSync(file, value, { flag: 'wx', encoding: 'utf8', flush: true });
}
export const writeJson = (file, value) => writeNew(file, JSON.stringify(value, null, 2) + '\n');
export function identity(file) {
  const stat = fs.lstatSync(safePath(file));
  return { dev: stat.dev, ino: stat.ino };
}
export function tree(root) {
  const entries = [];
  function visit(directory, prefix) {
    safePath(directory);
    if (!fs.statSync(directory).isDirectory()) throw fail('NOT_A_DIRECTORY');
    const names = fs.readdirSync(directory).sort();
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw fail('CASE_COLLISION');
    for (const name of names) {
      const file = path.join(directory, name), relative = prefix + name;
      safePath(file);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory', ...identity(file) }); visit(file, relative + '/'); }
      else { const buffer = bytes(file); text(buffer); entries.push({ path: relative, type: 'file', sha256: hash(buffer), size: buffer.length, ...identity(file) }); }
    }
  }
  visit(root, '');
  return entries;
}
