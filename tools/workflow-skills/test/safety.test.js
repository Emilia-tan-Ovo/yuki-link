import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, ok, json, gitExecutable } from './helpers.js';

for (const mutation of ['source', 'manifest', 'tool', 'target-content', 'target-set', 'target-root', 'plan', 'diff']) {
  test(`approval cannot survive ${mutation} drift`, t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.target, 'implement'));
    const installed = path.join(f.target, 'implement/SKILL.md');
    fs.writeFileSync(installed, 'original installed');
    const preview = ok(f.preview());
    const changes = {
      source: () => fs.appendFileSync(path.join(f.repo, '.workflow/skills/implement/SKILL.md'), '\nchanged'),
      manifest: () => fs.appendFileSync(path.join(f.repo, '.workflow/skills/manifest.json'), '\n'),
      tool: () => fs.appendFileSync(path.join(f.tool, 'src/files.js'), '\n// changed'),
      'target-content': () => fs.writeFileSync(installed, 'operator edit'),
      'target-set': () => fs.writeFileSync(path.join(f.target, 'implement/extra.md'), 'keep'),
      'target-root': () => { fs.renameSync(f.target, f.target + '-old'); fs.mkdirSync(f.target); },
      plan: () => { const plan = json(preview.plan); plan.source.commit = '0'.repeat(40); fs.writeFileSync(preview.plan, JSON.stringify(plan)); },
      diff: () => fs.appendFileSync(preview.diff, '\nmisleading diff'),
    };
    changes[mutation]();
    const result = f.call('apply', ['--plan', preview.plan, '--approve', preview.digest]);
    assert.equal(result.status, 1);
    assert.ok(['PLAN_STALE', 'APPROVAL_MISMATCH', 'PLAN_CHANGED', 'TOOL_CHANGED'].includes(result.data.error.code), JSON.stringify(result.data));
    assert.equal(fs.existsSync(path.join(f.target, '.workflow-apply.lock')), false);
    assert.equal(fs.existsSync(path.join(f.target, 'implement/agents/openai.yaml')), false);
    if (mutation !== 'target-root') assert.equal(fs.readFileSync(installed, 'utf8'), mutation === 'target-content' ? 'operator edit' : 'original installed');
  });
}

test('non-installable and unknown selections never create an applyable plan', t => {
  const f = fixture(t);
  for (const name of ['engineering-workflow', 'review-change']) assert.equal(f.preview(name).data.error.code, 'NOT_INSTALLABLE');
  for (const name of ['', '../implement', 'unknown', 'implement,implement']) assert.equal(f.preview(name).data.error.code, 'INVALID_SELECTION');
  assert.deepEqual(fs.readdirSync(f.target), []);
});

for (const unsafe of ['../AGENTS.md', 'AGENTS.md', 'config.toml', 'a/../../outside', 'agents\\openai.yaml', 'SKILL.md:stream', 'CON.txt', 'name.', 'SKILL.md/SKILL.md']) {
  test(`invalid source path ${unsafe} cannot reach the target`, t => {
    const f = fixture(t);
    const file = path.join(f.repo, '.workflow/skills/manifest.json'), manifest = json(file);
    manifest.skills.find(skill => skill.name === 'implement').files.push(unsafe);
    fs.writeFileSync(file, JSON.stringify(manifest));
    const result = f.preview();
    assert.equal(result.status, 1);
    assert.ok(['INVALID_RELATIVE_PATH', 'SOURCE_FILE_SET'].includes(result.data.error.code));
    assert.deepEqual(fs.readdirSync(f.target), []);
  });
}

test('case collisions, hard links and junctions cannot redirect the installation or evidence', t => {
  const f = fixture(t), manifestFile = path.join(f.repo, '.workflow/skills/manifest.json');
  const originalManifest = fs.readFileSync(manifestFile);
  const manifest = json(manifestFile);
  manifest.skills.find(skill => skill.name === 'implement').files.push('skill.md');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.equal(f.preview().data.error.code, 'CASE_COLLISION');
  fs.writeFileSync(manifestFile, originalManifest);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'outside stays intact');
  fs.symlinkSync(outside, path.join(f.target, 'implement'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.preview().data.error.code, 'LINK_NOT_ALLOWED');
  fs.unlinkSync(path.join(f.target, 'implement')); fs.mkdirSync(path.join(f.target, 'implement'));
  fs.linkSync(path.join(outside, 'SKILL.md'), path.join(f.target, 'implement/SKILL.md'));
  assert.equal(f.preview().data.error.code, 'LINK_NOT_ALLOWED');
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'outside stays intact');
});

test('Windows network, device, ADS and ambiguous target paths fail before writes', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  for (const target of ['\\\\server\\share', '//server/share', '\\/server/share', '\\\\?\\C:\\skills', f.target + ':stream', path.join(f.target, 'name.'), path.join(f.target, 'NUL')]) {
    const result = f.call('preview', ['--repo', f.repo, '--target', target, '--skills', 'implement']);
    assert.equal(result.data.error.code, 'INVALID_PATH');
  }
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test('apply and fresh no-op preserve BOM, CRLF and unrelated sentinels without rg', t => {
  const f = fixture(t);
  const content = Buffer.from('\ufeff第一行 🌸\r\n第二行\n', 'utf8');
  fs.writeFileSync(path.join(f.repo, '.workflow/skills/ticket-design/SKILL.md'), content); f.commit();
  const sentinels = [path.join(f.repo, 'AGENTS.md'), path.join(path.dirname(f.target), 'config.toml'), path.join(f.target, 'unrelated/SKILL.md')];
  for (const file of sentinels) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'untouched'); }
  // Restrict PATH to Git plus OS prerequisites; rg is absent and never required.
  const gitDir = path.dirname(gitExecutable);
  const env = { PATH: [gitDir, process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin'].join(path.delimiter) };
  const preview = ok(f.preview('ticket-design', { env }));
  ok(f.call('apply', ['--plan', preview.plan, '--approve', preview.digest], { env }));
  const file = path.join(f.target, 'ticket-design/SKILL.md');
  assert.deepEqual(fs.readFileSync(file), content);
  const before = fs.statSync(file).mtimeMs;
  const noop = ok(f.preview('ticket-design', { env }));
  assert.deepEqual(json(noop.plan).changes.map(change => change.action), ['no-op']);
  ok(f.call('apply', ['--plan', noop.plan, '--approve', noop.digest], { env }));
  assert.equal(fs.statSync(file).mtimeMs, before);
  for (const sentinel of sentinels) assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  const verify = ok(f.call('verify', ['--plan', noop.plan], { env }));
  assert.equal(verify.status, 'verified');
  assert.equal(f.call('apply', ['--plan', preview.plan, '--approve', preview.digest], { env }).status, 1, 'stale plan cannot be replayed');
});

test('Git is resolved outside the working directory and its identity is bound to approval', t => {
  const f = fixture(t);
  fs.copyFileSync(gitExecutable, path.join(f.repo, path.basename(gitExecutable)));
  const preview = ok(f.preview());
  assert.ok(path.isAbsolute(json(preview.plan).tool.git.path));
  assert.notEqual(path.dirname(json(preview.plan).tool.git.path), f.repo);
  assert.match(json(preview.plan).tool.git.sha256, /^[a-f0-9]{64}$/);
  const alternate = path.join(f.root, 'alternate-bin'); fs.mkdirSync(alternate);
  fs.copyFileSync(gitExecutable, path.join(alternate, path.basename(gitExecutable)));
  const result = f.call('apply', ['--plan', preview.plan, '--approve', preview.digest], {
    env: { PATH: alternate + path.delimiter + process.env.PATH },
  });
  assert.notEqual(result.status, 0, 'a different executable location cannot inherit approval');
  assert.deepEqual(fs.readdirSync(f.target), []);
});
