import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bytes, text, hash, digest, fail, safePath, identity, tree, writeJson, writeNew, readJson, inside } from './files.js';
import { sourceState, sourceRelative } from './source.js';

export function targetState(root, selection) {
  root = safePath(root);
  if (!fs.statSync(root).isDirectory()) throw fail('NOT_A_DIRECTORY');
  const skills = selection.map(name => {
    const directory = path.join(root, name);
    safePath(directory, true);
    return fs.existsSync(directory) ? { name, exists: true, ...identity(directory), entries: tree(directory) } : { name, exists: false, entries: [] };
  });
  return { root, ...identity(root), skills };
}
export function comparison(source, target) {
  const changes = source.files.map(file => {
    const slash = file.path.indexOf('/'), name = file.path.slice(0, slash), relative = file.path.slice(slash + 1);
    const existing = target.skills.find(skill => skill.name === name).entries.find(entry => entry.path === relative);
    if (existing && existing.type !== 'file') throw fail('TARGET_CONFLICT');
    return { path: file.path, before: existing?.sha256 ?? null, after: file.sha256,
      action: !existing ? 'create' : existing.sha256 === file.sha256 ? 'no-op' : 'update' };
  });
  const extras = target.skills.flatMap(skill => skill.entries.filter(entry => !source.files.some(file =>
    entry.type === 'file' ? file.path === `${skill.name}/${entry.path}` : file.path.startsWith(`${skill.name}/${entry.path}/`)))
    .map(entry => `${skill.name}/${entry.path}${entry.type === 'directory' ? '/' : ''}`));
  return { changes, extras };
}
function fullDiff(source, target, changes) {
  // Complete replacement hunks deliberately avoid a dependency or external diff filters.
  return changes.map(change => {
    if (change.action === 'no-op') return `# no-op ${change.path}\n`;
    const before = change.before === null ? '' : text(bytes(path.join(target.root, change.path)));
    const after = text(bytes(path.join(source.repo, sourceRelative, change.path)));
    const lines = value => value === '' ? [] : value.split('\n');
    return `--- installed/${change.path}\n+++ source/${change.path}\n@@ complete file; SHA-256 ${change.before ?? 'missing'} -> ${change.after} @@\n`
      + lines(before).map(line => '-' + line + '\n').join('') + lines(after).map(line => '+' + line + '\n').join('');
  }).join('\n');
}
export function buildPlan(repo, targetRoot, selection, id, expectedTool) {
  const { source, tool } = sourceState(repo, selection, expectedTool);
  const target = targetState(targetRoot, source.selection);
  const { changes, extras } = comparison(source, target);
  const directory = path.join(source.repo, '.local/workflow-skill-apply', id);
  for (const protectedRoot of [path.join(source.repo, sourceRelative), tool.root, path.dirname(directory)]) {
    if (inside(protectedRoot, target.root) || inside(target.root, protectedRoot)) throw fail('PATH_OVERLAP');
  }
  const directories = new Set();
  for (const change of changes.filter(change => change.action === 'create')) {
    for (let parent = path.dirname(path.join(target.root, change.path)); parent !== target.root; parent = path.dirname(parent)) {
      safePath(parent, true);
      if (!fs.existsSync(parent)) directories.add(parent);
    }
  }
  const diff = fullDiff(source, target, changes);
  const plan = { schema_version: 1, id, source, tool, target, changes, extras,
    write_set: { files: changes.filter(change => change.action !== 'no-op').map(change => path.join(target.root, change.path)),
      directories: [...directories].sort(), lock: path.join(target.root, '.workflow-apply.lock'),
      temporary: changes.filter(change => change.action !== 'no-op').map(change => path.join(path.dirname(path.join(target.root, change.path)), `.workflow-${id}-${hash(change.path).slice(0, 16)}.tmp`)),
      recovery: directory }, diff_sha256: hash(diff) };
  return { plan, diff };
}
export function preview(repo, target, selection) {
  const id = randomUUID();
  const { plan, diff } = buildPlan(repo, target, selection, id);
  if (Buffer.byteLength(diff) > 256 * 1024 || Buffer.byteLength(JSON.stringify(plan, null, 2) + '\n') > 256 * 1024) throw fail('PREVIEW_TOO_LARGE');
  const directory = safePath(plan.write_set.recovery, true);
  fs.mkdirSync(directory, { recursive: true });
  const planFile = path.join(directory, 'plan.json'), diffFile = path.join(directory, 'diff.txt');
  const approvedDigest = digest(plan);
  writeJson(planFile, plan); writeNew(diffFile, diff);
  return { status: 'preview', plan: planFile, diff: diffFile, digest: approvedDigest,
    applyable: plan.source.clean && plan.extras.length === 0, extras: plan.extras, source_clean: plan.source.clean };
}

export function loadPlan(file) {
  file = safePath(file);
  const plan = readJson(file);
  if (plan.schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(plan.id ?? '') || !plan.source || !plan.target || !plan.tool) throw fail('INVALID_PLAN');
  const directory = safePath(path.join(plan.source.repo, '.local/workflow-skill-apply', plan.id));
  if (file !== path.join(directory, 'plan.json') || plan.write_set?.recovery !== directory) throw fail('INVALID_PLAN');
  if (hash(bytes(path.join(directory, 'diff.txt'))) !== plan.diff_sha256) throw fail('PLAN_CHANGED');
  return plan;
}

export function verifyPlan(plan) {
  let current;
  try { current = sourceState(plan.source.repo, plan.source.selection, plan.tool); }
  catch (error) { return { status: 'source-unavailable', error: { code: error.code ?? 'SOURCE_UNAVAILABLE' } }; }
  if (!current.source.clean) return { status: 'source-unavailable', error: { code: 'SOURCE_NOT_COMMITTED' } };
  if (digest(current.source) !== digest(plan.source) || digest(current.tool) !== digest(plan.tool)) {
    return { status: 'source-unavailable', error: { code: 'SOURCE_CHANGED' } };
  }
  const target = targetState(plan.target.root, plan.source.selection);
  if (target.dev !== plan.target.dev || target.ino !== plan.target.ino) throw fail('TARGET_CHANGED');
  const { changes, extras } = comparison(current.source, target);
  const files = changes.map(file => ({ path: file.path, expected_sha256: file.after, installed_sha256: file.before,
    status: file.before === null ? 'missing' : file.before === file.after ? 'matched' : 'content-drift' }));
  return { status: files.every(file => file.status === 'matched') && !extras.length ? 'verified' : 'drift',
    source: { commit: current.source.commit, digest: current.source.digest }, plan_digest: digest(plan),
    observed_at: new Date().toISOString(), files, extras };
}
