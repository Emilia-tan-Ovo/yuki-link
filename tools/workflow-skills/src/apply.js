import fs from 'node:fs';
import path from 'node:path';
import { bytes, digest, hash, fail, safePath, writeNew, writeJson } from './files.js';
import { sourceRelative } from './source.js';
import { loadPlan, buildPlan, verifyPlan } from './plans.js';

export function apply(file, approval) {
  if (!approval) throw fail('APPROVAL_REQUIRED');
  const plan = loadPlan(file);
  if (approval !== digest(plan)) throw fail('APPROVAL_MISMATCH');
  const rebuilt = buildPlan(plan.source.repo, plan.target.root, plan.source.selection, plan.id, plan.tool).plan;
  if (digest(rebuilt) !== approval) throw fail('PLAN_STALE');
  if (!plan.source.clean) throw fail('SOURCE_NOT_COMMITTED');
  if (plan.extras.length) throw fail('TARGET_CONFLICT');
  const lock = plan.write_set.lock;
  try { writeJson(lock, { plan: plan.id, digest: approval, pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw fail('APPLY_BUSY'); throw error; }
  let started = false;
  const completed = [];
  try {
    if (digest(buildPlan(plan.source.repo, plan.target.root, plan.source.selection, plan.id, plan.tool).plan) !== approval) throw fail('PLAN_STALE');
    const recovery = plan.write_set.recovery;
    // Exclusive intent prevents replay of a completed or interrupted application.
    writeJson(path.join(recovery, 'intent.json'), { plan_digest: approval, started_at: new Date().toISOString(), write_set: plan.write_set });
    for (const change of plan.changes.filter(change => change.action === 'update')) {
      const buffer = bytes(path.join(plan.target.root, change.path));
      if (hash(buffer) !== change.before) throw fail('PLAN_STALE');
      writeNew(path.join(recovery, `backup-${hash(change.path)}.bin`), buffer);
    }
    writeJson(path.join(recovery, 'backup-complete.json'), { plan_digest: approval });
    const updates = plan.changes.filter(change => change.action !== 'no-op');
    // Every backup and the intent are durable before the first installation mutation.
    for (const directory of [...plan.write_set.directories].sort((a, b) => a.length - b.length)) {
      safePath(directory, true); started = true; fs.mkdirSync(directory);
    }
    for (let index = 0; index < updates.length; index++) {
      const change = updates[index];
      const target = path.join(plan.target.root, change.path), temporary = plan.write_set.temporary[index];
      const buffer = bytes(path.join(plan.source.repo, sourceRelative, change.path));
      if (hash(buffer) !== change.after) throw fail('SOURCE_CHANGED');
      safePath(target, true);
      const before = fs.existsSync(target) ? hash(bytes(target)) : null;
      if (before !== change.before) throw fail('TARGET_CHANGED');
      started = true;
      writeNew(temporary, buffer);
      safePath(target, true);
      if ((fs.existsSync(target) ? hash(bytes(target)) : null) !== change.before) throw fail('TARGET_CHANGED');
      if (change.action === 'create') { fs.linkSync(temporary, target); fs.unlinkSync(temporary); }
      else fs.renameSync(temporary, target);
      completed.push(change.path);
      writeJson(path.join(recovery, `completed-${index}.json`), { path: change.path, sha256: change.after });
    }
    const result = verifyPlan(plan);
    if (result.status !== 'verified') throw fail('VERIFY_FAILED', result);
    writeJson(path.join(recovery, 'receipt.json'), result);
    safePath(lock); fs.unlinkSync(lock);
    return result;
  } catch (error) {
    // No rollback: a failure can follow a successful rename or partial audit write.
    const result = { status: started ? 'partial-or-unknown' : 'not-applied', error: { code: error.code ?? 'APPLY_FAILED' },
      completed, recovery: plan.write_set.recovery, lock, requires_inspection: true };
    try { writeJson(path.join(plan.write_set.recovery, 'failure.json'), result); } catch { /* Preserve remaining evidence. */ }
    return result;
  }
}
