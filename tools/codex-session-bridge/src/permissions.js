import { spawnDirect, readLines, stopProcessTree } from './process.js';
import { BridgeError } from './errors.js';
import { resolveCodexExecutable } from './codex-executable.js';

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const APPROVAL_POLICIES = new Set(['on-request', 'never']);
const APPROVAL_REVIEWERS = new Set(['user', 'auto_review', 'guardian_subagent']);
const SELECTION_KEYS = new Set(['sandbox_mode', 'approval_policy', 'approvals_reviewer']);

const legacySnapshot = () => ({
  version: 1,
  kind: 'legacy',
  stored: false,
  sandbox_mode: 'read-only',
  approval_policy: 'never',
  source: 'legacy_bridge_v0',
  resolved_at: null,
});

function invalid(code, message, details = {}) {
  throw new BridgeError(code, message, details);
}

export function validatePermissionSelection(selection) {
  if (selection === undefined) return null;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) invalid('INVALID_PERMISSION_CONFIG', 'permissions must be an object when provided.');
  for (const key of Object.keys(selection)) if (!SELECTION_KEYS.has(key)) invalid('INVALID_PERMISSION_CONFIG', 'permissions contains an unsupported field.', { field: key });
  if (!SANDBOX_MODES.has(selection.sandbox_mode)) invalid('INVALID_PERMISSION_CONFIG', 'permissions.sandbox_mode is not supported by this Codex bridge.', { sandbox_mode: selection.sandbox_mode });
  if (selection.approval_policy !== undefined && !APPROVAL_POLICIES.has(selection.approval_policy)) invalid('INVALID_PERMISSION_CONFIG', 'permissions.approval_policy is not replayable by the current Codex exec CLI.', { approval_policy: selection.approval_policy });
  if (selection.approvals_reviewer !== undefined && !APPROVAL_REVIEWERS.has(selection.approvals_reviewer)) invalid('INVALID_PERMISSION_CONFIG', 'permissions.approvals_reviewer is not supported.', { approvals_reviewer: selection.approvals_reviewer });
  return {
    sandbox_mode: selection.sandbox_mode,
    ...(selection.approval_policy !== undefined ? { approval_policy: selection.approval_policy } : {}),
    ...(selection.approvals_reviewer !== undefined ? { approvals_reviewer: selection.approvals_reviewer } : {}),
  };
}

export function permissionSelectionFingerprint(selection) {
  const value = validatePermissionSelection(selection);
  return value === null ? null : [value.sandbox_mode, value.approval_policy ?? null, value.approvals_reviewer ?? null];
}

const WORKSPACE_KEYS = new Set(['writable_roots', 'network_access', 'exclude_slash_tmp', 'exclude_tmpdir_env_var']);

function workspaceSnapshot(value, { stored = false } = {}) {
  const raw = value ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(stored ? 'SESSION_PERMISSION_INVALID' : 'UNSUPPORTED_PERMISSION_MODE', stored ? 'The saved workspace-write permission snapshot is damaged.' : 'Codex returned an unsupported workspace-write configuration.');
  for (const key of Object.keys(raw)) {
    if (!WORKSPACE_KEYS.has(key)) invalid(stored ? 'SESSION_PERMISSION_INVALID' : 'UNSUPPORTED_PERMISSION_MODE', stored ? 'The saved workspace-write permission snapshot contains an unknown field.' : 'Codex returned a workspace-write permission field that YCA cannot replay safely.', { field: key });
  }
  if (stored && [...WORKSPACE_KEYS].some(key => !Object.hasOwn(raw, key))) invalid('SESSION_PERMISSION_INVALID', 'The saved workspace-write permission snapshot is incomplete.');
  const writableRoots = raw.writable_roots ?? [];
  if (!Array.isArray(writableRoots) || writableRoots.some(item => typeof item !== 'string')) invalid(stored ? 'SESSION_PERMISSION_INVALID' : 'UNSUPPORTED_PERMISSION_MODE', stored ? 'The saved workspace-write writable roots are invalid.' : 'Codex returned invalid workspace-write writable roots.');
  for (const key of ['network_access', 'exclude_slash_tmp', 'exclude_tmpdir_env_var']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') invalid(stored ? 'SESSION_PERMISSION_INVALID' : 'UNSUPPORTED_PERMISSION_MODE', stored ? 'The saved workspace-write permission snapshot contains an invalid boolean setting.' : 'Codex returned an invalid workspace-write boolean setting.', { field: key });
  }
  return {
    writable_roots: [...writableRoots],
    network_access: raw.network_access ?? false,
    exclude_slash_tmp: raw.exclude_slash_tmp ?? false,
    exclude_tmpdir_env_var: raw.exclude_tmpdir_env_var ?? false,
  };
}

export function permissionSnapshotFromConfig(config, source = 'test') {
  if (!config || typeof config !== 'object' || Array.isArray(config)) invalid('PERMISSION_RESOLUTION_FAILED', 'Codex config/read returned no usable configuration.');
  if (config.default_permissions !== undefined && config.default_permissions !== null) invalid('UNSUPPORTED_PERMISSION_PROFILE', 'This Codex default_permissions profile cannot yet be frozen and replayed safely by YCA.', { default_permissions: String(config.default_permissions) });
  if (config.permissions !== undefined && config.permissions !== null) invalid('UNSUPPORTED_PERMISSION_PROFILE', 'Custom Codex permission profiles cannot yet be frozen and replayed safely by YCA.');

  const sandboxMode = config.sandbox_mode;
  const approvalPolicy = config.approval_policy;
  const approvalsReviewer = config.approvals_reviewer ?? 'user';
  if (!SANDBOX_MODES.has(sandboxMode)) invalid('UNSUPPORTED_PERMISSION_MODE', 'Codex resolved an unsupported sandbox mode.', { sandbox_mode: sandboxMode ?? null });
  if (!APPROVAL_POLICIES.has(approvalPolicy)) invalid('UNSUPPORTED_PERMISSION_MODE', 'Codex resolved an approval policy that current exec/resume cannot replay safely.', { approval_policy: typeof approvalPolicy === 'string' ? approvalPolicy : 'complex' });
  if (!APPROVAL_REVIEWERS.has(approvalsReviewer)) invalid('UNSUPPORTED_PERMISSION_MODE', 'Codex resolved an unsupported approvals reviewer.', { approvals_reviewer: approvalsReviewer });

  return {
    version: 1,
    kind: 'native',
    stored: true,
    sandbox_mode: sandboxMode,
    approval_policy: approvalPolicy,
    approvals_reviewer: approvalsReviewer,
    workspace_write: sandboxMode === 'workspace-write' ? workspaceSnapshot(config.sandbox_workspace_write) : null,
    source,
    resolved_at: new Date().toISOString(),
  };
}

const SNAPSHOT_KEYS = new Set([
  'version', 'kind', 'stored', 'sandbox_mode', 'approval_policy', 'approvals_reviewer',
  'workspace_write', 'source', 'resolved_at',
]);

export function sessionPermissionSnapshot(session) {
  if (!Object.hasOwn(session, 'permissions')) return legacySnapshot();
  const snapshot = session.permissions;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.version !== 1 || snapshot.kind !== 'native') {
    invalid('SESSION_PERMISSION_INVALID', 'The saved session permission snapshot is missing, damaged, or from an unsupported version.');
  }
  for (const key of Object.keys(snapshot)) {
    if (!SNAPSHOT_KEYS.has(key)) invalid('SESSION_PERMISSION_INVALID', 'The saved session permission snapshot contains an unknown field.', { field: key });
  }
  if ([...SNAPSHOT_KEYS].some(key => !Object.hasOwn(snapshot, key))
      || snapshot.stored !== true
      || typeof snapshot.source !== 'string' || !snapshot.source
      || typeof snapshot.resolved_at !== 'string' || !snapshot.resolved_at) {
    invalid('SESSION_PERMISSION_INVALID', 'The saved session permission snapshot is incomplete or malformed.');
  }
  if (!SANDBOX_MODES.has(snapshot.sandbox_mode) || !APPROVAL_POLICIES.has(snapshot.approval_policy) || !APPROVAL_REVIEWERS.has(snapshot.approvals_reviewer)) {
    invalid('SESSION_PERMISSION_INVALID', 'The saved session permission snapshot contains unsupported values.');
  }
  const normalized = structuredClone(snapshot);
  if (snapshot.sandbox_mode === 'workspace-write') normalized.workspace_write = workspaceSnapshot(snapshot.workspace_write, { stored: true });
  else {
    if (snapshot.workspace_write !== null) invalid('SESSION_PERMISSION_INVALID', 'A non-workspace session cannot carry workspace-write permission state.');
    normalized.workspace_write = null;
  }
  return normalized;
}

export class PermissionResolver {
  constructor(executable = 'codex', { timeoutMs = 10_000, resolveExecutable = resolveCodexExecutable, spawnChild = spawnDirect } = {}) {
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.resolveExecutable = resolveExecutable;
    this.spawnChild = spawnChild;
  }

  async resolve(cwd, selection) {
    const normalized = validatePermissionSelection(selection);
    const overrides = [];
    if (normalized) {
      overrides.push(['sandbox_mode', normalized.sandbox_mode]);
      if (normalized.approval_policy !== undefined) overrides.push(['approval_policy', normalized.approval_policy]);
      if (normalized.approvals_reviewer !== undefined) overrides.push(['approvals_reviewer', normalized.approvals_reviewer]);
    }
    const config = await this.readConfig(cwd, overrides);
    return permissionSnapshotFromConfig(config, normalized ? 'explicit_codex_config' : 'local_codex_config');
  }

  async readConfig(cwd, overrides = []) {
    let executable;
    try { executable = this.resolveExecutable(this.executable).executable; }
    catch (error) { throw new BridgeError('PERMISSION_RESOLUTION_FAILED', error.message, error.details); }

    const args = ['app-server', '--stdio'];
    for (const [key, value] of overrides) args.push('-c', `${key}=${JSON.stringify(value)}`);
    const child = this.spawnChild(executable, args, { cwd });
    const pending = new Map();
    let nextId = 1;
    let finished = false;
    const fail = error => {
      const failure = error instanceof BridgeError ? error : new BridgeError('PERMISSION_RESOLUTION_FAILED', 'Codex permission discovery failed.');
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
    };
    child.on('error', error => fail(new BridgeError('PERMISSION_RESOLUTION_FAILED', 'Cannot start the local Codex permission resolver.', { spawn_code: ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC'].includes(error.code) ? error.code : 'UNKNOWN' })));
    child.on('exit', () => { if (!finished) fail(new BridgeError('PERMISSION_RESOLUTION_FAILED', 'Codex permission resolver exited early.')); });
    child.stderr.resume();
    child.stdin.on('error', () => fail(new BridgeError('PERMISSION_RESOLUTION_FAILED', 'Codex permission resolver pipe closed.')));
    readLines(child.stdout, line => {
      try {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new BridgeError('PERMISSION_RESOLUTION_FAILED', 'Codex rejected a permission configuration request.'));
        else request.resolve(message.result);
      } catch { fail(new BridgeError('PERMISSION_RESOLUTION_FAILED', 'Invalid Codex permission resolver JSON.')); }
    }, fail);
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const timer = setTimeout(() => {
      fail(new BridgeError('PERMISSION_RESOLUTION_FAILED', 'Codex permission resolution timed out.'));
    }, this.timeoutMs);

    try {
      await rpc('initialize', { clientInfo: { name: 'yuki_computer_agent_permissions', version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const response = await rpc('config/read', { cwd, includeLayers: false });
      return response?.config;
    } finally {
      finished = true;
      clearTimeout(timer);
      if (!child.stdin.destroyed) child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = await new Promise(resolve => {
          const onClose = () => { clearTimeout(waitTimer); resolve(true); };
          const waitTimer = setTimeout(() => { child.off('close', onClose); resolve(false); }, 500);
          child.once('close', onClose);
        });
        if (!exited && child.exitCode === null && child.signalCode === null) {
          try { await stopProcessTree(child); }
          catch { /* Resolution result/error stays primary; no owned child is silently reused. */ }
        }
      }
    }
  }
}
