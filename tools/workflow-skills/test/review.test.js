import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, json } from './helpers.js';

test('review-change and its full-review dependency install complete bytes through the existing approval boundary', t => {
  const f = fixture(t);
  const preview = ok(f.preview('review-change,code-review,implement,engineering-workflow'));
  const plan = json(preview.plan);
  assert.deepEqual(readdirSync(f.target), []);
  assert.equal(f.call('apply', ['--plan', preview.plan]).data.error.code, 'APPROVAL_REQUIRED');
  ok(f.call('apply', ['--plan', preview.plan, '--approve', preview.digest]));
  assert.equal(ok(f.call('verify', ['--plan', preview.plan])).status, 'verified');
  assert.ok(plan.source.files.some(file => file.path === 'review-change/SKILL.md'));
  for (const file of plan.source.files) {
    assert.deepEqual(readFileSync(path.join(f.target, file.path)),
      readFileSync(path.join(f.repo, '.workflow/skills', file.path)));
  }
  const captured = spawnSync(process.execPath,
    [path.join(f.target, 'code-review/scripts/review-subject.mjs'), f.repo, f.head],
    { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(captured.status, 0, captured.stderr || captured.stdout);
  assert.equal(JSON.parse(captured.stdout).head, f.head, 'installed helper reads the requested repo, not its own location');
});
