import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDshConfig } from '../backend/dsh/runner.mjs';

const VERSION = '0.1.0-rc.6';
const packageAt = (dir, name, version = VERSION) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
};

test('rc.6 core headless package works without a materialized headless profile directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'yuki-dsh-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const modules = join(root, 'node_modules', '@deepseek-ai');
  const dsh = join(modules, 'dsh'); packageAt(dsh, '@deepseek-ai/dsh');
  mkdirSync(join(dsh, 'lib'), { recursive: true }); writeFileSync(join(dsh, 'lib', 'bin.js'), '');
  packageAt(join(modules, 'dsh-base'), '@deepseek-ai/dsh-base');
  packageAt(join(modules, 'dsh-headless'), '@deepseek-ai/dsh-headless');
  packageAt(join(modules, 'dsh-mcp-client'), '@deepseek-ai/dsh-mcp-client');
  const config = { schema_version: 1, node: process.execPath, home, packageDirectory: dsh,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', ycaUrl: 'http://127.0.0.1:7391/companion-mcp' };
  const selected = validateDshConfig(config);
  assert.equal(selected.provider, 'deepseek-official');
  assert.equal(selected.model, 'deepseek-v4-flash');
  assert.equal(selected.ycaUrl, 'http://127.0.0.1:7391/companion-mcp');
  packageAt(join(modules, 'dsh-headless'), '@deepseek-ai/dsh-headless', '0.1.0-rc.5');
  assert.throws(() => validateDshConfig(config), /pinned version mismatch/);
});