import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, git, json, ok } from './helpers.js';

test('replacement refs cannot attribute replacement bytes to the recorded source commit', t => {
  const f = fixture(t);
  const relative = '.workflow/skills/ticket-design/SKILL.md';
  const source = path.join(f.repo, relative);
  const original = readFileSync(source);
  const ordinary = ok(f.preview('ticket-design'));
  assert.equal(ordinary.source_clean, true);
  assert.equal(json(ordinary.plan).source.commit, f.head);

  const replacementBytes = '# Bytes present only in replacement commit B\n';
  writeFileSync(source, replacementBytes);
  const replacement = f.commit();
  // Move only the temporary branch ref: working bytes remain B while HEAD names A.
  git(f.repo, 'update-ref', 'HEAD', f.head);
  git(f.repo, 'replace', f.head, replacement);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(git(f.repo, 'cat-file', 'blob', `${f.head}:${relative}`), replacementBytes.trim());
  assert.equal(git(f.repo, '--no-replace-objects', 'cat-file', 'blob', `${f.head}:${relative}`), original.toString('utf8').trim());

  const candidate = ok(f.preview('ticket-design'));
  assert.equal(json(candidate.plan).source.commit, f.head);
  const applied = f.call('apply', ['--plan', candidate.plan, '--approve', candidate.digest]);
  const verified = f.call('verify', ['--plan', candidate.plan]);
  t.diagnostic(`HEAD=A ${f.head}; replacement=B ${replacement}; clean=${candidate.source_clean}; apply=${applied.data?.status}; verify=${verified.data?.status}`);
  assert.equal(candidate.source_clean, false, 'replacement-only bytes must not be declared committed to A');
  assert.equal(candidate.applyable, false);
  assert.equal(applied.status, 1);
  assert.equal(applied.data.error.code, 'SOURCE_NOT_COMMITTED');
  assert.equal(verified.status, 1);
  assert.equal(verified.data.status, 'source-unavailable');
  assert.equal(verified.data.error.code, 'SOURCE_NOT_COMMITTED');
  assert.deepEqual(readdirSync(f.target), [], 'a rejected provenance claim must not install anything');

  // Original A bytes remain installable even while the replacement ref exists.
  writeFileSync(source, original);
  assert.equal(git(f.repo, 'rev-parse', `refs/replace/${f.head}`), replacement);
  const originalPlan = ok(f.preview('ticket-design'));
  assert.equal(originalPlan.source_clean, true);
  const installed = ok(f.call('apply', ['--plan', originalPlan.plan, '--approve', originalPlan.digest]));
  assert.equal(installed.source.commit, f.head);
  assert.deepEqual(readFileSync(path.join(f.target, 'ticket-design/SKILL.md')), original);
  assert.equal(ok(f.call('verify', ['--plan', originalPlan.plan])).source.commit, f.head);

  git(f.repo, 'replace', '-d', f.head);
  const withoutReplacement = ok(f.preview('ticket-design'));
  assert.equal(withoutReplacement.source_clean, true);
  assert.equal(json(withoutReplacement.plan).source.commit, f.head);
  assert.deepEqual(json(withoutReplacement.plan).changes.map(change => change.action), ['no-op']);
  assert.equal(ok(f.call('apply', ['--plan', withoutReplacement.plan, '--approve', withoutReplacement.digest])).source.commit, f.head);
  assert.equal(ok(f.call('verify', ['--plan', withoutReplacement.plan])).source.commit, f.head);
});
