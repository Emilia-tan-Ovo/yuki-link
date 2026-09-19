import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, git, json } from './helpers.js';

const entry = fileURLToPath(new URL('../fixtures/end-to-end-fixture.mjs', import.meta.url));
function call(...args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  let data;
  try { data = JSON.parse(result.stdout); } catch { /* Assertion shows command output. */ }
  return { ...result, data };
}
function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.data;
}
const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');
const put = (root, name, text) => fs.writeFileSync(path.join(root, name), text);
const checkpoint = '.local/workflow-state/FIXTURE-006.md';
function implemented(root) {
  // Synthetic artifacts exercise the checker, never stand in for Agent execution.
  put(root, 'result.txt', '14\n');
  fs.appendFileSync(path.join(root, 'docs/ticket.md'), '\n## Implementation Notes\nSynthetic design.\n## Implementation Handoff\nSynthetic implementation.\n');
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'synthetic implementation');
  put(root, checkpoint, read(root, checkpoint).replace('phase: ticket-design', 'phase: review')
    .replace(/^head: .*$/m, `head: "${git(root, 'rev-parse', 'HEAD')}"`));
}

test('main fixture starts at design and checks implementation artifacts without claiming behavior acceptance', t => {
  const f = fixture(t);
  const created = ok(call('create', f.repo));
  const root = created.root;
  assert.ok(root.startsWith(path.join(f.repo, '.local', 'workflow-fixtures')));
  assert.ok(read(root, 'docs/design-handoff.md').includes('value=7'));
  assert.ok(!read(root, 'docs/ticket.md').includes('## Implementation Notes'));
  assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
  assert.equal(json(path.join(root, '.local/effect.json')).count, 1);
  assert.equal(git(root, 'ls-files', '.local'), '');
  const identity = json(path.join(root, '.local/case.json'));
  assert.match(identity.source_commit, /^[a-f0-9]{40}$/);
  assert.ok(identity.skill_files['engineering-workflow/SKILL.md']);
  assert.notEqual(call('check-implementation', root).status, 0);
  implemented(root);
  const checked = ok(call('check-implementation', root));
  assert.equal(checked.status, 'artifact-check-passed');
  assert.equal(checked.behavior_acceptance, 'pending-external-trace-review');
  put(root, '.local/effect.json', '{"count":2}');
  assert.notEqual(call('check-implementation', root).status, 0, 'replayed prepare must fail');
});

test('one permission injection and interruption preserve actual finding, diff and receipt until recovery', t => {
  const f = fixture(t);
  const { root, fixed_point: fixed } = ok(call('create', f.repo));
  implemented(root);
  const injected = ok(call('inject', root));
  assert.notEqual(injected.test.exit_code, 0, 'permission regression must actually fail');
  assert.equal(json(path.join(root, 'policy.json')).guest_private, true);
  assert.ok(git(root, 'diff', '--cached', '--name-only').includes('policy.json'));
  assert.notEqual(call('inject', root).status, 0, 'do not repeat injection');
  assert.notEqual(call('interrupt', root, '.local/full-review.md').status, 0, 'no manufactured review');
  put(root, '.local/full-review.md', '# Synthetic checker input\nStandards: pass\nSpec: F1 open, guest private access.\n');
  put(root, checkpoint, read(root, checkpoint).replace('phase: review', 'phase: implementation')
    .replace('无产品未决项，尚未 Review。', 'F1 open；原报告 .local/full-review.md；修复权限。')
    .replace('从持久化产物按公共入口推进到本轮授权终点。', '修复 F1；保留原双轴报告，然后 fresh focused。'));
  const before = read(root, checkpoint);
  const interrupted = ok(call('interrupt', root, '.local/full-review.md'));
  assert.equal(interrupted.status, 'interruption-prepared');
  assert.equal(read(root, checkpoint), before.replace(/^head: .*$/m, `head: "${fixed}"`));
  assert.notEqual(call('interrupt', root, '.local/full-review.md').status, 0, 'preserve first snapshot');
  assert.notEqual(call('check-resume', root).status, 0, 'stale HEAD must be refreshed');
  put(root, checkpoint, before);
  assert.equal(ok(call('check-resume', root)).behavior_acceptance, 'pending-external-trace-review');
  put(root, '.local/full-review.md', 'changed report');
  assert.notEqual(call('check-resume', root).status, 0, 'old finding evidence must survive');
  put(root, '.local/full-review.md', '# Synthetic checker input\nStandards: pass\nSpec: F1 open, guest private access.\n');
  put(root, 'policy.json', '{"guest_private":false}\n');
  assert.notEqual(call('check-resume', root).status, 0, 'resume check runs before repair');
  const repaired = spawnSync(process.execPath, ['test.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(json(path.join(root, '.local/effect.json')).count, 1);
});

test('closeout uses the existing archive seam and refuses pending evidence or copied raw content', t => {
  const f = fixture(t);
  const { root } = ok(call('create', f.repo));
  implemented(root);
  put(root, checkpoint, read(root, checkpoint).replace('phase: review', 'phase: closeout'));
  const inputPath = '.local/closeout-input.json';
  const snapshotPath = '.local/closeout-snapshot.json';
  const helper = path.join(root, '.workflow/skills/engineering-workflow/scripts/closeout-archive.mjs');
  const input = json(path.join(root, inputPath));
  function generate() {
    put(root, inputPath, JSON.stringify(input));
    const observed = spawnSync(process.execPath, [helper, 'observe', root, path.join(root, inputPath)], { encoding: 'utf8', windowsHide: true });
    assert.equal(observed.status, 0, observed.stderr || observed.stdout);
    put(root, snapshotPath, observed.stdout);
    const generated = spawnSync(process.execPath, [helper, 'generate', root, path.join(root, snapshotPath)], { encoding: 'utf8', windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  }
  input.head = git(root, 'rev-parse', 'HEAD');
  generate();
  assert.notEqual(call('check-closeout', root, snapshotPath).status, 0, 'pending stages are not accepted');
  put(root, '.local/synthetic-report.md', 'Synthetic checker-only input, not a real review or acceptance.');
  for (const stage of Object.values(input.stages)) {
    stage.status = 'recorded'; stage.summary = 'Synthetic checker-only record'; stage.sources = ['.local/synthetic-report.md'];
  }
  generate();
  const result = ok(call('check-closeout', root, snapshotPath));
  assert.equal(result.behavior_acceptance, 'pending-external-trace-review');
  const archive = '.workflow/history/FIXTURE-006.md';
  assert.ok(!read(root, archive).includes('WORKFLOW_006_RAW_SENTINEL'));
  assert.equal(git(root, 'ls-files', '.local'), '');
  fs.appendFileSync(path.join(root, archive), '\nWORKFLOW_006_RAW_SENTINEL\n');
  assert.notEqual(call('check-closeout', root, snapshotPath).status, 0, 'raw copy must be rejected');
});
