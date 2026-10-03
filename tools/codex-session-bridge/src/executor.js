import { spawnDirect, readLines, stopProcessTree } from './process.js';
import { BridgeError, redact } from './errors.js';
import { resolveCodexExecutable } from './codex-executable.js';
import { sessionPermissionSnapshot } from './permissions.js';

const legacyArguments = (run, session) => [
  '-a', 'never', 'exec', '--json', '--ignore-user-config',
  '-s', 'read-only', '-C', session.cwd,
  '-m', run.model, '-c', `model_reasoning_effort=${JSON.stringify(run.reasoning)}`,
  '-c', `service_tier=${JSON.stringify(run.service_tier ?? 'default')}`,
  '-c', 'web_search="disabled"',
  '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
  '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
];

const status = value => ({
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  declined: 'declined',
})[value] ?? value;

const snakeItemType = value => ({
  agentMessage: 'agent_message',
  commandExecution: 'command_execution',
  mcpToolCall: 'mcp_tool_call',
})[value] ?? value;

const normalizeItem = (item, fallbackStatus) => {
  if (!item || typeof item !== 'object') return item;
  const normalized = { ...item, type: snakeItemType(item.type) };
  if (item.type === 'commandExecution') {
    normalized.aggregated_output = item.aggregatedOutput ?? '';
    normalized.exit_code = item.exitCode ?? null;
    normalized.status = status(item.status ?? fallbackStatus);
  } else if (item.type === 'mcpToolCall') {
    normalized.status = status(item.status ?? fallbackStatus);
    if (item.error && !item.result) normalized.result = { error: item.error };
  } else if (fallbackStatus && normalized.status === undefined) normalized.status = fallbackStatus;
  return normalized;
};

const usage = tokenUsage => {
  const value = tokenUsage?.last ?? tokenUsage?.total;
  if (!value) return null;
  return {
    input_tokens: value.inputTokens ?? 0,
    cached_input_tokens: value.cachedInputTokens ?? 0,
    cache_write_input_tokens: value.cacheWriteInputTokens ?? 0,
    output_tokens: value.outputTokens ?? 0,
    reasoning_output_tokens: value.reasoningOutputTokens ?? 0,
  };
};

const workspaceConfig = permissions => permissions.sandbox_mode === 'workspace-write'
  ? { sandbox_workspace_write: {
      writable_roots: permissions.workspace_write.writable_roots,
      network_access: permissions.workspace_write.network_access,
      exclude_slash_tmp: permissions.workspace_write.exclude_slash_tmp,
      exclude_tmpdir_env_var: permissions.workspace_write.exclude_tmpdir_env_var,
    } }
  : undefined;

export function appServerThreadParams(run, session) {
  const permissions = sessionPermissionSnapshot(session);
  if (permissions.kind !== 'native') {
    throw new BridgeError('NATIVE_PERMISSION_REQUIRED', 'App-server execution requires a native permission snapshot.');
  }
  return {
    cwd: session.cwd,
    model: run.model,
    approvalPolicy: permissions.approval_policy,
    approvalsReviewer: permissions.approvals_reviewer,
    sandbox: permissions.sandbox_mode,
    serviceTier: run.service_tier ?? 'default',
    ...(workspaceConfig(permissions) ? { config: workspaceConfig(permissions) } : {}),
  };
}

export function appServerTurnParams(run, session, prompt, threadId) {
  const permissions = sessionPermissionSnapshot(session);
  if (permissions.kind !== 'native') {
    throw new BridgeError('NATIVE_PERMISSION_REQUIRED', 'App-server execution requires a native permission snapshot.');
  }
  return {
    threadId,
    input: [{ type: 'text', text: prompt }],
    cwd: session.cwd,
    model: run.model,
    effort: run.reasoning,
    approvalPolicy: permissions.approval_policy,
    approvalsReviewer: permissions.approvals_reviewer,
    serviceTierForTurn: run.service_tier ?? 'default',
  };
}

export function execArguments(run, session) {
  const permissions = sessionPermissionSnapshot(session);
  if (permissions.kind !== 'legacy') {
    throw new BridgeError('NATIVE_EXEC_REQUIRES_APP_SERVER', 'Native permission sessions must use the Codex app-server executor.');
  }
  const args = legacyArguments(run, session);
  if (session.codex_thread_id) args.push('resume', session.codex_thread_id);
  args.push('-');
  return args;
}

export class CodexExecutor {
  constructor(executable = 'codex', spawnChild = spawnDirect, resolveExecutable = resolveCodexExecutable) {
    this.executable = executable;
    this.spawnChild = spawnChild;
    this.resolveExecutable = resolveExecutable;
  }

  start(run, session, prompt, callbacks) {
    const permissions = sessionPermissionSnapshot(session);
    return permissions.kind === 'native'
      ? this.startAppServer(run, session, prompt, callbacks)
      : this.startLegacy(run, session, prompt, callbacks);
  }

  startLegacy(run, session, prompt, { onEvent, onStderr, onSpawn, onDone }) {
    const env = { ...process.env };
    // A bridge-created session must not impersonate the parent Codex task.
    delete env.CODEX_THREAD_ID;
    const { executable } = this.resolveExecutable(this.executable);
    const child = this.spawnChild(executable, execArguments(run, session), {
      cwd: session.cwd, env, detached: process.platform !== 'win32',
    });
    let failure = null;
    let stopped = false;
    const stop = async () => { stopped = true; await stopProcessTree(child); };
    const fail = error => {
      failure ??= error;
      stop().catch(() => {});
    };
    readLines(child.stdout, line => {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event.type !== 'string') throw new Error('Missing event type');
        onEvent(event);
      } catch (error) {
        fail(error instanceof BridgeError ? error : new BridgeError('INVALID_CODEX_OUTPUT', 'Codex stdout was not a valid JSONL event.'));
      }
    }, fail);
    readLines(child.stderr, line => onStderr(redact(line)), fail);
    child.once('spawn', () => {
      onSpawn(child.pid);
      // Prompt is data, including $, backticks, quotes, CRLF, and Windows paths.
      child.stdin.end(prompt, 'utf8');
    });
    child.stdin.on('error', error => {
      if (!stopped) failure ??= new BridgeError('STDIN_FAILED', redact(error.message));
    });
    child.on('error', error => {
      failure ??= new BridgeError('SPAWN_FAILED', 'Codex launch failed after executable discovery; check the installation and session cwd.',
        { spawn_code: ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC'].includes(error.code) ? error.code : 'UNKNOWN' });
    });
    child.once('close', (code, signal) => onDone({ code, signal, error: failure }));
    return { stop, child };
  }

  startAppServer(run, session, prompt, { onEvent, onStderr, onSpawn, onDone }) {
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    const { executable } = this.resolveExecutable(this.executable);
    const child = this.spawnChild(executable, ['app-server', '--stdio'], {
      cwd: session.cwd, env, detached: process.platform !== 'win32',
    });
    let nextId = 1;
    let turnId = null;
    let finalized = false;
    let lastUsage = null;
    let emittedThread = null;
    const pending = new Map();

    const send = message => {
      if (child.stdin.destroyed) throw new BridgeError('STDIN_FAILED', 'Codex app-server stdin is closed.');
      child.stdin.write(JSON.stringify(message) + '\n');
    };
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError('APP_SERVER_TIMEOUT', `Codex app-server did not answer ${method} in time.`));
      }, 30_000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      send({ id, method, params });
    });
    const settlePending = error => {
      for (const value of pending.values()) value.reject(error);
      pending.clear();
    };
    const complete = async result => {
      if (finalized) return;
      finalized = true;
      settlePending(new BridgeError('APP_SERVER_CLOSED', 'Codex app-server closed.'));
      try {
        if (child.exitCode === null && child.signalCode === null) await stopProcessTree(child);
      } catch {}
      onDone(result);
    };
    const fail = error => {
      const value = error instanceof BridgeError
        ? error
        : new BridgeError('INVALID_CODEX_OUTPUT', 'Codex app-server returned invalid protocol data.');
      complete({ code: 1, signal: null, error: value }).catch(() => {});
    };
    const emit = event => {
      try { onEvent(event); } catch (error) { fail(error); }
    };
    const emitThread = threadId => {
      if (emittedThread === threadId) return;
      emittedThread = threadId;
      emit({ type: 'thread.started', thread_id: threadId });
    };
    const declineApproval = message => {
      emit({ type: 'approval.declined', method: message.method, reason: 'interactive-approval-unavailable' });
      if (message.method === 'item/permissions/requestApproval') {
        send({ id: message.id, error: { code: -32001, message: 'Interactive permission grants are unavailable in this YER runtime.' } });
      } else if (['applyPatchApproval', 'execCommandApproval'].includes(message.method)) {
        send({ id: message.id, result: { decision: { denied: { rejection: 'Interactive approval is unavailable in this YER runtime.' } } } });
      } else {
        send({ id: message.id, result: { decision: 'decline' } });
      }
    };
    const notification = message => {
      const params = message.params ?? {};
      if (message.method === 'thread/started') return emitThread(params.thread?.id);
      if (message.method === 'turn/started') {
        turnId = params.turn?.id ?? turnId;
        emit({ type: 'turn.started' });
        return;
      }
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const fallback = message.method === 'item/started' ? 'in_progress' : 'completed';
        emit({ type: message.method.replace('/', '.'), item: normalizeItem(params.item, fallback) });
        return;
      }
      if (message.method === 'thread/tokenUsage/updated') {
        lastUsage = usage(params.tokenUsage) ?? lastUsage;
        return;
      }
      if (message.method === 'turn/completed') {
        const value = params.turn ?? {};
        if (value.status === 'completed') {
          emit({ type: 'turn.completed', ...(lastUsage ? { usage: lastUsage } : {}) });
        } else {
          emit({ type: 'turn.failed', error: { message: redact(value.error?.message ?? `Codex turn ended with status ${value.status ?? 'unknown'}.`) } });
        }
        complete({ code: value.status === 'completed' ? 0 : 1, signal: null, error: null }).catch(() => {});
        return;
      }
      if (message.method === 'error') {
        emit({ type: 'error', message: redact(params.message ?? 'Codex app-server error.') });
      }
    };

    readLines(child.stdout, line => {
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object') throw new Error('invalid message');
        if (message.id !== undefined && message.method) {
          if (/requestApproval$/.test(message.method) || ['applyPatchApproval', 'execCommandApproval'].includes(message.method)) {
            declineApproval(message);
          } else {
            send({ id: message.id, error: { code: -32601, message: 'Unsupported app-server request.' } });
          }
          return;
        }
        if (message.id !== undefined) {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          if (message.error) {
            entry.reject(new BridgeError('APP_SERVER_REQUEST_FAILED', redact(message.error.message ?? 'Codex app-server request failed.')));
          } else {
            entry.resolve(message.result);
          }
          return;
        }
        if (typeof message.method === 'string') notification(message);
      } catch (error) { fail(error); }
    }, fail);
    readLines(child.stderr, line => onStderr(redact(line)), fail);
    child.stdin.on('error', error => {
      if (!finalized) fail(new BridgeError('STDIN_FAILED', redact(error.message)));
    });
    child.on('error', error => {
      if (!finalized) {
        fail(new BridgeError('SPAWN_FAILED', 'Codex app-server failed to start after executable discovery.',
          { spawn_code: ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC'].includes(error.code) ? error.code : 'UNKNOWN' }));
      }
    });
    child.once('close', (code, signal) => {
      if (!finalized) {
        complete({
          code: code ?? 1, signal,
          error: new BridgeError('APP_SERVER_EXITED', 'Codex app-server exited before turn completion.'),
        }).catch(() => {});
      }
    });
    child.once('spawn', () => {
      onSpawn(child.pid);
      (async () => {
        await request('initialize', { clientInfo: { name: 'yuki-codex-session-bridge', version: '0.1.0' } });
        const base = appServerThreadParams(run, session);
        const result = session.codex_thread_id
          ? await request('thread/resume', { threadId: session.codex_thread_id, excludeTurns: true, ...base })
          : await request('thread/start', base);
        const threadId = result?.thread?.id;
        if (typeof threadId !== 'string') {
          throw new BridgeError('INVALID_THREAD_ID', 'Codex app-server returned no thread ID.');
        }
        emitThread(threadId);
        const turn = await request('turn/start', appServerTurnParams(run, session, prompt, threadId));
        turnId = turn?.turn?.id ?? turnId;
      })().catch(fail);
    });

    const stop = async () => {
      if (finalized) return;
      if (turnId && (emittedThread ?? session.codex_thread_id)) {
        try {
          await request('turn/interrupt', { threadId: emittedThread ?? session.codex_thread_id, turnId });
        } catch {}
      }
      try {
        await stopProcessTree(child);
      } finally {
        if (!finalized) {
          finalized = true;
          settlePending(new BridgeError('APP_SERVER_CLOSED', 'Codex app-server stopped.'));
          onDone({ code: 1, signal: 'STOP', error: null });
        }
      }
    };
    return { stop, child };
  }
}
