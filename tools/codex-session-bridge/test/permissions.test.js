import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionResolver, permissionSnapshotFromConfig, sessionPermissionSnapshot } from '../src/permissions.js';
import { spawnDirect, isProcessAlive } from '../src/process.js';
import { execArguments } from '../src/executor.js';

test('effective Codex permissions are normalized into a replayable snapshot', () => {
  const full = permissionSnapshotFromConfig({
    sandbox_mode: 'danger-full-access',
    approval_policy: 'on-request',
    approvals_reviewer: null,
    sandbox_workspace_write: null,
    default_permissions: null,
    permissions: null,
  }, 'local_codex_config');
  assert.equal(full.approvals_reviewer, 'user');
  assert.equal(full.workspace_write, null);

  const workspace = permissionSnapshotFromConfig({
    sandbox_mode: 'workspace-write',
    approval_policy: 'never',
    sandbox_workspace_write: null,
    default_permissions: null,
    permissions: null,
  });
  assert.deepEqual(workspace.workspace_write, {
    writable_roots: [],
    network_access: false,
    exclude_slash_tmp: false,
    exclude_tmpdir_env_var: false,
  });
});

test('workspace snapshots reject unknown config dimensions and damaged persisted state', () => {
  assert.throws(() => permissionSnapshotFromConfig({
    sandbox_mode: 'workspace-write',
    approval_policy: 'on-request',
    sandbox_workspace_write: { future_permission_dimension: true },
    default_permissions: null,
    permissions: null,
  }), { code: 'UNSUPPORTED_PERMISSION_MODE' });

  assert.throws(() => sessionPermissionSnapshot({
    permissions: {
      version: 1, kind: 'native', stored: true,
      sandbox_mode: 'workspace-write', approval_policy: 'on-request', approvals_reviewer: 'user',
      workspace_write: null, source: 'fixture', resolved_at: new Date().toISOString(),
    },
  }), { code: 'SESSION_PERMISSION_INVALID' });

  assert.throws(() => sessionPermissionSnapshot({
    permissions: {
      version: 1, kind: 'native', stored: true,
      sandbox_mode: 'danger-full-access', approval_policy: 'on-request', approvals_reviewer: 'user',
      workspace_write: null, source: 'fixture', resolved_at: new Date().toISOString(),
      future_permission_dimension: true,
    },
  }), { code: 'SESSION_PERMISSION_INVALID' });

  assert.throws(() => sessionPermissionSnapshot({
    permissions: {
      version: 1, kind: 'native', stored: true,
      sandbox_mode: 'read-only', approval_policy: 'never', approvals_reviewer: 'user',
      workspace_write: { writable_roots: [], network_access: false, exclude_slash_tmp: false, exclude_tmpdir_env_var: false },
      source: 'fixture', resolved_at: new Date().toISOString(),
    },
  }), { code: 'SESSION_PERMISSION_INVALID' });
});

test('native executor pins a built-in permission profile as well as the legacy sandbox axis', () => {
  const base = {
    version: 1, kind: 'native', stored: true,
    approval_policy: 'on-request', approvals_reviewer: 'user',
    workspace_write: null, source: 'fixture', resolved_at: new Date().toISOString(),
  };
  for (const [sandbox_mode, profile] of [
    ['read-only', ':read-only'],
    ['danger-full-access', ':danger-full-access'],
  ]) {
    const args = execArguments(
      { model: 'gpt-5.6-sol', reasoning: 'medium' },
      { cwd: process.cwd(), codex_thread_id: null, permissions: { ...base, sandbox_mode } },
    );
    assert.ok(args.includes(sandbox_mode));
    assert.ok(args.includes(`default_permissions="${profile}"`));
    assert.ok(!args.includes('--ignore-user-config'));
  }

  const workspace = {
    ...base,
    sandbox_mode: 'workspace-write',
    workspace_write: { writable_roots: ['C:/extra'], network_access: true, exclude_slash_tmp: true, exclude_tmpdir_env_var: false },
  };
  const args = execArguments({ model: 'gpt-5.6-sol', reasoning: 'medium' }, { cwd: process.cwd(), codex_thread_id: 'thread-id', permissions: workspace });
  assert.ok(args.includes('default_permissions=":workspace"'));
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["C:/extra"]'));
  assert.deepEqual(args.slice(-3), ['resume', 'thread-id', '-']);
});

test('permission profiles and non-replayable approval policies fail explicitly', () => {
  assert.throws(() => permissionSnapshotFromConfig({
    sandbox_mode: 'danger-full-access', approval_policy: 'on-request', default_permissions: ':workspace',
  }), { code: 'UNSUPPORTED_PERMISSION_PROFILE' });
  assert.throws(() => permissionSnapshotFromConfig({
    sandbox_mode: 'danger-full-access', approval_policy: { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true } },
  }), { code: 'UNSUPPORTED_PERMISSION_MODE' });
  assert.throws(() => permissionSnapshotFromConfig({
    sandbox_mode: 'danger-full-access', approval_policy: 'untrusted',
  }), { code: 'UNSUPPORTED_PERMISSION_MODE' });
});

test('sessions without a snapshot preserve the legacy bridge permission contract', () => {
  const legacy = sessionPermissionSnapshot({ id: 'old-session' });
  assert.equal(legacy.kind, 'legacy');
  assert.equal(legacy.stored, false);
  assert.equal(legacy.sandbox_mode, 'read-only');
  assert.equal(legacy.approval_policy, 'never');
  assert.throws(() => sessionPermissionSnapshot({ permissions: { version: 99, kind: 'native' } }), { code: 'SESSION_PERMISSION_INVALID' });
});

test('PermissionResolver uses Codex app-server config/read and passes explicit native overrides', async () => {
  let seenArgs;
  const fixture = `
    const readline=require('node:readline');
    const rl=readline.createInterface({input:process.stdin});
    rl.on('line', line => {
      const m=JSON.parse(line);
      if (!m.id) return;
      if (m.method==='initialize') process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture'}})+'\\n');
      else if (m.method==='config/read') process.stdout.write(JSON.stringify({id:m.id,result:{config:{
        sandbox_mode:'workspace-write', approval_policy:'never', approvals_reviewer:null,
        sandbox_workspace_write:{writable_roots:['C:/extra'],network_access:true},
        default_permissions:null, permissions:null
      }}})+'\\n');
    });
  `;
  const resolver = new PermissionResolver('fake-codex', {
    timeoutMs: 2000,
    resolveExecutable: () => ({ executable: 'fake-codex' }),
    spawnChild: (_command, args, options) => {
      seenArgs = args;
      return spawnDirect(process.execPath, ['-e', fixture], options);
    },
  });
  const snapshot = await resolver.resolve(process.cwd(), {
    sandbox_mode: 'workspace-write',
    approval_policy: 'never',
    approvals_reviewer: 'user',
  });
  assert.equal(snapshot.source, 'explicit_codex_config');
  assert.equal(snapshot.workspace_write.network_access, true);
  assert.deepEqual(snapshot.workspace_write.writable_roots, ['C:/extra']);
  assert.deepEqual(seenArgs.slice(0, 2), ['app-server', '--stdio']);
  assert.ok(seenArgs.includes('sandbox_mode="workspace-write"'));
  assert.ok(seenArgs.includes('approval_policy="never"'));
  assert.ok(seenArgs.includes('approvals_reviewer="user"'));
});

test('PermissionResolver bounds and terminates an unresponsive owned app-server tree', async () => {
  let child;
  const fixture = 'process.stdin.resume(); setInterval(()=>{},1000);';
  const resolver = new PermissionResolver('fake-codex', {
    timeoutMs: 50,
    resolveExecutable: () => ({ executable: 'fake-codex' }),
    spawnChild: (_command, _args, options) => {
      child = spawnDirect(process.execPath, ['-e', fixture], options);
      return child;
    },
  });
  await assert.rejects(resolver.resolve(process.cwd()), { code: 'PERMISSION_RESOLUTION_FAILED' });
  const deadline = Date.now() + 3000;
  while (child?.pid && isProcessAlive(child.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(child?.pid ? isProcessAlive(child.pid) : false, false);
});
