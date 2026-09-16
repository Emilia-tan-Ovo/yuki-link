import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { PathPolicy } from '../src/computer/paths.js';

test('dedicated filesystem tools protect control center installation and local configuration', t => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'yuki-control-path-test-'));
  t.after(() => { assert.ok(runtime.startsWith(path.join(os.tmpdir(), 'yuki-control-path-test-'))); rmSync(runtime, { recursive: true, force: true }); });
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const policy = new PathPolicy([repo], [repo], runtime);
  for (const file of ['.local/control-center/config.json', '.local/control-center/runtime/state.json']) {
    assert.throws(() => policy.resolve(path.join(repo, file)), { code: 'PROTECTED_PATH' });
    assert.throws(() => policy.resolve(path.join(repo, file), { write: true }), { code: 'PROTECTED_PATH' });
  }
  assert.throws(() => policy.resolve(path.join(repo, 'tools/control-center/src/main.js'), { write: true }), { code: 'PROTECTED_PATH' });
  assert.ok(policy.resolve(path.join(repo, 'README.md')));
});
