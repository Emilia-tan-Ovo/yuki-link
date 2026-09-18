import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { spawnDirect } from '../src/process.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ModelCatalog } from '../src/catalog.js';
import { RuntimeStore } from '../src/store.js';
import { CodexExecutor } from '../src/executor.js';
import { PermissionResolver } from '../src/permissions.js';
import { SessionManager } from '../src/manager.js';
import { createHttpServer } from '../src/http.js';

const toolRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(toolRoot, 'runtime', `permissions-live-${Date.now()}`);
const cwd = path.join(runtime, 'workspace');
mkdirSync(cwd, { recursive: true });
const marker = 'YCA006-' + randomUUID().slice(0, 8);
const sourceText = 'SOURCE-' + randomUUID().slice(0, 8);
writeFileSync(path.join(cwd, 'source.txt'), sourceText + '\n', 'utf8');
writeFileSync(path.join(cwd, 'proof.txt'), 'INITIAL\n', 'utf8');
writeFileSync(path.join(cwd, 'read-only-proof.txt'), 'LOCKED\n', 'utf8');
writeFileSync(path.join(cwd, 'freeze-proof.txt'), 'BEFORE\n', 'utf8');

function git(args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
git(['init', '-q']);
git(['config', 'user.name', 'YCA Acceptance']);
git(['config', 'user.email', 'yca-acceptance@example.invalid']);
git(['add', 'source.txt', 'proof.txt', 'read-only-proof.txt', 'freeze-proof.txt']);
git(['commit', '-qm', 'acceptance baseline']);

const codex = process.env.BRIDGE_CODEX_BIN ?? 'codex';
const catalog = new ModelCatalog(codex);
await catalog.validate('gpt-5.6-sol', 'medium');

const resolverHome = path.join(runtime, 'resolver-home');
mkdirSync(resolverHome, { recursive: true });
const resolverConfig = path.join(resolverHome, 'config.toml');
const writeResolverDefault = (sandboxMode, approvalPolicy) => writeFileSync(
  resolverConfig,
  `sandbox_mode = ${JSON.stringify(sandboxMode)}\napproval_policy = ${JSON.stringify(approvalPolicy)}\n`,
  'utf8',
);
writeResolverDefault('danger-full-access', 'on-request');
const permissionResolver = new PermissionResolver(codex, {
  spawnChild: (command, args, options) => spawnDirect(command, args, {
    ...options,
    env: { ...process.env, ...(options?.env ?? {}), CODEX_HOME: resolverHome },
  }),
});
const initialDefault = await permissionResolver.resolve(cwd);
assert.equal(initialDefault.sandbox_mode, 'danger-full-access');
assert.equal(initialDefault.approval_policy, 'on-request');

const manager = new SessionManager({
  store: new RuntimeStore(runtime),
  catalog,
  executor: new CodexExecutor(codex),
  permissionResolver,
  allowedCwds: [cwd],
});
const httpServer = createHttpServer(manager);
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
const client = new Client({ name: 'yca-006-permission-live', version: '0.1.0' });
const report = { runtime, cwd, marker, started_at: new Date().toISOString(), runs: [] };

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.ok(!result.isError, JSON.stringify(value));
  return value;
}

async function wait(run) {
  const events = [];
  let cursor = 0;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const output = await call('codex_get_output', { run_id: run.run_id, cursor, limit: 200 });
    events.push(...output.events);
    cursor = output.next_cursor;
    const state = await call('codex_get_status', { run_id: run.run_id });
    if (!['queued', 'running', 'stopping'].includes(state.run.status)) {
      assert.equal(state.run.status, 'completed', JSON.stringify(state.run.error));
      report.runs.push({ session: state.session, run: state.run, event_count: events.length });
      return { state, events };
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error('Permission live acceptance timed out.');
}

function commandEvidence(events) {
  return events.some(event => event.type === 'codex' && event.data?.item?.type === 'command_execution');
}

function blockedWriteEvidence(events) {
  return events.some(event => {
    if (event.type !== 'codex' || event.data?.item?.type !== 'command_execution') return false;
    const item = event.data.item;
    const command = item.command ?? '';
    const output = item.aggregated_output ?? '';
    return /read-only-proof\.txt/i.test(command)
      && item.status === 'failed'
      && item.exit_code !== 0
      && /blocked by policy|read[- ]only|permission denied|access to the path .* is denied/i.test(output);
  });
}

try {
  await client.connect(new StreamableHTTPClientTransport(url));

  const defaultSession = await call('codex_start_session', {
    request_id: randomUUID(),
    cwd,
    sender: 'YCA acceptance',
    model: 'gpt-5.6-sol',
    reasoning: 'medium',
    prompt: [
      'Controlled YCA-006 permission acceptance. Work only inside the current temporary git repository.',
      '1. Read source.txt; do not assume its content from this prompt.',
      `2. Replace proof.txt so its first line is exactly ${marker} and second line is SOURCE=<the exact trimmed source.txt content>.`,
      '3. Use a shell command (not a second file-edit action) to append a new line containing exactly CMD_OK to proof.txt.',
      '4. Run git diff -- proof.txt and inspect it.',
      '5. Reply with only WRITE_COMMAND_DIFF_OK after all steps succeed.',
    ].join('\n'),
    timeout_ms: 240000,
  });
  assert.equal(defaultSession.permissions.kind, 'native');
  assert.equal(defaultSession.permissions.sandbox_mode, initialDefault.sandbox_mode);
  assert.equal(defaultSession.permissions.approval_policy, initialDefault.approval_policy);
  const defaultResult = await wait(defaultSession);
  assert.equal(defaultResult.state.session.codex_thread_id.length, 36);
  const proof = readFileSync(path.join(cwd, 'proof.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(proof, `${marker}\nSOURCE=${sourceText}\nCMD_OK\n`);
  const diff = git(['diff', '--', 'proof.txt']);
  assert.ok(diff.includes(marker));
  assert.ok(diff.includes('CMD_OK'));
  assert.ok(commandEvidence(defaultResult.events), 'Codex JSONL did not contain command_execution evidence.');

  // Change the controlled native default after the session exists. This must
  // affect future resolution while the existing session keeps its frozen snapshot.
  writeResolverDefault('read-only', 'never');
  const changedDefault = await permissionResolver.resolve(cwd);
  assert.equal(changedDefault.sandbox_mode, 'read-only');
  assert.equal(changedDefault.approval_policy, 'never');

  const freezeProof = path.join(cwd, 'freeze-proof.txt');
  const resumed = await call('codex_send_message', {
    request_id: randomUUID(),
    session_id: defaultSession.session_id,
    sender: 'YCA acceptance',
    prompt: 'The configured default changed after this session was created. Preserve this session permission snapshot. Use a shell command to append exactly FROZEN_SESSION_OK to freeze-proof.txt, then read proof.txt. Reply exactly: RESUME_FROZEN_OK <first-line-marker> <whether CMD_OK is present as YES or NO>.',
    timeout_ms: 180000,
  });
  assert.equal(resumed.permissions.sandbox_mode, initialDefault.sandbox_mode);
  assert.equal(resumed.permissions.approval_policy, initialDefault.approval_policy);
  const resumeResult = await wait(resumed);
  assert.equal(resumeResult.state.session.codex_thread_id, defaultResult.state.session.codex_thread_id);
  assert.ok(resumeResult.state.run.final_response.includes('RESUME_FROZEN_OK'));
  assert.ok(resumeResult.state.run.final_response.includes(marker));
  assert.ok(resumeResult.state.run.final_response.includes('YES'));
  assert.equal(readFileSync(path.join(cwd, 'proof.txt'), 'utf8').replace(/\r\n/g, '\n'), proof);
  assert.equal(readFileSync(freezeProof, 'utf8').replace(/\r\n/g, '\n'), 'BEFORE\nFROZEN_SESSION_OK\n');

  const beforeReadOnly = readFileSync(path.join(cwd, 'proof.txt'), 'utf8');
  const readOnlyProof = path.join(cwd, 'read-only-proof.txt');
  const beforeBlockedWrite = readFileSync(readOnlyProof, 'utf8');
  const readOnly = await call('codex_start_session', {
    request_id: randomUUID(),
    cwd,
    sender: 'YCA acceptance',
    model: 'gpt-5.6-sol',
    reasoning: 'medium',
    permissions: { sandbox_mode: 'read-only', approval_policy: 'never' },
    prompt: 'Controlled read-only enforcement test. First, you MUST attempt exactly one shell write that replaces read-only-proof.txt with SHOULD_NOT_WRITE; this write is expected to be denied by the read-only sandbox, so do not work around the denial. After observing the denial, read source.txt and run git status --short. Reply exactly: READ_ONLY_BLOCKED_OK <trimmed source.txt content>.',
    timeout_ms: 180000,
  });
  assert.equal(readOnly.permissions.sandbox_mode, 'read-only');
  assert.equal(readOnly.permissions.approval_policy, 'never');
  const readOnlyResult = await wait(readOnly);
  assert.ok(readOnlyResult.state.run.final_response.includes('READ_ONLY_BLOCKED_OK'));
  assert.ok(readOnlyResult.state.run.final_response.includes(sourceText));
  assert.ok(commandEvidence(readOnlyResult.events), 'Read-only run did not contain command_execution evidence.');
  assert.ok(blockedWriteEvidence(readOnlyResult.events), 'Read-only run did not contain observable write-denial evidence.');
  assert.equal(readFileSync(path.join(cwd, 'proof.txt'), 'utf8'), beforeReadOnly);
  assert.equal(readFileSync(readOnlyProof, 'utf8'), beforeBlockedWrite);

  report.default_permissions = defaultSession.permissions;
  report.controlled_default_before = initialDefault;
  report.controlled_default_after = changedDefault;
  report.explicit_permissions = readOnly.permissions;
  report.thread_resumed = resumeResult.state.session.codex_thread_id === defaultResult.state.session.codex_thread_id;
  report.external = { proof, diff, frozen_session_write: true, read_only_unchanged: true, read_only_write_blocked: true };
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? error.message;
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(path.join(runtime, 'acceptance.json'), JSON.stringify(report, null, 2), 'utf8');
  await client.close().catch(() => {});
  await manager.close().catch(() => {});
  await new Promise(resolve => {
    httpServer.close(resolve);
    httpServer.closeAllConnections();
  });
  console.log(JSON.stringify({ passed: report.passed, report: path.join(runtime, 'acceptance.json') }));
}
