import { lstat, realpath, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizeMouth } from '../live2d-mouth.mjs';

export const RESOURCE_LIMITS = Object.freeze({ json: 1024 * 1024, moc: 64 * 1024 * 1024, textures: 32, declarations: 256, total: 256 * 1024 * 1024, rgba: 256 * 1024 * 1024 });
class ResourceError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ResourceError(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function resourcePath(value) {
  if (typeof value !== 'string' || !value || /[\\:%\x00-\x1f?#]/.test(value) || isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('RESOURCE_PATH_INVALID');
  return value;
}
export function localRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f]/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || value.split(/[\\/]/).some(p => p === '.' || p === '..') || value.slice(2).includes(':')) fail('RESOURCE_ROOT_INVALID');
  return resolve(value);
}
function inside(root, file) { const part = relative(root, file); return part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); }
function ancestors(file) { const paths = []; let current = file; while (true) { paths.push(current); const parent = dirname(current); if (parent === current) return paths; current = parent; } }
// Node lstat detects symlinks/junctions; Windows also has non-symlink reparse tags.
// Inspect attributes with the host's PowerShell 7. Unknown inspection fails closed.
async function rejectReparse(paths) {
  if (process.platform !== 'win32') return;
  const unique = [...new Set(paths.flatMap(ancestors))];
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); try { $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; foreach ($path in $paths) { $item = Get-Item -LiteralPath $path -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 } }; [Console]::Out.Write('OK') } catch { exit 3 }";
  await new Promise((done, reject) => {
    const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new ResourceError('RESOURCE_INSPECTION_UNAVAILABLE')); }, 10000);
    child.on('error', () => { clearTimeout(timer); reject(new ResourceError('RESOURCE_INSPECTION_UNAVAILABLE')); });
    child.stdout.on('data', bytes => { output += bytes; });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && output === 'OK') done(); else reject(new ResourceError(code === 2 ? 'RESOURCE_REPARSE' : 'RESOURCE_INSPECTION_UNAVAILABLE')); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(unique));
  });
}
async function checkedPath(root, name) {
  resourcePath(name); const file = resolve(root, name);
  if (!inside(root, file)) fail('RESOURCE_PATH_INVALID');
  for (const part of ancestors(file)) {
    const info = await lstat(part);
    if (info.isSymbolicLink()) fail('RESOURCE_REPARSE');
    if (part !== file && !info.isDirectory()) fail('RESOURCE_FILE_TYPE');
  }
  const canonical = await realpath(file);
  if (canonical !== file || !inside(root, canonical)) fail('RESOURCE_REPARSE');
  return file;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function readBounded(root, name, limit) {
  const file = await checkedPath(root, name), before = await lstat(file);
  if (!before.isFile()) fail('RESOURCE_FILE_TYPE');
  if (before.size > limit) fail('RESOURCE_BUDGET');
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameFile(before, info)) fail('RESOURCE_CHANGED');
    const bytes = Buffer.alloc(info.size); let at = 0;
    while (at < bytes.length) { const read = await handle.read(bytes, at, bytes.length - at, at); if (!read.bytesRead) fail('RESOURCE_CHANGED'); at += read.bytesRead; }
    if (!sameFile(info, await handle.stat()) || !sameFile(info, await lstat(file)) || await checkedPath(root, name) !== file) fail('RESOURCE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
function declarations(model) {
  const refs = model?.FileReferences;
  if (model?.Version !== 3 || !refs || typeof refs !== 'object' || Array.isArray(refs)) fail('MODEL_SCHEMA_INVALID');
  if (Object.keys(refs).some(k => !['Moc','Textures','Physics','Pose','UserData','DisplayInfo','Expressions','Motions'].includes(k))) fail('REFERENCE_TYPE_UNKNOWN');
  if (typeof refs.Moc !== 'string' || !refs.Moc.endsWith('.moc3') || !Array.isArray(refs.Textures) || !refs.Textures.length) fail('MODEL_SCHEMA_INVALID');
  if (refs.Textures.length > RESOURCE_LIMITS.textures) fail('RESOURCE_BUDGET');
  if (refs.Textures.some(p => typeof p !== 'string' || !p.endsWith('.png'))) fail('MODEL_SCHEMA_INVALID');
  const result = [];
  const add = (value, suffix) => {
    if (result.length >= RESOURCE_LIMITS.declarations) fail('RESOURCE_BUDGET');
    resourcePath(value); if (!value.endsWith(suffix)) fail('MODEL_SCHEMA_INVALID'); result.push(value);
  };
  add(refs.Moc, '.moc3'); for (const texture of refs.Textures) add(texture, '.png');
  for (const [key, suffix] of [['Physics','.physics3.json'],['Pose','.pose3.json'],['UserData','.userdata3.json'],['DisplayInfo','.cdi3.json']]) if (Object.hasOwn(refs, key)) add(refs[key], suffix);
  if (Object.hasOwn(refs, 'Expressions')) {
    if (!Array.isArray(refs.Expressions)) fail('MODEL_SCHEMA_INVALID');
    for (const expression of refs.Expressions) {
      if (!expression || typeof expression.Name !== 'string' || Object.keys(expression).some(k => !['Name','File'].includes(k))) fail('MODEL_SCHEMA_INVALID');
      add(expression.File, '.exp3.json');
    }
  }
  if (Object.hasOwn(refs, 'Motions')) {
    if (!refs.Motions || typeof refs.Motions !== 'object' || Array.isArray(refs.Motions)) fail('MODEL_SCHEMA_INVALID');
    for (const group of Object.values(refs.Motions)) {
      if (!Array.isArray(group)) fail('MODEL_SCHEMA_INVALID');
      for (const motion of group) {
        if (!motion || typeof motion !== 'object') fail('MODEL_SCHEMA_INVALID');
        if (Object.keys(motion).some(k => !['File','FadeInTime','FadeOutTime'].includes(k))) fail('REFERENCE_TYPE_UNKNOWN');
        for (const key of ['FadeInTime','FadeOutTime']) if (Object.hasOwn(motion, key) && !Number.isFinite(motion[key])) fail('MODEL_SCHEMA_INVALID');
        add(motion.File, '.motion3.json');
      }
    }
  }
  return result;
}
export async function validateModelResources({ root, entry, expectedRevision, mouth = null }) {
  try {
    root = localRoot(root); resourcePath(entry);
    if (!entry.endsWith('.model3.json')) fail('MODEL_SCHEMA_INVALID');
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) fail('RESOURCE_REPARSE');
    await checkedPath(root, entry);
    await rejectReparse([resolve(root, entry)]);
    const entryBytes = await readBounded(root, entry, RESOURCE_LIMITS.json);
    let model; try { model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entryBytes)); } catch { fail('MODEL_JSON_INVALID'); }
    const declared = declarations(model);
    declared.forEach(resourcePath);
    const names = [...new Set(declared.map(name => posix.join(posix.dirname(entry), name)))];
    for (const name of names) await checkedPath(root, name);
    await rejectReparse(names.map(name => resolve(root, name)));
    const files = [{ path: entry, size: entryBytes.length, hash: hash(entryBytes) }]; let total = entryBytes.length;
    for (const name of names) {
      const limit = name === posix.join(posix.dirname(entry), model.FileReferences.Moc) ? Math.min(RESOURCE_LIMITS.moc, RESOURCE_LIMITS.total - total) : RESOURCE_LIMITS.total - total;
      const bytes = await readBounded(root, name, limit); total += bytes.length;
      files.push({ path: name, size: bytes.length, hash: hash(bytes) });
    }
    await rejectReparse([root, ...files.map(f => resolve(root, f.path))]);
    const revision = hash(JSON.stringify(files.slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
    if (expectedRevision !== undefined && expectedRevision !== revision) fail('RESOURCE_CHANGED');
    const mapping = normalizeMouth(mouth);
    const groups = Array.isArray(model.Groups) ? model.Groups.filter(g => g?.Target === 'Parameter' && g.Name === 'LipSync') : [];
    const ids = groups.length === 1 && Array.isArray(groups[0].Ids) ? groups[0].Ids : [];
    const mouthCandidate = mapping?.parameterId ?? (ids.length === 1 && typeof ids[0] === 'string' && ids[0] ? ids[0] : null);
    return { root, entry, files, revision, declarationCount: declared.length, totalBytes: total, mouthCandidate, resourcesVerified: true, modelLoaded: false, mouthReady: false };
  } catch (error) {
    if (error instanceof ResourceError) throw error;
    if (error?.code === 'ENOENT') fail('RESOURCE_MISSING');
    if (error?.message === 'MOUTH_MAPPING_INVALID') fail('MOUTH_MAPPING_INVALID');
    fail('RESOURCE_UNREADABLE');
  }
}

// Never serves an arbitrary root/path. The caller must fence the manifest's
// resource ID/revision and invalidate that binding if any file has changed.
export async function readManifestFile(manifest, name) {
  try {
    const item = manifest.files.find(f => f.path === name);
    if (!item) fail('RESOURCE_NOT_ALLOWED');
    await rejectReparse([resolve(manifest.root, item.path)]);
    const bytes = await readBounded(manifest.root, item.path, item.size);
    await rejectReparse([resolve(manifest.root, item.path)]);
    if (bytes.length !== item.size || hash(bytes) !== item.hash) fail('RESOURCE_CHANGED');
    return bytes;
  } catch (error) { if (error instanceof ResourceError) throw error; fail('RESOURCE_UNREADABLE'); }
}
