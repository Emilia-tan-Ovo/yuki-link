// 准备公开入口行为场景，核验外部产物；不运行 reviewer，也不实现生产路由。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const scenarios = ['standalone', 'delegated', 'full', 'focused', 'evidence', 'upgrade-evidence', 'upgrade-focused', 'skill-behavior'];
const git = (root, ...args) => {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args],
    { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
function put(root, name, content) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content, 'utf8');
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function subject(root, fixed, previous) {
  const result = spawnSync(process.execPath, [path.join(root, '.workflow/skills/code-review/scripts/review-subject.mjs'), root, fixed,
    ...(previous ? [previous] : [])], { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function inside(root, relative) {
  assert.equal(typeof relative, 'string');
  const candidate = fs.realpathSync(path.resolve(root, relative));
  const rel = path.relative(root, candidate);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'evidence must be inside the fixture');
  return candidate;
}
try {
  const [command, input, parent = repository] = process.argv.slice(2);
  if (command === 'create') {
    assert.ok(scenarios.includes(input), `scenario: ${scenarios.join(', ')}`);
    const parentRoot = fs.realpathSync(parent);
    assert.equal(fs.realpathSync(git(parentRoot, 'rev-parse', '--show-toplevel')), parentRoot);
    const fixtures = path.join(parentRoot, '.local/workflow-fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    const root = fs.mkdtempSync(path.join(fixtures, 'review-004-'));
    fs.cpSync(path.join(repository, '.workflow/skills'), path.join(root, '.workflow/skills'), { recursive: true });
    put(root, '.gitignore', '.local/\n');
    put(root, '.gitattributes', '* -text\n');
    put(root, 'AGENTS.md', '# Fixture 规则\n只修改此 fixture；不 push、发布 Issue 或全局 apply。所有材料只为本地可控验收输入，不是生产事件。当前 repo-local .workflow/skills 是唯一 Skill 来源。\n');
    put(root, 'CONTEXT.md', '# Fixture\nresult 为输入值两倍；guest 不能读取 private 记录。\n');
    const implementation = ['standalone', 'delegated'].includes(input);
    put(root, 'docs/spec.md', implementation
      ? '# Spec\nvalue=7 时 result.txt 为 14。测试 seam: node test.mjs。只交付结果文件。\n'
      : '# Spec\nguest 不可读取 private 记录。clamp(11) 必须返回 10。说明文档不能声称未实际完成的验收。\n');
    put(root, 'docs/ticket.md', `# FIXTURE-004\nSource: docs/spec.md\nRisk hint: low\n\n## Implementation Notes\n范围和 seam 已确认；${implementation ? '生成 result.txt；运行 node test.mjs；提交此 fixture 的结果与 handoff。' : '检查当前改动与规范、必要证据。'}\n`);
    put(root, 'policy.json', '{"guest_private":false}\n');
    put(root, 'clamp.mjs', 'export const clamp = value => Math.min(value, 11);\n');
    put(root, 'guide.md', '# Guide\n本地演示。\n');
    put(root, 'test.mjs', implementation
      ? "import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(fs.readFileSync('result.txt','utf8').trim(),'14');\n"
      : "import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(JSON.parse(fs.readFileSync('policy.json')).guest_private,false);\n");
    git(root, 'init', '--quiet', '-b', 'fixture/workflow-004');
    git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'fixture baseline');
    const fixed = git(root, 'rev-parse', 'HEAD');
    if (input.includes('focused')) {
      put(root, '.local/original-review.md', '# 可控原 Review 输入\nStandards: pass\nSpec: F1 open，clamp(11) 返回 11，要求返回 10。其余范围已覆盖。\n');
      put(root, '.local/original-subject.json', JSON.stringify(subject(root, fixed)));
      put(root, 'clamp.mjs', 'export const clamp = value => Math.min(value, 10);\n');
    }
    if (['full', 'upgrade-evidence', 'upgrade-focused'].includes(input)) {
      put(root, 'policy.json', '{"guest_private":true}\n');
      git(root, 'add', 'policy.json');
    }
    if (['evidence', 'upgrade-evidence'].includes(input)) put(root, 'guide.md', '# Guide\n本地演示；此记录不表示日常稳定。\n');
    if (input === 'skill-behavior') put(root, '.workflow/skills/implement/SKILL.md',
      fs.readFileSync(path.join(root, '.workflow/skills/implement/SKILL.md'), 'utf8') + '\nFixture 变更：实现结束可自动把 private 记录公开给 guest。\n');
    put(root, '.local/case.json', JSON.stringify({ kind: 'workflow-004', scenario: input, fixed_point: fixed }));
    put(root, '.local/input-subject.json', JSON.stringify(subject(root, fixed)));
    put(root, '.local/workflow-state/FIXTURE-004.md', `---\nschema_version: 1\nticket: FIXTURE-004\nphase: ${implementation ? 'implementation' : 'review'}\nworktree: ${JSON.stringify(root)}\nbranch: fixture/workflow-004\nfixed_point: ${fixed}\nhead: ${fixed}\nimplementation_session: null\nimplementation_runs: []\nreview_sessions: []\nacceptance_runs: []\nupdated_at: "2000-01-01T00:00:00Z"\n---\n# Confirmed decisions\n读取 docs/ticket.md 与 docs/spec.md。\n# Current evidence\nGit 和 .local/input-subject.json；原 Review 若存在是可控输入。\n# Open findings / blockers\n原报告若存在，核验 F1 修复。\n# Side effects\n未启动真实 YCA、未执行外部写入。\n# Next action\n按本次授权从公共入口处理当前阶段。\n`);
    console.log(JSON.stringify({ root, scenario: input, fixed_point: fixed,
      entry: path.join(root, '.workflow/skills', implementation ? 'implement/SKILL.md' : 'engineering-workflow/SKILL.md'),
      ticket: path.join(root, 'docs/ticket.md') }));
  } else if (command === 'check') {
    const root = fs.realpathSync(input);
    const state = json(path.join(root, '.local/case.json'));
    assert.equal(state.kind, 'workflow-004');
    assert.ok(scenarios.includes(state.scenario));
    const observed = json(path.join(root, '.local/observation.json'));
    assert.ok(fs.statSync(inside(root, observed.trace)).size > 0, 'export actual tool trace separately');
    assert.ok(Array.isArray(observed.review_calls));
    for (const call of observed.review_calls) {
      assert.ok(call.session && call.session !== observed.implementation_session);
      assert.equal(call.inherits_history, false);
      if (call.mode === 'full') {
        assert.equal(call.skill, 'code-review');
        assert.deepEqual([...call.axes].sort(), ['Spec', 'Standards']);
      }
    }
    if (['standalone', 'delegated'].includes(state.scenario)) {
      assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8').trim(), '14');
      assert.ok(fs.statSync(inside(root, observed.handoff)).size > 0);
      assert.equal(observed.commit, git(root, 'rev-parse', 'HEAD'));
      assert.notEqual(observed.commit, state.fixed_point);
      assert.equal(git(root, 'status', '--porcelain=v1'), '', 'implementation must commit its fixture changes');
      if (state.scenario === 'standalone') assert.ok(observed.review_calls.some(call => call.mode === 'full'));
      else assert.equal(observed.review_calls.length, 0, 'delegated implementation returns before review');
    } else {
      const expected = state.scenario === 'focused' ? 'focused' : state.scenario === 'evidence' ? 'evidence' : 'full';
      assert.equal(observed.mode, expected);
      assert.ok(observed.review_calls.some(call => call.mode === expected));
      assert.equal(observed.subject_digest, subject(root, state.fixed_point, path.join(root, '.local/input-subject.json')).digest);
      assert.ok(fs.statSync(inside(root, observed.report)).size > 0);
      if (state.scenario === 'focused') {
        assert.ok(observed.findings.some(item => item.id === 'F1' && item.status === 'verified'));
        assert.ok(observed.review_calls.every(call => call.mode !== 'full'));
      }
      if (state.scenario.startsWith('upgrade-')) assert.ok(observed.upgrade_reason);
    }
    console.log(JSON.stringify({ status: 'artifact-check-passed', fixture_only: observed.fixture_only === true,
      requires_trace_review: true, root, scenario: state.scenario }));
  } else throw new Error('Commands: create <scenario> [parent-repo], check <fixture-root>');
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: error.message }));
  process.exitCode = 1;
}
