import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, git } from './helpers.js';

const script = fileURLToPath(new URL('../fixtures/review-fixture.mjs', import.meta.url));
function call(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  let data;
  try { data = JSON.parse(result.stdout); } catch { /* Report missing generator/errors. */ }
  return { ...result, data };
}

test('standalone and delegated fixtures enforce different review obligations without running a reviewer', t => {
  const f = fixture(t);
  for (const scenario of ['standalone', 'delegated']) {
    const created = call('create', scenario, f.repo);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const root = created.data.root;
    const baseline = git(root, 'rev-parse', 'HEAD');
    const negative = call('check', root);
    assert.notEqual(negative.status, 0, 'missing external evidence cannot pass');
    writeFileSync(path.join(root, 'result.txt'), '14\n');
    const subject = JSON.parse(readFileSync(path.join(root, '.local/case.json'), 'utf8'));
    assert.equal(subject.fixed_point, baseline);
    // Synthetic observations test only the checker, never stand in for Agent acceptance.
    writeFileSync(path.join(root, '.local/trace.txt'), 'synthetic checker unit input\n');
    const observation = { fixture_only: true, trace: '.local/trace.txt', implementation_session: 'impl-fixture',
      review_calls: [], handoff: 'docs/handoff.md', commit: baseline };
    writeFileSync(path.join(root, 'docs/handoff.md'), '# Implementation Handoff\nfixture checker input\n');
    git(root, 'add', 'result.txt', 'docs/handoff.md');
    git(root, 'commit', '--quiet', '-m', 'fixture implementation');
    observation.commit = git(root, 'rev-parse', 'HEAD');
    const observed = path.join(root, '.local/observation.json');
    writeFileSync(observed, JSON.stringify(observation));
    assert.equal(call('check', root).status, scenario === 'standalone' ? 1 : 0);
    observation.review_calls = [{ skill: 'code-review', mode: 'full', session: 'fresh-fixture',
      inherits_history: false, axes: ['Standards', 'Spec'] }];
    writeFileSync(observed, JSON.stringify(observation));
    assert.equal(call('check', root).status, scenario === 'standalone' ? 0 : 1);
    observation.review_calls[0].session = 'impl-fixture';
    writeFileSync(observed, JSON.stringify(observation));
    assert.equal(call('check', root).status, 1, 'implementation context cannot masquerade as fresh');
  }
});
