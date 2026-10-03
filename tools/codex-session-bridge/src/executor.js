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

const usage = value => {
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
  constructor(executable = 'codex', spawnChild = spawnDirect, resolveExecutable = resolveCodexExecutable, stopTree = stopProcessTree) {
    this.executable = executable;
    this.spawnChild = spawnChild;
    this.resolveExecutable = resolveExecutable;
    this.stopTree = stopTree;
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

  startAppServer(run, session, prompt, { onEvent, onStderr, onSpawn, onDone, onStopping, onStopFailed }) {
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    const { executable } = this.resolveExecutable(this.executable);
    const child = this.spawnChild(executable, ['app-server', '--stdio'], {
      cwd: session.cwd, env, detached: process.platform !== 'win32',
    });
    let nextId = 1;
    let turnId = null;
    let finalized = false;
    let runUsage = null;
    let usageBaseline = session.codex_thread_id ? null : usage({});
    let emittedThread = null;
    let terminalResult = null;
    let closed = false;
    let terminating = false;
    let shutdownPromise = null;
    let resolveClosed;
    const whenClosed = new Promise(resolve => { resolveClosed = resolve; });
    const pending = new Map();

    const ensureActive = () => {
      if (terminalResult || closed) throw new BridgeError('APP_SERVER_CLOSED', 'Codex app-server is stopping or closed.');
    };
    const send = message => {
      if (child.stdin.destroyed) throw new BridgeError('STDIN_FAILED', 'Codex app-server stdin is closed.');
      child.stdin.write(JSON.stringify(message) + '\n');
    };
    const request = (method, params, duringStop = false) => new Promise((resolve, reject) => {
      if (!duringStop) ensureActive();
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError('APP_SERVER_TIMEOUT', `Codex app-server did not answer ${method} in time.`));
      }, 30_000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { send({ id, method, params }); }
      catch (error) { pending.get(id).reject(error); pending.delete(id); }
    });
    const settlePending = error => {
      for (const value of pending.values()) value.reject(error);
      pending.clear();
    };
    const finish = () => {
      // ChildProcess close follows exit AND stdio drain. A tree-stop command
      // may still be pending when close arrives, so both facts are required.
      if (finalized || !closed || terminating) return;
      finalized = true;
      onDone(terminalResult);
    };
    const rememberError = error => {
      terminalResult.error ??= error;
      terminalResult.code = 1;
    };
    const beginStopping = result => {
      if (terminalResult) return;
      terminalResult = result;
      settlePending(new BridgeError('APP_SERVER_CLOSED', 'Codex app-server is stopping.'));
      try { onStopping?.(); } catch (error) { rememberError(error); }
    };
    const complete = (result, interrupt = false) => {
      if (finalized) return Promise.resolve();
      beginStopping(result);
      if (shutdownPromise) return shutdownPromise;
      terminating = true;
      shutdownPromise = (async () => {
        try {
          if (interrupt && turnId && emittedThread && !closed) {
            try { await request('turn/interrupt', { threadId: emittedThread, turnId }, true); } catch {}
          }
          if (!closed && child.exitCode === null && child.signalCode === null) await this.stopTree(child);
        } catch (error) {
          const failure = error instanceof BridgeError ? error : new BridgeError('STOP_FAILED', redact(error.message));
          rememberError(failure);
          try { onStopFailed?.(failure); } catch (callbackError) { rememberError(callbackError); }
          throw failure;
        } finally {
          terminating = false;
          finish();
        }
        await whenClosed;
        finish();
      })().finally(() => { shutdownPromise = null; });
      return shutdownPromise;
    };
    const fail = error => {
      const value = error instanceof BridgeError
        ? error
        : new BridgeError('INVALID_CODEX_OUTPUT', 'Codex app-server returned invalid protocol data.');
      if (finalized) return;
      if (terminalResult) {
        if (value.code !== 'APP_SERVER_CLOSED') rememberError(value);
        return;
      }
      complete({ code: 1, signal: null, error: value }).catch(() => {});
    };
    const emit = event => onEvent(event);
    const emitThread = threadId => {
      ensureActive();
      if (emittedThread === threadId) return;
      // The manager must accept AND persist this identity before any turn RPC.
      emit({ type: 'thread.started', thread_id: threadId });
      ensureActive();
      emittedThread = threadId;
    };
    const updateUsage = params => {
      if (params.threadId !== (emittedThread ?? session.codex_thread_id)) return;
      const total = usage(params.tokenUsage?.total);
      if (!total) return;
      if (!turnId || params.turnId !== turnId) {
        // Cold resume can replay the previous turn's absolute totals.
        if (session.codex_thread_id && !runUsage) usageBaseline = total;
        return;
      }
      if (!usageBaseline) {
        const last = usage(params.tokenUsage?.last);
        if (!last) return; // Unknown history is not this run's bill.
        usageBaseline = Object.fromEntries(Object.keys(total).map(key => [key, Math.max(0, total[key] - last[key])]));
      }
      runUsage = Object.fromEntries(Object.keys(total).map(key =>
        [key, Math.max(runUsage?.[key] ?? 0, total[key] - usageBaseline[key])]));
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
      // Preserve trailing item output, but never restart protocol activity while
      // stopping or let a late completion overwrite an earlier failure/stop.
      if (terminalResult && !['item/started', 'item/completed'].includes(message.method)) return;
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
        updateUsage(params);
        return;
      }
      if (message.method === 'turn/completed') {
        const value = params.turn ?? {};
        if (value.status === 'completed') {
          emit({ type: 'turn.completed', ...(runUsage ? { usage: runUsage } : {}) });
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
          if (terminalResult) return;
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
      if (!terminalResult) fail(new BridgeError('STDIN_FAILED', redact(error.message)));
    });
    child.on('error', error => {
      if (!finalized) {
        fail(new BridgeError('SPAWN_FAILED', 'Codex app-server failed to start after executable discovery.',
          { spawn_code: ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC'].includes(error.code) ? error.code : 'UNKNOWN' }));
      }
    });
    child.once('close', (code, signal) => {
      closed = true;
      terminalResult ??= {
        code: code ?? 1, signal,
        error: new BridgeError('APP_SERVER_EXITED', 'Codex app-server exited before turn completion.'),
      };
      settlePending(new BridgeError('APP_SERVER_CLOSED', 'Codex app-server closed.'));
      resolveClosed();
      finish();
    });
    child.once('spawn', () => {
      (async () => {
        onSpawn(child.pid);
        ensureActive();
        await request('initialize', { clientInfo: { name: 'yuki-codex-session-bridge', version: '0.1.0' } });
        ensureActive();
        const base = appServerThreadParams(run, session);
        const result = session.codex_thread_id
          ? await request('thread/resume', { threadId: session.codex_thread_id, excludeTurns: true, ...base })
          : await request('thread/start', base);
        ensureActive();
        const threadId = result?.thread?.id;
        if (typeof threadId !== 'string') {
          throw new BridgeError('INVALID_THREAD_ID', 'Codex app-server returned no thread ID.');
        }
        emitThread(threadId);
        const turn = await request('turn/start', appServerTurnParams(run, session, prompt, threadId));
        ensureActive();
        turnId = turn?.turn?.id ?? turnId;
      })().catch(fail);
    });

    const stop = () => complete({ code: 1, signal: 'STOP', error: null }, true);
    return { stop, child };
  }
}
