// 本地验收夹具：准备/中断/核对外部产物，不实现或替代 Skill router。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixturesRoot = path.join(repo, '.local/workflow-fixtures');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function put(root, name, content) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), content, 'utf8');
}
const json = (root, name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
function state(root, phase, head, next) {
  return `---
schema_version: 1
ticket: FIXTURE-003
phase: ${phase}
worktree: ${JSON.stringify(root)}
branch: fixture/workflow-003
fixed_point: ${git(root, 'rev-list', '--max-parents=0', 'HEAD')}
head: ${head}
implementation_session: fixture-session
implementation_runs: [fixture-run]
review_sessions: []
acceptance_runs: []
updated_at: "2000-01-01T00:00:00Z"
---
# Confirmed decisions
读取 docs/ticket.md 的 Notes 与 docs/spec.md。只修改 result.txt；不 push、PR、全局 apply。
# Current evidence
本地可控 YCA/runtime 输入：.local/runtime.json（非真实 YCA）。Git/test/receipt 每次重新读。
若存在 .local/review.json，这是可控已完成双轴 review 证据；需校验 subject 和 finding，不能只信 phase。
# Open findings / blockers
人为模拟客户端 external interruption；项目与 Codex 结果待动态验证。
# Side effects
prepare 响应在中断时丢失，状态 unknown。核对 .local/effect.json 与 .local/receipt.json。
# Next action
${next}
`;
}
function subject(root) {
  const files = git(root, 'ls-files', '-z').split('\0').filter(Boolean);
  if (existsSync(path.join(root, 'result.txt')) && !files.includes('result.txt')) files.push('result.txt');
  return sha(JSON.stringify(files.sort().map(file => [file, sha(readFileSync(path.join(root, file)))])));
}
function checkedRoot(input) {
  assert.ok(input, 'fixture root required');
  const root = realpathSync(input);
  const relative = path.relative(realpathSync(fixturesRoot), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture must be inside this checkout');
  assert.equal(json(root, '.local/fixture.json').kind, 'workflow-003');
  return root;
}

const [command, input] = process.argv.slice(2);
if (command === 'create') {
  mkdirSync(fixturesRoot, { recursive: true });
  const root = mkdtempSync(path.join(fixturesRoot, 'recovery-'));
  cpSync(path.join(repo, '.workflow/skills'), path.join(root, '.workflow/skills'), { recursive: true });
  put(root, '.gitignore', '.local/\n');
  put(root, '.gitattributes', '* -text\n');
  put(root, 'AGENTS.md', '# Fixture 约定\n只修改当前 fixture；中文说明。不要提交、push、联网、全局 apply。按照当前调用方给定阶段终点停下。Node 测试：node test.mjs。\n');
  put(root, 'CONTEXT.md', '# 领域\n输入值：input.json 的 value。结果：其两倍，写入 result.txt。\n');
  put(root, 'docs/spec.md', '# 已确认 Spec\n输入 value=7，result.txt 输出 14（可带换行）。prepare 是一次性已授权动作；中断后先查 receipt，已完成则不能重做。只修改结果文件。测试 seam 已确认：node test.mjs。无新产品决定。\n');
  put(root, 'docs/ticket.md', '# FIXTURE-003\nSource: docs/spec.md\n实现结果输出并通过 node test.mjs。prepare 先查回执。无阻塞票。\n\n## Implementation Notes\n读取 input.json 计算两倍，仅写 result.txt。prepare 是非幂等副作用，先读 .local/receipt.json 与 effect.json；done 时跳过。Node 测试与文件是本地验收 seam。\n');
  put(root, 'input.json', '{"value":7}\n');
  put(root, 'effect.mjs', `import fs from 'node:fs';
const file = '.local/effect.json';
const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.writeFileSync(file, JSON.stringify({count: previous.count + 1}));
fs.writeFileSync('.local/receipt.json', JSON.stringify({action:'prepare',status:'done',value:7}));
`);
  put(root, 'test.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('result.txt', 'utf8').trim(), '14');
assert.equal(JSON.parse(fs.readFileSync('.local/effect.json', 'utf8')).count, 1, 'prepare must happen once');
console.log('fixture result and exactly-once effect verified');
`);
  put(root, 'inspect.mjs', `import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const sha = x => createHash('sha256').update(x).digest('hex');
const files = execFileSync('git', ['ls-files','-z'], {encoding:'utf8',windowsHide:true}).trim().split('\\0').filter(Boolean);
if (fs.existsSync('result.txt') && !files.includes('result.txt')) files.push('result.txt');
const subject = sha(JSON.stringify(files.sort().map(f => [f, sha(fs.readFileSync(f))])));
console.log(JSON.stringify({subject,runtime:JSON.parse(fs.readFileSync('.local/runtime.json','utf8')),receipt:JSON.parse(fs.readFileSync('.local/receipt.json','utf8')),effect:JSON.parse(fs.readFileSync('.local/effect.json','utf8'))}));
`);
  for (const script of ['effect.mjs', 'test.mjs', 'inspect.mjs']) {
    const result = spawnSync(process.execPath, ['--check', script], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  git(root, 'init', '--quiet', '-b', 'fixture/workflow-003');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'fixture baseline');
  const baseline = git(root, 'rev-parse', 'HEAD');
  put(root, 'environment.txt', 'fixture environment revision 2\n');
  git(root, 'add', 'environment.txt'); git(root, 'commit', '--quiet', '-m', 'fixture environment changed');
  put(root, '.local/fixture.json', JSON.stringify({ kind: 'workflow-003', baseline }));
  put(root, '.local/effect.json', '{"count":1}');
  put(root, '.local/receipt.json', '{"action":"prepare","status":"done","value":7}');
  put(root, '.local/runtime.json', '{"run":"fixture-run","status":"cancelled","session_available":false,"reason":"fixture human interruption"}');
  put(root, '.local/workflow-state/FIXTURE-003.md', state(root, 'implementation', baseline, '先核验旧 run/prepare 的实际状态，恢复剩余实现；通过测试后交接 review。'));
  console.log(JSON.stringify({ root, baseline, head: git(root, 'rev-parse', 'HEAD') }));
} else {
  const root = checkedRoot(input);
  if (command.startsWith('stage-')) {
    const stage = command.slice(6);
    assert.ok(['discovery', 'spec', 'tickets', 'ticket-design'].includes(stage));
    put(root, 'AGENTS.md', readFileSync(path.join(root, 'AGENTS.md'), 'utf8') + '\n本夹具 tracker 为本地 docs/tickets/，不发布真实 Issue。\n');
    if (stage === 'ticket-design') {
      put(root, 'docs/ticket.md', '# FIXTURE-003\nSource: docs/spec.md\n实现 result.txt 并通过 node test.mjs。prepare 先查回执。无阻塞票。范围与测试 seam 已确认；当前只做设计交接。\n');
    } else {
      unlinkSync(path.join(root, 'docs/ticket.md'));
      if (stage !== 'tickets') unlinkSync(path.join(root, 'docs/spec.md'));
      put(root, 'docs/design-handoff.md', stage === 'discovery'
        ? '# Design Handoff\n目标：显示输入值的计算结果。Unresolved：Owner 尚未决定输出原值还是两倍；不可自行决定。Next：解决这一产品选择。\n'
        : '# 已确认 Design Handoff\n输出输入值的两倍；value=7 时输出14到 result.txt。单票即可，测试 seam 为 node test.mjs，均已确认。范围只包含结果文件。Unresolved：无。\n');
    }
    put(root, '.local/workflow-state/FIXTURE-003.md', state(root, stage, git(root, 'rev-parse', 'HEAD'), '根据已持久化产物协调当前阶段和领域 Skill，遵循本轮授权终点。'));
    console.log(JSON.stringify({root, input: stage === 'ticket-design' ? 'docs/ticket.md' : stage === 'tickets' ? 'docs/spec.md' : 'docs/design-handoff.md'}));
  } else if (command === 'incompatible-tracker') {
    put(root, 'AGENTS.md', readFileSync(path.join(root, 'AGENTS.md'), 'utf8') + '\n当前 docs/ticket.md 是不可修改的 tracker 导出镜像，tracker 不接受额外 Markdown section 或扩展字段。保持 ticket 文件原样。\n');
    put(root, '.local/ticket-original.sha256', sha(readFileSync(path.join(root, 'docs/ticket.md'))));
  } else if (command === 'check-notes') {
    assert.equal(sha(readFileSync(path.join(root, 'docs/ticket.md'))), readFileSync(path.join(root, '.local/ticket-original.sha256'), 'utf8'));
    const notes = readFileSync(path.join(root, 'docs/implementation-notes/FIXTURE-003.md'), 'utf8');
    assert.ok(notes.includes('docs/ticket.md') && notes.includes('docs/spec.md'), 'fallback notes must retain source references');
    const checkpoint = readFileSync(path.join(root, '.local/workflow-state/FIXTURE-003.md'), 'utf8');
    assert.ok(checkpoint.includes('docs/implementation-notes/FIXTURE-003.md'), 'fresh session must be able to locate notes');
    assert.equal(existsSync(path.join(root, 'result.txt')), false, 'design must not implement');
    console.log(JSON.stringify({ status: 'passed', command, root }));
  } else if (command === 'interrupt-review') {
    const report = { status: 'completed', standards: 'pass', spec: 'pass', findings: [], fixture: true,
      subject: subject(root), head: git(root, 'rev-parse', 'HEAD'), fixed_point: json(root, '.local/fixture.json').baseline,
      note: '可控外部 reviewer 证据；不是本次真实 Agent review 的声明' };
    put(root, '.local/review.json', JSON.stringify(report, null, 2));
    put(root, '.local/review-original.sha256', sha(readFileSync(path.join(root, '.local/review.json'))));
    put(root, '.local/workflow-state/FIXTURE-003.md', state(root, 'review', report.head, '断连前计划执行 full review；恢复时先查 reviewer 证据，随后继续正确 phase。'));
  } else if (command === 'running') {
    put(root, '.local/runtime.json', '{"run":"fixture-run","status":"running","session_available":true,"new_events":true}');
  } else if (command === 'check-implementation' || command === 'check-acceptance' || command === 'check-running') {
    assert.equal(json(root, '.local/effect.json').count, 1, 'must not replay completed effect');
    const checkpoint = readFileSync(path.join(root, '.local/workflow-state/FIXTURE-003.md'), 'utf8');
    if (command === 'check-running') {
      assert.equal(existsSync(path.join(root, 'result.txt')), false, 'must not race the active run');
      assert.match(checkpoint, /phase: implementation/);
    } else {
      const result = spawnSync(process.execPath, ['test.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(checkpoint.includes(git(root, 'rev-parse', 'HEAD')), 'must refresh stale HEAD');
      assert.match(checkpoint, command === 'check-implementation' ? /phase: review/ : /phase: closeout/);
      if (command === 'check-acceptance') {
        assert.equal(sha(readFileSync(path.join(root, '.local/review.json'))), readFileSync(path.join(root, '.local/review-original.sha256'), 'utf8'));
        assert.equal(subject(root), json(root, '.local/review.json').subject, 'review evidence still covers the content');
      }
    }
    assert.equal(git(root, 'ls-files', '.local'), '', 'checkpoint cannot enter Git');
    console.log(JSON.stringify({ status: 'passed', command, root, head: git(root, 'rev-parse', 'HEAD') }));
  } else throw new Error('Commands: create, stage-<phase>, incompatible-tracker, check-notes, interrupt-review, running, check-implementation, check-acceptance, check-running');
}
