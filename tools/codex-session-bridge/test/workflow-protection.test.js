import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { connectText } from './helpers/text-fixture.js';

test('workflow source stays editable while installed Skills and AGENTS remain protected over MCP', async t => {
  const { workspace, call } = await connectText(t);
  const source = path.join(workspace, '.workflow/skills/implement/SKILL.md');
  mkdirSync(path.dirname(source), { recursive: true });
  const created = await call('filesystem_write', { path: source, content: 'repo source fixture' });
  assert.equal(created.isError, false);
  for (const relative of ['AGENTS.md', 'CLAUDE.md', '.agents/skills/implement/SKILL.md', '.codex/skills/implement/agents/openai.yaml']) {
    const installed = path.join(workspace, relative);
    mkdirSync(path.dirname(installed), { recursive: true });
    writeFileSync(installed, 'protected fixture');
    const read = await call('filesystem_read', { path: installed });
    assert.equal(read.content, 'protected fixture');
    for (const [name, args] of [
      ['filesystem_write', { path: installed, content: 'replacement', expected_sha256: read.sha256 }],
      ['filesystem_move', { source, destination: installed, expected_sha256: created.sha256 }],
      ['filesystem_move', { source: installed, destination: path.join(workspace, 'elsewhere.md'), expected_sha256: read.sha256 }],
    ]) assert.equal((await call(name, args)).error.code, 'PROTECTED_PATH', `${name}: ${relative}`);
    assert.equal(readFileSync(installed, 'utf8'), 'protected fixture');
  }
  assert.equal(readFileSync(source, 'utf8'), 'repo source fixture');
});
