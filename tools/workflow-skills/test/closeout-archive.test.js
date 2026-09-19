import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../.workflow/skills/engineering-workflow/scripts/closeout-archive.mjs', import.meta.url));
const observed = '2026-09-19T04:00:00.000Z';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closeout-005-'));
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'closeout-005-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, '仓库 [1]');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.local'));
  const input = path.join(repo, '.local', 'input.json');
  const archive = path.join(repo, '.workflow/history/005.md');
  const fact = (status, summary, sources = []) => ({ status, summary, sources });
  const stage = summary => ({ ...fact('pending', summary), sessions: [] });
  const data = {
    schema_version: 1, ticket: '005', issue: 'https://example.invalid/issues/27',
    sources: ['docs/tickets/005.md', 'docs/specs/workflow.md'], observed_at: observed,
    worktree: repo, branch: 'codex/005', fixed_point: 'a'.repeat(40), head: 'b'.repeat(40),
    summary: '生成轻量归档；尚待验收。',
    stages: {
      implementation: { ...fact('recorded', '实现已交接', ['ticket#handoff']), sessions: [
        { id: 'session-1', runs: ['run-1'], model: 'fixture-model', reasoning: 'medium' },
      ] },
      review: stage('Emilia 保留 reviewer 启动权'), acceptance: stage('尚未验收'),
    },
    metrics: fact('recorded', '代表性 run：1000 ms，2 次工具调用；非全票统计。', ['run-1']),
    failures: fact('recorded', 'Notes 同步 403，未重试。', ['checkpoint']),
    findings: fact('unknown', '尚未 review，不能声称零 finding'),
    interventions: fact('recorded', 'Owner 限定 005 范围。', ['ticket']),
    delivery: { pr: fact('pending', '尚无 PR'), merge: fact('pending', '尚未合并') },
    evidence: [{ id: 'raw-1', location: '.local/run.jsonl', status: 'unknown',
      observed_at: observed, identity: 'run-1' }],
  };
  function call(command, value = data, entry = script) {
    fs.writeFileSync(input, JSON.stringify(value));
    const result = spawnSync(process.execPath, [entry, command, repo, input], {
      encoding: 'utf8', shell: false, windowsHide: true,
    });
    let output;
    try { output = JSON.parse(result.stdout); } catch { /* Include output in assertions. */ }
    return { ...result, output };
  }
  return { root, repo, input, archive, data, call };
}

test('archive is readable, deterministic and carries pending facts without copying raw logs', t => {
  const f = setup(t);
  const raw = path.join(f.repo, '.local/run.jsonl');
  const sentinel = 'PRIVATE_RAW_SENTINEL\n'.repeat(10000);
  fs.writeFileSync(raw, sentinel);
  const capture = f.call('observe');
  assert.equal(capture.status, 0, capture.stderr || capture.stdout);
  assert.equal(capture.output.evidence[0].status, 'available');
  const generated = f.call('generate', capture.output);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const first = fs.readFileSync(f.archive, 'utf8');
  for (const value of ['生成轻量归档', 'session-1', 'run-1', 'fixture-model', 'medium',
    '1000 ms', '403', '尚未 review', 'Owner', '尚无 PR', '尚未合并', 'pending',
    '本机', 'source of truth', '.local/run.jsonl', 'codex/005']) assert.ok(first.includes(value), value);
  assert.ok(!first.includes('PRIVATE_RAW_SENTINEL'));
  assert.equal(fs.readFileSync(raw, 'utf8'), sentinel);
  // Generation consumes a frozen observation, not current runtime availability.
  fs.unlinkSync(raw);
  assert.equal(f.call('generate', capture.output).status, 0);
  assert.equal(fs.readFileSync(f.archive, 'utf8'), first);
  const clone = path.join(f.root, 'git-only/.workflow/history');
  fs.mkdirSync(clone, { recursive: true });
  fs.copyFileSync(f.archive, path.join(clone, '005.md'));
  assert.equal(fs.readFileSync(path.join(clone, '005.md'), 'utf8'), first);
  assert.ok(!fs.existsSync(path.join(f.root, 'git-only/.local')));
});

test('explicit evidence observations distinguish missing, stale, unknown and not-applicable', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.repo, '.local/old.txt'), 'old result');
  f.data.evidence = [
    { id: 'missing', location: '.local/gone.jsonl', status: 'available', observed_at: observed, identity: 'run-gone' },
    { id: 'stale', location: '.local/old.txt', status: 'stale', observed_at: observed, identity: 'review covers old HEAD' },
    { id: 'unknown', location: '.local', status: 'unknown', observed_at: observed, identity: null },
    { id: 'direct', location: null, status: 'not-applicable', observed_at: observed, identity: 'Emilia direct acceptance' },
  ];
  const capture = f.call('observe');
  assert.equal(capture.status, 0, capture.stdout);
  assert.deepEqual(capture.output.evidence.map(item => item.status), ['missing', 'stale', 'unknown', 'not-applicable']);
  assert.equal(f.call('generate', capture.output).status, 0);
  const archive = fs.readFileSync(f.archive, 'utf8');
  for (const status of ['missing', 'stale', 'unknown', 'not-applicable']) assert.ok(archive.includes(status));
  assert.ok(archive.includes('review covers old HEAD'));
});

test('invalid input and output paths fail closed and preserve an existing archive', t => {
  const f = setup(t);
  assert.equal(f.call('generate').status, 0);
  const before = fs.readFileSync(f.archive);
  const invalid = [
    { ...f.data, ticket: '../005' },
    { ...f.data, raw: 'RAW_MUST_NOT_PASS' },
    { ...f.data, summary: 'x'.repeat(70000) },
    { ...f.data, delivery: { pr: f.data.delivery.pr } },
  ];
  for (const value of invalid) {
    const result = f.call('generate', value);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.output.status, 'error');
    assert.deepEqual(fs.readFileSync(f.archive), before);
  }
  // A target directory blocks replacement without destroying its contents.
  fs.renameSync(f.archive, `${f.archive}.saved`);
  fs.mkdirSync(f.archive);
  fs.writeFileSync(path.join(f.archive, 'keep'), 'keep');
  assert.equal(f.call('generate').status, 1);
  assert.equal(fs.readFileSync(path.join(f.archive, 'keep'), 'utf8'), 'keep');
  assert.deepEqual(fs.readFileSync(`${f.archive}.saved`), before);
  assert.ok(!fs.readdirSync(path.dirname(f.archive)).some(name => name.endsWith('.tmp')));
});

test('archive output cannot escape through a linked workflow directory', t => {
  const f = setup(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(path.join(outside, 'history'), { recursive: true });
  const protectedFile = path.join(outside, 'history/005.md');
  fs.writeFileSync(protectedFile, 'keep external bytes');
  fs.symlinkSync(outside, path.join(f.repo, '.workflow'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.call('generate');
  assert.equal(result.status, 1, result.stdout);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep external bytes');
});
