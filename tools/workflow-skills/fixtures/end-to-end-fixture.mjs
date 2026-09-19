// 006 的准备/产物核验器；不选择 Skill、不启动模型、不授予行为验收通过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const checkpoint = '.local/workflow-state/FIXTURE-006.md';
const sha = value => createHash('sha256').update(value).digest('hex');
const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');
const json = (root, name) => JSON.parse(read(root, name));
function put(root, name, value) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}
const gitPath = (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
  .map(dir => path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git')).find(fs.existsSync);
function run(root, executable, args) {
  return spawnSync(executable, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}
function git(root, ...args) {
  assert.ok(gitPath, 'Git required on absolute PATH');
  const result = run(root, gitPath, ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function hashes(root) {
  const files = {};
  for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
    const file = path.join(root, name);
    assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'fixture source must not contain links');
    if (fs.statSync(file).isFile()) files[name.split(path.sep).join('/')] = sha(fs.readFileSync(file));
  }
  return files;
}
function subject(root, fixed) {
  const result = run(root, process.execPath, ['.workflow/skills/code-review/scripts/review-subject.mjs', root, fixed]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function checkedRoot(input) {
  const root = fs.realpathSync(input);
  const state = json(root, '.local/case.json');
  assert.equal(state.kind, 'workflow-006');
  const parent = fs.realpathSync(state.parent);
  const relative = path.relative(path.join(parent, '.local/workflow-fixtures'), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'expected a local fixture root');
  assert.equal(fs.realpathSync(git(root, 'rev-parse', '--show-toplevel')), root);
  assert.deepEqual(hashes(path.join(root, '.workflow/skills')), state.skill_files, 'fixture Skill source changed');
  for (const [name, digest] of Object.entries(state.controls)) assert.equal(sha(read(root, name)), digest, `control changed: ${name}`);
  assert.equal(git(root, 'ls-files', '.local'), '', '.local must not be tracked');
  git(root, 'check-ignore', checkpoint);
  return { root, state };
}
function effect(root) {
  assert.equal(json(root, '.local/effect.json').count, 1, 'prepare must happen once');
  assert.deepEqual(json(root, '.local/receipt.json'), { action: 'prepare', status: 'done', value: 7 });
}
function testResult(root) {
  const result = run(root, process.execPath, ['test.mjs']);
  return { command: 'node test.mjs', exit_code: result.status, stdout: result.stdout, stderr: result.stderr };
}
function checkpointHead(root) {
  const matches = [...read(root, checkpoint).matchAll(/^head: ["']?([a-f0-9]{40})["']?\r?$/gm)];
  assert.equal(matches.length, 1, 'one checkpoint HEAD required');
  return matches[0][1];
}
function implementation(root, state) {
  effect(root);
  const tested = testResult(root);
  assert.equal(tested.exit_code, 0, tested.stderr);
  const ticket = read(root, 'docs/ticket.md');
  assert.ok(ticket.includes('## Implementation Notes') && ticket.includes('## Implementation Handoff'), 'persist design and handoff');
  assert.match(read(root, checkpoint), /^phase: review\r?$/m);
  assert.equal(checkpointHead(root), git(root, 'rev-parse', 'HEAD'), 'refresh checkpoint HEAD');
  assert.notEqual(git(root, 'rev-parse', 'HEAD'), state.fixed_point, 'implementation commit required');
  assert.equal(git(root, 'status', '--porcelain=v1'), '', 'handoff must match committed fixture');
  return tested;
}
function evidenceFile(root, name) {
  assert.equal(typeof name, 'string', 'evidence path required');
  const file = fs.realpathSync(path.resolve(root, name));
  const relative = path.relative(fs.realpathSync(path.join(root, '.local')), file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'evidence must remain inside fixture .local');
  assert.ok(fs.statSync(file).isFile() && fs.statSync(file).size > 0, 'nonempty evidence required');
  return file;
}
function section(text, heading) {
  const start = text.indexOf(`# ${heading}\n`);
  assert.ok(start >= 0, `missing checkpoint section: ${heading}`);
  return text.slice(start).split(/\n# /, 1)[0];
}
function checkpointState(root) {
  const text = read(root, checkpoint).replaceAll('\r\n', '\n');
  assert.match(text, /^phase: implementation$/m, 'save finding/repair boundary first');
  const finding = section(text, 'Open findings / blockers');
  assert.match(finding, /\bF1\b/);
  assert.match(finding, /\bopen\b/);
  return { finding, next_action: section(text, 'Next action'), side_effects: section(text, 'Side effects') };
}
function inject(root, state) {
  assert.ok(!fs.existsSync(path.join(root, '.local/injection.json')), 'injection already recorded');
  const tested = implementation(root, state);
  const before = subject(root, state.fixed_point);
  // Persist intent first; a partial command is not a reason to repeat mutation.
  put(root, '.local/injection.json', { status: 'pending', before, test_before: tested });
  put(root, 'policy.json', '{"guest_private":true}\n');
  git(root, 'add', 'policy.json');
  const after = subject(root, state.fixed_point);
  const test = testResult(root);
  assert.ok(test.exit_code !== null && test.exit_code !== 0, 'injected permission must fail test');
  put(root, '.local/injection.json', { status: 'completed', before, after, test_before: tested, test_after: test,
    note: 'controlled permission input; pre-injection green evidence is stale for this subject' });
  return { status: 'injection-prepared', subject: after, test };
}
function interrupt(root, state, report) {
  assert.ok(!fs.existsSync(path.join(root, '.local/interruption.json')), 'interruption already recorded');
  assert.equal(json(root, '.local/injection.json').status, 'completed');
  effect(root);
  const saved = checkpointState(root);
  const reportFile = evidenceFile(root, report);
  const actual = subject(root, state.fixed_point);
  assert.equal(actual.digest, json(root, '.local/injection.json').after.digest, 'review subject must still match injection');
  const text = read(root, checkpoint);
  assert.equal(checkpointHead(root), actual.head, 'persist current HEAD before interruption');
  put(root, '.local/interruption-checkpoint.md', text);
  put(root, '.local/interruption.json', { ...saved, subject: actual,
    report: path.relative(root, reportFile).split(path.sep).join('/'), report_sha256: sha(fs.readFileSync(reportFile)),
    receipt_sha256: sha(read(root, '.local/receipt.json')), effect_sha256: sha(read(root, '.local/effect.json')),
    note: 'external conversation/observation interruption simulation; does not stop or query any real run' });
  put(root, checkpoint, text.replace(/^head: .*$/m, `head: "${state.fixed_point}"`));
  return { status: 'interruption-prepared', snapshot: '.local/interruption.json', root };
}
function resume(root, state) {
  const before = json(root, '.local/interruption.json');
  assert.deepEqual(checkpointState(root), { finding: before.finding, next_action: before.next_action, side_effects: before.side_effects });
  assert.equal(subject(root, state.fixed_point).digest, before.subject.digest, 'diff must survive interruption; check before repair');
  assert.equal(checkpointHead(root), git(root, 'rev-parse', 'HEAD'), 'refresh stale checkpoint HEAD');
  assert.equal(sha(fs.readFileSync(evidenceFile(root, before.report))), before.report_sha256, 'preserve actual review report');
  assert.equal(sha(read(root, '.local/receipt.json')), before.receipt_sha256);
  assert.equal(sha(read(root, '.local/effect.json')), before.effect_sha256);
  effect(root);
  return { preserved: ['phase', 'finding', 'next_action', 'side_effects', 'subject', 'report', 'receipt'] };
}
function closeoutInput(root, fixed) {
  const fact = summary => ({ status: 'pending', summary, sources: [] });
  return {
    schema_version: 1, ticket: 'FIXTURE-006', issue: 'local fixture, not GitHub Issue #28',
    sources: ['docs/ticket.md', 'docs/spec.md'], observed_at: new Date().toISOString(),
    worktree: root, branch: 'fixture/workflow-006', fixed_point: fixed, head: fixed,
    summary: '临时 fixture；待补真实链路证据，不声明 stable。',
    stages: Object.fromEntries(['implementation', 'review', 'acceptance'].map(stage => [stage, { ...fact('待 Emilia 核对真实证据'), sessions: [] }])),
    metrics: fact('待实际等待窗口/调用数与估算对照口径'), failures: fact('待汇总实际失败与重试'),
    findings: fact('待记录 F1 open/fixed/verified 及原双轴结论'), interventions: fact('待记录人工注入与 external interruption'),
    delivery: { pr: { status: 'not-applicable', summary: '临时 fixture 不发布 PR', sources: [] },
      merge: { status: 'not-applicable', summary: '临时 fixture 不合并', sources: [] } },
    evidence: [{ id: 'raw-sentinel', location: '.local/raw-sentinel.txt', status: 'unknown',
      observed_at: new Date().toISOString(), identity: 'synthetic raw sentinel, not real tool trace' }],
  };
}
function closeout(root, state, snapshotPath) {
  const snapshot = JSON.parse(fs.readFileSync(evidenceFile(root, snapshotPath), 'utf8'));
  assert.equal(snapshot.ticket, 'FIXTURE-006');
  assert.equal(snapshot.worktree, root);
  assert.equal(snapshot.fixed_point, state.fixed_point);
  assert.equal(snapshot.head, git(root, 'rev-parse', 'HEAD'), 'check before committing archive');
  for (const name of ['implementation', 'review', 'acceptance']) {
    const stage = snapshot.stages[name];
    assert.equal(stage.status, 'recorded', `stage still pending: ${name}`);
    assert.ok(stage.sources.length > 0, `missing ${name} sources`);
  }
  effect(root);
  const tested = testResult(root);
  assert.equal(tested.exit_code, 0, tested.stderr);
  assert.match(read(root, checkpoint), /^phase: closeout\r?$/m);
  const archive = '.workflow/history/FIXTURE-006.md';
  const text = read(root, archive);
  assert.ok(Buffer.byteLength(text) <= 64 * 1024);
  for (const value of [snapshot.ticket, snapshot.fixed_point, snapshot.head]) assert.ok(text.includes(value), `archive identity missing: ${value}`);
  assert.ok(!text.includes('WORKFLOW_006_RAW_SENTINEL'), 'archive must not copy raw sentinel');
  assert.equal(sha(read(root, '.local/raw-sentinel.txt')), state.raw_sha256, 'raw evidence must stay unchanged');
  return { archive, archive_sha256: sha(text), test: tested,
    remaining: 'Emilia must verify report semantics, actual traces, waits, source bindings and generated archive consistency' };
}
function create(parentInput) {
  const parent = fs.realpathSync(parentInput ?? repository);
  assert.equal(fs.realpathSync(git(parent, 'rev-parse', '--show-toplevel')), parent);
  const fixtures = path.join(parent, '.local/workflow-fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtures, 'end-to-end-006-'));
  fs.cpSync(path.join(repository, '.workflow/skills'), path.join(root, '.workflow/skills'), { recursive: true });
  put(root, '.gitignore', '.local/\n');
  put(root, '.gitattributes', '* -text\n');
  put(root, 'AGENTS.md', '# Fixture 约定\n只在此临时仓库工作；repo-local .workflow/skills 是唯一 workflow 来源。本地 tracker 为 docs/ticket.md。允许按调用方阶段授权测试和本地 commit；禁止 push、外部发布和全局 apply。测试入口 node test.mjs；不修改测试、输入、effect 脚本或 Skill 来制造通过。\n');
  put(root, 'CONTEXT.md', '# Fixture\nresult 是输入两倍；guest 不可访问 private 记录。prepare 只发生一次，恢复先查 receipt。\n');
  put(root, 'docs/design-handoff.md', '# 已确认 Design Handoff\nvalue=7，result.txt 为 14；guest_private 必须为 false。测试 seam: node test.mjs。prepare 已完成，回执在 .local/receipt.json。无未决产品问题。Next: Ticket 设计与实现。\n');
  put(root, 'docs/spec.md', '# 已确认 Spec\nSource: docs/design-handoff.md\n生成输入值两倍的 result.txt；value=7 时为 14。guest_private 必须为 false。只修改结果、说明与 Ticket；修复权限 finding 时允许恢复 policy.json。prepare 是非幂等动作，回执 done 时禁止重放。Notes、handoff、Review、checkpoint 和 archive 按 repo-local Skills 持久化；原始日志只留 .local。能力说明不能把单次验收当 stable。公共测试：node test.mjs。\n');
  put(root, 'docs/ticket.md', '# FIXTURE-006\nSource: docs/spec.md\nRisk hint: low\n交付 result.txt 和 guide.md 的本地演示说明；保持权限契约与一次性回执。设计决定与测试 seam 已确认，无 Owner 未决项。\n');
  put(root, 'input.json', '{"value":7}\n');
  put(root, 'policy.json', '{"guest_private":false}\n');
  put(root, 'guide.md', '# 本地演示\n尚未完成行为验收，长期稳定性未证明。\n');
  put(root, 'effect.mjs', `import fs from 'node:fs';
const previous = JSON.parse(fs.readFileSync('.local/effect.json','utf8'));
fs.writeFileSync('.local/effect.json', JSON.stringify({count:previous.count+1}));
fs.writeFileSync('.local/receipt.json', JSON.stringify({action:'prepare',status:'done',value:7}));
`);
  put(root, 'test.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('result.txt','utf8').trim(),'14');
assert.equal(JSON.parse(fs.readFileSync('policy.json','utf8')).guest_private,false);
assert.equal(JSON.parse(fs.readFileSync('.local/effect.json','utf8')).count,1);
console.log('result, permission and single prepare passed');
`);
  git(root, 'init', '--quiet', '-b', 'fixture/workflow-006');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'fixture baseline');
  const fixed = git(root, 'rev-parse', 'HEAD');
  put(root, '.local/effect.json', { count: 0 });
  assert.equal(run(root, process.execPath, ['effect.mjs']).status, 0);
  put(root, '.local/raw-sentinel.txt', 'WORKFLOW_006_RAW_SENTINEL\n'.repeat(10000));
  put(root, '.local/closeout-input.json', closeoutInput(root, fixed));
  put(root, '.local/case.json', { kind: 'workflow-006', parent, fixed_point: fixed,
    source_commit: git(repository, 'rev-parse', 'HEAD'), skill_files: hashes(path.join(root, '.workflow/skills')),
    raw_sha256: sha(read(root, '.local/raw-sentinel.txt')),
    controls: Object.fromEntries(['test.mjs', 'effect.mjs', 'input.json', 'docs/spec.md', 'AGENTS.md'].map(name => [name, sha(read(root, name))])) });
  put(root, checkpoint, `---
schema_version: 1
ticket: "FIXTURE-006"
phase: ticket-design
worktree: ${JSON.stringify(root)}
branch: "fixture/workflow-006"
fixed_point: "${fixed}"
head: "${fixed}"
implementation_session: null
implementation_runs: []
review_sessions: []
acceptance_runs: []
updated_at: "${new Date().toISOString()}"
---
# Confirmed decisions
docs/design-handoff.md → docs/spec.md → docs/ticket.md；本地 fixture，遵循本次授权终点。
# Current evidence
Git、node test.mjs、.local/receipt.json；.local/case.json 绑定 Skill 来源字节。没有真实 Agent/YCA 验收证据。
# Open findings / blockers
无产品未决项，尚未 Review。
# Side effects
prepare 已完成，先核对 .local/receipt.json 与 .local/effect.json，禁止重放。
# Next action
从持久化产物按公共入口推进到本轮授权终点。
`);
  return { root, fixed_point: fixed, entry: path.join(root, '.workflow/skills/engineering-workflow/SKILL.md'), ticket: path.join(root, 'docs/ticket.md') };
}

try {
  const [command, input, report] = process.argv.slice(2);
  let output;
  if (command === 'create') output = create(input);
  else {
    const { root, state } = checkedRoot(input);
    if (command === 'check-implementation') {
      output = { test: implementation(root, state), subject: subject(root, state.fixed_point) };
    } else if (command === 'inject') output = inject(root, state);
    else if (command === 'interrupt') output = interrupt(root, state, report);
    else if (command === 'check-resume') output = resume(root, state);
    else if (command === 'check-closeout') output = closeout(root, state, report);
    else throw new Error('Commands: create [parent-repo], check-implementation|inject|check-resume <root>, interrupt <root> <report>, check-closeout <root> <snapshot>');
    output = { status: 'artifact-check-passed', behavior_acceptance: 'pending-external-trace-review', root, ...output };
  }
  console.log(JSON.stringify(output));
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: error.message }));
  process.exitCode = 1;
}
