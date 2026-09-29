import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { reviewFixture } from './fixtures/work-item-review.ts';

async function waiting(t: test.TestContext) {
  const f = reviewFixture(t);
  const repair = await f.start('finding-fix', ['one', 'two']); f.finish();
  for (const finding of f.snapshot.findings) finding.status = 'fixed-unverified';
  f.record();
  return { f, repair, item: f.transition(repair.work_item, 'await-verification') };
}

test('repair rejects an unowned passed review even with verified snapshot flags and no execution refs', async t => {
  const { f, item } = await waiting(t);
  f.pending('unowned-review', ['one', 'two']);
  const review = f.snapshot.reviews.at(-1);
  review.status = review.spec.status = review.standards.status = 'passed';
  for (const finding of f.snapshot.findings) { finding.status = 'verified'; finding.verification_review_id = review.review_id; }
  f.record();
  assert.throws(() => f.transition(item, 'complete', { review_id: review.review_id }), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
});

test('completion requires actual journal ownership and current isolation, not saved report flags', async t => {
  const { f, item } = await waiting(t);
  f.pending('focused-1', ['one', 'two']);
  const reviewer = await f.start('focused-review', ['one', 'two'], undefined, 'focused-1');
  f.report(reviewer, 'focused-1', 'passed', ['one', 'two']);
  const observed = f.harness.workflowHistory.current.values().next().value!;
  const current = structuredClone(observed);
  // Change the live projection, not the journal's already recorded evidence.
  f.harness.workflowHistory.current.set(current.ticket_id, current);
  const saved = structuredClone(current.snapshot);
  const rejectBoth = () => {
    assert.throws(() => f.transition(item, 'complete', { review_id: 'focused-1' }), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
    assert.throws(() => f.transition(reviewer.work_item, 'complete', { review_id: 'focused-1' }), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
  };
  const mutations = [
    () => { current.snapshot.reviews.at(-1)!.execution_refs = []; },
    () => { current.snapshot.reviews.at(-1)!.original_review_id = 'other-cycle'; },
    () => { current.snapshot.reviews.at(-1)!.subject_identity = 'f'.repeat(64); },
    () => { const ref = current.snapshot.runtime_refs.at(-1)!; ref.session_id = item.generations[0].session_id;
      ref.run_id = [...f.runs.values()].find(value => value.session_id === ref.session_id).id; },
  ];
  for (const mutate of mutations) { mutate(); rejectBoth(); current.snapshot = structuredClone(saved); }
  const events = f.source.events; f.source.events = () => []; rejectBoth(); f.source.events = events;
  const generation = f.harness.executionOperations.workItems.items.get(reviewer.work_item.work_item_id)!;
  generation.generation++; rejectBoth(); generation.generation--;
  const operation = f.harness.executionOperations.operations.get(reviewer.operation_id)!;
  const operationOwner = operation.work_item!.item.delivery_item_id;
  // Tampering with the operation owner cannot manufacture a reviewer for this delivery.
  operation.work_item!.item.authority_digest = 'e'.repeat(64); rejectBoth();
  operation.work_item!.item.authority_digest = generation.authority_digest;
  operation.work_item!.item.delivery_item_id = randomUUID(); rejectBoth();
  operation.work_item!.item.delivery_item_id = operationOwner;
  assert.equal(operationOwner, item.delivery_item_id);
  const reportFile = current.snapshot.artifacts.find(value => value.artifact_id === 'focused-1')!;
  const reportHash = reportFile.revision;
  writeFileSync(reportFile.location, 'rewritten report\n', 'utf8');
  reportFile.revision = createHash('sha256').update('rewritten report\n').digest('hex'); rejectBoth();
  writeFileSync(reportFile.location, 'focused-1: passed\n', 'utf8'); reportFile.revision = reportHash;
  const unownedRun = randomUUID();
  f.runs.set(unownedRun, { id: unownedRun, session_id: reviewer.runtime.session_id, status: 'completed', created_at: '2099-01-01T00:00:00.000Z' });
  rejectBoth(); f.runs.delete(unownedRun);
  assert.equal(f.transition(reviewer.work_item, 'complete', { review_id: 'focused-1' }).state, 'completed');
  assert.equal(f.transition(item, 'complete', { review_id: 'focused-1' }).state, 'completed');
});

test('unfinished reviewer continuation keeps one round and survives restart with the same generation', async t => {
  const { f } = await waiting(t);
  f.pending('focused-1', ['one', 'two']);
  const first = await f.start('focused-review', ['one', 'two'], undefined, 'focused-1'); f.finish(); f.restart();
  const second = await f.start('focused-review', ['one', 'two'], f.current(first.work_item), 'focused-1');
  assert.equal(second.runtime.session_id, first.runtime.session_id);
  assert.equal(second.work_item.review_rounds, 1);
  assert.equal(second.work_item.generation, 1);
  f.report(second, 'focused-1', 'passed', ['one', 'two']);
  assert.equal(f.transition(second.work_item, 'complete', { review_id: 'focused-1' }).state, 'completed');
});

test('same-content terminal rounds consume durable budget; trusted allowance preserves reviewer and repair generations', async t => {
  const { f, repair, item } = await waiting(t);
  const content = f.identity().digest;
  f.pending('focused-1', ['one', 'two']);
  const first = await f.start('focused-review', ['one', 'two'], undefined, 'focused-1');
  f.report(first, 'focused-1', 'findings');
  const reopened = f.transition(item, 'reopen', { review_id: 'focused-1' });
  const continued = await f.start('finding-fix', ['one', 'two'], reopened); f.finish();
  assert.equal(continued.runtime.session_id, repair.runtime.session_id);
  const waitingAgain = f.transition(continued.work_item, 'await-verification');
  f.pending('focused-2', ['one', 'two']); f.restart();
  await assert.rejects(f.start('focused-review', ['one', 'two'], f.current(first.work_item), 'focused-2'),
    { code: 'WORK_ITEM_REVIEW_BUDGET_EXHAUSTED' });
  const extra = f.transition(f.current(first.work_item), 'review-budget', { review_budget: 2 });
  assert.equal(extra.review_history[0].conclusion, 'findings');
  f.restart();
  const second = await f.start('focused-review', ['one', 'two'], f.current(extra), 'focused-2');
  assert.equal(second.work_item.review_rounds, 2);
  assert.equal(second.runtime.session_id, first.runtime.session_id);
  assert.equal(second.destination.conversation_id, first.destination.conversation_id);
  assert.equal(f.identity().digest, content);
  f.report(second, 'focused-2', 'passed', ['one', 'two']);
  assert.equal(f.transition(waitingAgain, 'complete', { review_id: 'focused-2' }).state, 'completed');
});

test('incomplete conclusion also ends a round and cannot be reset to pending after restart', async t => {
  const { f } = await waiting(t); f.pending('focused-1', ['one', 'two']);
  const first = await f.start('focused-review', ['one', 'two'], undefined, 'focused-1');
  f.report(first, 'focused-1', 'incomplete');
  const review = f.snapshot.reviews.at(-1); review.status = review.spec.status = review.standards.status = 'pending';
  f.record(); f.restart();
  await assert.rejects(f.start('focused-review', ['one', 'two'], f.current(first.work_item), 'focused-1'),
    { code: 'WORK_ITEM_REVIEW_BUDGET_EXHAUSTED' });
  const extra = f.transition(f.current(first.work_item), 'review-budget', { review_budget: 2 });
  await assert.rejects(f.start('focused-review', ['one', 'two'], extra, 'focused-1'), { code: 'WORK_ITEM_REVIEW_ID_REUSED' });
});

test('mixed verified/pending issues support distributed reports, another repair and final completion', async t => {
  const { f, repair, item } = await waiting(t);
  f.pending('focused-1', ['one']);
  const first = await f.start('focused-review', ['one'], undefined, 'focused-1');
  f.report(first, 'focused-1', 'passed', ['one']);
  f.pending('focused-2', ['two']);
  const budget = f.transition(first.work_item, 'review-budget', { review_budget: 3 });
  const second = await f.start('focused-review', ['two'], budget, 'focused-2');
  f.report(second, 'focused-2', 'findings');
  const reopened = f.transition(item, 'reopen', { review_id: 'focused-2' });
  const continued = await f.start('finding-fix', ['two'], reopened); f.finish();
  assert.equal(continued.runtime.session_id, repair.runtime.session_id);
  assert.deepEqual(continued.work_item.issue_set, ['primary:one', 'primary:two']);
  const mixed = f.transition(continued.work_item, 'await-verification');
  assert.deepEqual(mixed.verification_issue_set, ['primary:two']);
  f.pending('focused-3', ['two']); f.restart();
  const third = await f.start('focused-review', ['two'], f.current(second.work_item), 'focused-3');
  f.report(third, 'focused-3', 'passed', ['two']);
  const current = f.harness.workflowHistory.current.values().next().value!;
  const finding = current.snapshot.findings[0];
  const identity = finding.subject_identity;
  finding.subject_identity = 'e'.repeat(64);
  assert.throws(() => f.transition(mixed, 'complete', { review_id: 'focused-3' }), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
  finding.subject_identity = identity;
  assert.equal(f.transition(mixed, 'complete', { review_id: 'focused-3' }).state, 'completed');
  assert.deepEqual(f.snapshot.findings.map((value: any) => value.verification_review_id), ['focused-1', 'focused-3']);
});

test('old verified evidence cannot survive a real content change at await-verification', async t => {
  const { f, item } = await waiting(t);
  f.pending('focused-1', ['one']);
  const first = await f.start('focused-review', ['one'], undefined, 'focused-1'); f.report(first, 'focused-1', 'passed', ['one']);
  f.pending('focused-2', ['two']);
  const extra = f.transition(first.work_item, 'review-budget', { review_budget: 2 });
  const second = await f.start('focused-review', ['two'], extra, 'focused-2'); f.report(second, 'focused-2', 'findings');
  const reopened = f.transition(item, 'reopen', { review_id: 'focused-2' });
  writeFileSync(path.join(f.repo, 'subject.txt'), 'changed\n', 'utf8');
  f.snapshot.subject.unstaged = [{ path: 'subject.txt', sha256: createHash('sha256').update('changed\n').digest('hex') }]; f.record();
  assert.throws(() => f.transition(reopened, 'await-verification'), { code: 'WORK_ITEM_VERIFICATION_REQUIRED' });
});
