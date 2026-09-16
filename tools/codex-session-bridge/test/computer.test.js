import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, linkSync, appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ComputerTools } from '../src/computer/tools.js';
import { createHttpServer } from '../src/http.js';
import { spawnSync } from 'node:child_process';
import { PathPolicy } from '../src/computer/paths.js';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, spawnDirect } from '../src/process.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

async function connect(t, computerOptions = {}, beforeClose = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-computer-'));
  const workspace = path.join(root, '工作区 空格'); mkdirSync(workspace);
  const readOnly = path.join(root, '只读'); mkdirSync(readOnly);
  const computer = new ComputerTools({ readRoots: [workspace, readOnly], writeRoots: [workspace], runtime: path.join(root, 'runtime'), ...computerOptions });
  const manager = { closing: false, catalog: { list() { throw Error('Codex unavailable'); } } };
  const server = createHttpServer(manager, computer);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'computer-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  t.after(async () => { await beforeClose(); await client.close(); await computer.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); rmSync(root, { recursive: true, force: true }); });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    let value = result.structuredContent;
    if (!value) { try { value = JSON.parse(result.content[0].text); } catch { value = { message: result.content[0].text }; } }
    return { ...value, isError: result.isError === true };
  };
  return { root, workspace, readOnly, call, client, computer, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

test('MCP directly queries PowerShell 7 even when Codex is unavailable', async t => {
  const { workspace, call } = await connect(t);
  const version = await call('powershell', { cwd: workspace, query: 'version' });
  assert.equal(version.isError, false);
  assert.equal(version.exit_code, 0);
  assert.match(version.data.version, /^7\./);
  const location = await call('powershell', { cwd: workspace, query: 'location' });
  assert.equal(location.isError, false);
  assert.equal(location.data.path, workspace);
  const bad = await call('powershell', { cwd: workspace, query: 'Remove-Item' });
  assert.equal(bad.isError, true);
});

// Faults that cannot be triggered reliably by real OS processes use the agreed
// subprocess seam; all assertions still observe public MCP results.
function processFixture(start) {
  const child = new EventEmitter();
  child.pid = 1234567; // Synthetic only; tests must supply a synthetic stop adapter.
  child.exitCode = null; child.signalCode = null;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.endProcess = (code = 0, close = true) => {
    child.exitCode = code;
    child.emit('exit', code, null);
    if (close) { child.stdout.end(); child.stderr.end(); child.emit('close', code, null); }
  };
  queueMicrotask(() => { child.emit('spawn'); start(child); });
  return child;
}

test('service shutdown retries retained live processes once with a bounded, truthful outcome', async t => {
  await Promise.all(['succeeded', 'failed', 'pending'].map(async outcome => {
    let child; let stops = 0;
    const { workspace, call, computer } = await connect(t, {
      spawnProcess: () => child = processFixture(p => p.stdout.write('PARTIAL')),
      stopProcess: async p => {
        stops++;
        if (stops === 1 || outcome === 'failed') throw new Error('injected stop failure');
        if (outcome === 'pending') return new Promise(() => {});
        p.endProcess(1); return 'succeeded';
      },
    }, () => { if (child.exitCode === null) child.endProcess(1); });
    const failed = await call('powershell_execute', { cwd: workspace, script: "'fixture'", timeout_ms: 1000 });
    assert.equal(failed.error.details.result.process_state, 'running');
    const snapshot = structuredClone(failed);
    const began = Date.now();
    if (outcome === 'succeeded') await computer.close();
    else await assert.rejects(computer.close(), error => error.code === 'STOP_FAILED');
    assert.equal(stops, 2, 'shutdown makes one new attempt for the retained process');
    assert.ok(Date.now() - began < 7000, 'shutdown has one separate 5-second budget');
    assert.deepEqual(failed, snapshot, 'the earlier response remains an immutable snapshot');
    assert.equal((await call('powershell_execute', { cwd: workspace, script: "'new'" })).error.code, 'SHUTTING_DOWN');
  }));
});

test('MCP bounds failed termination and retains the shared execution slot until actual exit', async t => {
  const children = [];
  const { workspace, call } = await connect(t, {
    spawnProcess: () => {
      const child = processFixture(p => p.stdout.write('PARTIAL'));
      children.push(child); return child;
    },
    stopProcess: async () => { throw new Error('injected stop failure'); },
  }, () => children.forEach(child => child.endProcess()));
  const began = Date.now();
  const failed = await call('powershell_execute', { cwd: workspace, script: "'fixture'", timeout_ms: 1000 });
  assert.equal(failed.error?.code, 'QUERY_TIMEOUT');
  assert.ok(Date.now() - began < 8000, 'one 5-second cleanup budget, with scheduling tolerance');
  assert.equal(failed.error.details.result.stdout, 'PARTIAL');
  assert.equal(failed.error.details.result.exit_code, null);
  assert.equal(failed.error.details.result.process_state, 'running');
  assert.equal(failed.error.details.result.termination.tree_kill, 'failed');
  const pending = Array.from({ length: 3 }, () => call('powershell', { cwd: workspace, query: 'version', timeout_ms: 1000 }));
  while (children.length < 4) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await call('powershell_execute', { cwd: workspace, script: "'new'" })).error.code, 'COMPUTER_BUSY');
  assert.equal((await call('powershell', { cwd: workspace, query: 'version' })).error.code, 'COMPUTER_BUSY');
  for (const child of children) child.endProcess(1);
  await Promise.all(pending);
  // A released slot can run again; close that synthetic process normally.
  const next = call('powershell_execute', { cwd: workspace, script: "'next'" });
  while (children.length < 5) await new Promise(resolve => setTimeout(resolve, 5));
  children[4].endProcess();
  assert.equal((await next).isError, false);
});

test('MCP distinguishes pre-execution audit failure from post-execution audit failure', async t => {
  for (const failAt of ['started', 'completed', 'failed']) await t.test(failAt, async t => {
    const { workspace, call } = await connect(t, { appendAudit: (file, line, options) => {
      if (JSON.parse(line).status === failAt) throw new Error('injected audit failure');
      appendFileSync(file, line, options);
    } });
    const response = await call('powershell_execute', { cwd: workspace,
      script: "Set-Content './audit-marker.txt' 'done'; [Console]::Out.Write('OUTPUT'); " + (failAt === 'failed' ? 'exit 7' : 'exit 0') });
    assert.equal(response.error?.code, failAt === 'failed' ? 'PROCESS_EXIT_FAILED' : 'AUDIT_FAILED');
    if (failAt === 'started') {
      assert.equal(existsSync(path.join(workspace, 'audit-marker.txt')), false);
      assert.equal(response.error.details.result, undefined);
    } else {
      assert.equal(existsSync(path.join(workspace, 'audit-marker.txt')), true);
      assert.equal(response.error.details.result.stdout, 'OUTPUT');
      assert.equal(response.error.details.result.exit_code, failAt === 'failed' ? 7 : 0);
      assert.equal(response.error.details.result.audit, 'failed');
    }
  });
});

test('MCP reports actual spawn failure without inventing an exit code', async t => {
  const { workspace, call } = await connect(t, {
    spawnProcess: (_exe, _args, options) => spawnDirect(path.join(options.cwd, 'nonexistent-executable.exe'), [], options),
  });
  const response = await call('powershell_execute', { cwd: workspace, script: "'unused'" });
  assert.equal(response.error.code, 'PROCESS_FAILED');
  assert.equal(response.error.details.result.process_state, 'not_started');
  assert.equal(response.error.details.result.completion_reason, 'spawn_error');
  assert.equal(response.error.details.result.exit_code, null);
  assert.equal(response.error.details.result.stdout, '');
});

test('query decoding failures retain the completed execution result', async t => {
  const { workspace, call } = await connect(t, {
    spawnProcess: () => processFixture(child => { child.stdout.write('not JSON'); child.endProcess(); }),
    stopProcess: async () => 'unconfirmed',
  });
  const response = await call('powershell', { cwd: workspace, query: 'version' });
  assert.equal(response.error.code, 'INVALID_QUERY_OUTPUT');
  assert.equal(response.error.details.result.stdout, 'not JSON');
  assert.equal(response.error.details.result.exit_code, 0);
});

test('MCP bounds pipe cleanup after root exit and reports incomplete output', async t => {
  const { workspace, call } = await connect(t, {
    spawnProcess: () => processFixture(child => { child.stdout.write('ROOT_DONE'); child.endProcess(0, false); }),
    stopProcess: async () => 'unconfirmed',
  });
  const began = Date.now();
  const response = await call('powershell_execute', { cwd: workspace, script: "'unused'" });
  assert.ok(Date.now() - began < 7000);
  assert.equal(response.error.code, 'STREAM_FAILED');
  const result = response.error.details.result;
  assert.equal(result.stdout, 'ROOT_DONE');
  assert.equal(result.process_state, 'exited');
  assert.equal(result.exit_code, 0);
  assert.equal(result.output.incomplete, true);
  assert.equal(result.termination.tree_kill, 'not_requested');
});

test('MCP never equates closed root pipes with an unconfirmed tree stop', async t => {
  const { workspace, call } = await connect(t, {
    spawnProcess: () => processFixture(child => child.stdout.write('BEFORE')),
    stopProcess: child => { child.endProcess(0); return new Promise(() => {}); },
  });
  const response = await call('powershell_execute', { cwd: workspace, script: "'unused'", timeout_ms: 1000 });
  const result = response.error.details.result;
  assert.equal(response.error.code, 'QUERY_TIMEOUT');
  assert.equal(result.stdout, 'BEFORE');
  assert.equal(result.process_state, 'exited');
  assert.equal(result.exit_code, 0, 'observed exit does not erase timeout');
  assert.equal(result.termination.tree_kill, 'unconfirmed');
});

test('MCP retains first-chunk prefixes, split UTF-8, exact budgets and stream errors', async t => {
  for (const mode of ['exact', 'oversized', 'stdin', 'stdout']) await t.test(mode, async t => {
    const { workspace, call } = await connect(t, {
      spawnProcess: () => processFixture(child => {
        if (mode === 'exact' || mode === 'oversized') {
          child.stderr.write(Buffer.from([0xe4, 0xb8])); child.stderr.write(Buffer.from([0xad]));
          child.stdout.write(Buffer.alloc(mode === 'exact' ? 1048573 : 1048676, 120));
          if (mode === 'exact') child.endProcess();
        } else {
          child.stdout.write('BEFORE_IO_FAILURE');
          child[mode].emit('error', new Error('injected pipe failure'));
        }
      }),
      stopProcess: async child => { child.endProcess(1); return 'succeeded'; },
    });
    const response = await call('powershell_execute', { cwd: workspace, script: "'unused'" });
    const result = response.isError ? response.error.details.result : response;
    if (mode === 'exact' || mode === 'oversized') {
      assert.equal(response.isError, mode === 'oversized');
      assert.equal(result.stderr, '中');
      assert.equal(result.stdout.length, 1048573);
      assert.equal(result.output.stdout_bytes + result.output.stderr_bytes, 1048576);
      assert.equal(result.output.stdout_truncated, mode === 'oversized');
    } else {
      assert.equal(response.error.code, mode === 'stdin' ? 'STDIN_FAILED' : 'STREAM_FAILED');
      assert.equal(result.stdout, 'BEFORE_IO_FAILURE');
      assert.equal(result.process_state, 'exited');
    }
  });
});

test('real stdio service executes scripts with an unavailable Codex executable', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-stdio-'));
  const workspace = path.join(root, '工作区 空格'); mkdirSync(workspace);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/main.js', import.meta.url)), '--transport', 'stdio',
      '--allow-cwd', workspace, '--runtime', path.join(root, 'runtime'), '--codex-bin', path.join(root, 'missing-codex.exe')],
    stderr: 'pipe',
  });
  transport.stderr.resume();
  const client = new Client({ name: 'script-stdio-test', version: '1' });
  t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 14);
  assert.equal((await client.callTool({ name: 'codex_list_models', arguments: {} })).isError, true);
  const result = await client.callTool({ name: 'powershell_execute', arguments: { cwd: workspace,
    script: "Set-Content -LiteralPath './stdio.txt' -Value '真实执行' -Encoding utf8 -NoNewline; [Console]::Out.Write((Get-Content './stdio.txt' -Raw -Encoding utf8))" } });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.stdout, '真实执行');
  assert.equal(readFileSync(path.join(workspace, 'stdio.txt'), 'utf8'), '真实执行');
  const version = await client.callTool({ name: 'powershell', arguments: { cwd: workspace, query: 'version' } });
  assert.match(version.structuredContent.data.version, /^7\./);
  t.diagnostic(`Isolated service PowerShell ${version.structuredContent.data.version}; Codex unavailable.`);
});

test('disconnecting a script request does not replay its side effects', async t => {
  const { workspace, call, url } = await connect(t);
  const file = path.join(workspace, 'once.txt');
  const controller = new AbortController();
  const request = fetch(url, {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'powershell_execute', arguments: {
      cwd: workspace, script: "Add-Content './once.txt' 'START' -Encoding utf8 -NoNewline; Start-Sleep -Milliseconds 1200; Add-Content './once.txt' 'END' -Encoding utf8 -NoNewline",
    } } }),
  }).then(response => response.text(), error => error.name);
  const deadline = Date.now() + 8000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(file), true, 'request actually started before disconnect');
  controller.abort();
  await request;
  while (!readFileSync(file, 'utf8').endsWith('END') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const read = await call('filesystem_read', { path: file });
  assert.equal(read.content, 'STARTEND');
  assert.equal((await call('powershell', { cwd: workspace, query: 'location' })).isError, false);
});

test('MCP executes a multiline PowerShell file round-trip independently of Codex', async t => {
  const { workspace, call, client } = await connect(t);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'powershell')?.annotations.readOnlyHint, true);
  assert.deepEqual(tools.find(tool => tool.name === 'powershell_execute')?.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  });
  const expected = '中文 "双引号" \'单引号\' $literal `tick` 🌸\n第二行';
  const create = await call('powershell_execute', { cwd: workspace, script: [
    "$text = @'", expected, "'@",
    "Set-Content -LiteralPath './中文 文件 [1].txt' -Value $text -Encoding utf8 -NoNewline",
    "[Console]::Out.Write((Get-Content -LiteralPath './中文 文件 [1].txt' -Raw -Encoding utf8))",
  ].join('\n') });
  assert.equal(create.isError, false);
  assert.equal(create.exit_code, 0);
  assert.equal(create.stdout, expected);
  assert.equal(readFileSync(path.join(workspace, '中文 文件 [1].txt'), 'utf8'), expected);
  const update = await call('powershell_execute', { cwd: workspace, script: [
    "Add-Content -LiteralPath './中文 文件 [1].txt' -Value '：已修改' -Encoding utf8 -NoNewline",
    "[Console]::Out.Write((Get-Content -LiteralPath './中文 文件 [1].txt' -Raw -Encoding utf8))",
  ].join('\r\n') });
  assert.equal(update.isError, false);
  assert.equal(update.stdout, expected + '：已修改');
  assert.equal(readFileSync(path.join(workspace, '中文 文件 [1].txt'), 'utf8'), expected + '：已修改');
});

test('MCP preserves both streams and the actual exit code on script failure', async t => {
  const { workspace, call, client } = await connect(t);
  const args = { cwd: workspace, script: "[Console]::Out.Write('输出'); [Console]::Error.Write('诊断'); exit 7" };
  const raw = await client.callTool({ name: 'powershell_execute', arguments: args });
  assert.equal(raw.isError, true);
  assert.deepEqual(JSON.parse(raw.content[0].text), raw.structuredContent);
  const { error } = raw.structuredContent;
  assert.equal(error.code, 'PROCESS_EXIT_FAILED');
  assert.equal(error.details.exit_code, 7);
  assert.equal(error.details.stderr, '诊断');
  assert.equal(error.details.result.stdout, '输出');
  assert.equal(error.details.result.stderr, '诊断');
  assert.equal(error.details.result.exit_code, 7);
  assert.equal(error.details.result.process_state, 'exited');
  assert.equal(error.details.result.completion_reason, 'exited');
  const success = await call('powershell_execute', { cwd: workspace, script: "[Console]::Error.Write('诊断'); '成功'" });
  assert.equal(success.isError, false);
  assert.equal(success.exit_code, 0);
  assert.equal(success.stderr, '诊断');
});

test('MCP returns partial output and confirmed owned-tree termination on timeout or output limit', async t => {
  const { workspace, call } = await connect(t);
  const timed = await call('powershell_execute', { cwd: workspace, timeout_ms: 2000,
    script: "[Console]::Out.Write('超时前'); [Console]::Error.Write('诊断'); Start-Sleep -Seconds 20" });
  assert.equal(timed.error.code, 'QUERY_TIMEOUT');
  const timeout = timed.error.details.result;
  assert.equal(timeout.stdout, '超时前');
  assert.equal(timeout.stderr, '诊断');
  assert.equal(timeout.completion_reason, 'timeout');
  assert.equal(timeout.process_state, 'exited');
  assert.equal(timeout.termination.requested, true);
  assert.equal(timeout.termination.tree_kill, 'succeeded');
  assert.equal(timeout.output.incomplete, true);
  assert.equal(timeout.output.stdout_truncated, false);
  const limited = await call('powershell_execute', { cwd: workspace,
    script: "[Console]::Out.Write('超限前'); [Console]::Out.Write('中' * 400000); Start-Sleep -Seconds 20" });
  assert.equal(limited.error.code, 'OUTPUT_LIMIT');
  const output = limited.error.details.result;
  assert.equal(output.completion_reason, 'output_limit');
  assert.ok(output.stdout.startsWith('超限前'));
  assert.ok(output.stdout.length > 300000);
  assert.equal(output.stdout.includes('\uFFFD'), false);
  assert.ok(output.output.stdout_bytes <= 1048576);
  assert.equal(output.output.stdout_truncated, true);
  assert.equal(output.output.incomplete, true);
  assert.equal(output.process_state, 'exited');
  assert.equal(output.termination.tree_kill, 'succeeded');
});

test('MCP enforces separate script input and UTF-8 byte limits before execution', async t => {
  const { root, workspace, call } = await connect(t);
  for (const input of [
    {}, { script: ' \r\n ' }, { script: '"should not execute"', query: 'version' },
    { script: '中'.repeat(43691) }, { script: 'x'.repeat(131073) },
    { script: "Set-Content './invalid.txt' 'bad'", timeout_ms: 999 },
    { script: "Set-Content './invalid.txt' 'bad'", timeout_ms: 30001 },
  ]) assert.equal((await call('powershell_execute', { cwd: workspace, ...input })).isError, true);
  assert.equal(existsSync(path.join(workspace, 'invalid.txt')), false);
  assert.equal(existsSync(path.join(root, 'runtime/computer-audit.jsonl')), false);
  const boundary = await call('powershell_execute', { cwd: workspace, script: '#' + 'a'.repeat(131071) });
  assert.equal(boundary.isError, false);
  assert.equal(boundary.timeout_ms, 30000);
  for (const query of ['version', 'location', 'system', 'processes']) {
    const result = await call('powershell', { cwd: workspace, query });
    assert.equal(result.isError, false);
    assert.equal(result.timeout_ms, 10000);
    assert.notEqual(result.data, undefined);
  }
});

test('MCP applies explicit PowerShell and native exit semantics without stale error state', async t => {
  const { workspace, call } = await connect(t);
  const native = `& '${process.execPath.replaceAll("'", "''")}' -e 'process.stdout.write("NATIVE_OUT");process.stderr.write("NATIVE_ERR");process.exit(9)'`;
  for (const [script, exit, expectedOut, errorText] of [
    ["'BEFORE'; Write-Error 'PS_FAILURE'; 'AFTER'", 1, 'BEFORE', 'PS_FAILURE'],
    ["'BEFORE'; throw 'THROWN'; 'AFTER'", 1, 'BEFORE', 'THROWN'],
    ["Set-Content './parse-side-effect.txt' 'bad'; if (", 1, '', 'ParseException'],
    [native + "; 'AFTER'", 9, 'NATIVE_OUT', 'NATIVE_ERR'],
    [`try { ${native} } catch { 'HANDLED' }; 'RECOVERED'`, 0, 'RECOVERED', 'NATIVE_ERR'],
    ["try { Write-Error 'EXPECTED' } catch { 'HANDLED' }; 'RECOVERED'", 0, 'RECOVERED', ''],
    ["Write-Error 'EXPECTED' -ErrorAction Continue; 'RECOVERED'", 0, 'RECOVERED', 'EXPECTED'],
    [`$PSNativeCommandUseErrorActionPreference=$false; ${native}; if ($LASTEXITCODE -eq 9) { 'EXPECTED_CODE' }`, 0, 'EXPECTED_CODE', 'NATIVE_ERR'],
    ["Read-Host 'prompt'; 'AFTER'", 1, '', 'NonInteractive'],
    ["'BEFORE'; return; 'AFTER'", 0, 'BEFORE', ''],
  ]) {
    const response = await call('powershell_execute', { cwd: workspace, script });
    assert.equal(response.isError, exit !== 0, script);
    const result = response.isError ? response.error.details.result : response;
    assert.equal(result.exit_code, exit, script);
    assert.ok(result.stdout.includes(expectedOut), script);
    assert.equal(result.stdout.includes('AFTER'), false, script);
    assert.ok(result.stderr.includes(errorText), script);
  }
  assert.equal(existsSync(path.join(workspace, 'parse-side-effect.txt')), false);
});

test('MCP timeout stops the actual PowerShell root and its owned native child', async t => {
  const { workspace, call } = await connect(t);
  const worker = path.join(workspace, 'worker.cjs');
  writeFileSync(worker, 'setInterval(()=>{},1000);', 'utf8');
  const response = await call('powershell_execute', { cwd: workspace, timeout_ms: 2500, script: [
    `$p = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '"${worker.replaceAll("'", "''")}"' -PassThru -WindowStyle Hidden`,
    '[Console]::Out.WriteLine("$PID,$($p.Id)")',
    'Start-Sleep -Seconds 20',
  ].join('\n') });
  assert.equal(response.error.code, 'QUERY_TIMEOUT');
  const result = response.error.details.result;
  const ids = result.stdout.trim().split(',').map(Number);
  assert.equal(ids.length, 2);
  assert.ok(ids.every(id => Number.isInteger(id) && id > 0));
  assert.ok(ids.every(id => !isProcessAlive(id)), 'both owned processes have actually ended');
  assert.equal(result.process_state, 'exited');
  assert.equal(result.termination.tree_kill, 'succeeded');
});

test('MCP creates, reads, updates with a hash, lists and moves a UTF-8 workspace file', async t => {
  const { workspace, call } = await connect(t);
  const file = path.join(workspace, '问候 [1].txt');
  const content = 'AI 助手 → 协作助手 🌸\r\n"双引号" \'单引号\' $HOME `tick` C:\\中文 路径\\a.txt';
  const written = await call('filesystem_write', { path: file, content });
  assert.equal(written.isError, false);
  assert.equal(readFileSync(file, 'utf8'), content);
  const read = await call('filesystem_read', { path: file });
  assert.equal(read.content, content); assert.equal(read.sha256, written.sha256);
  const list = await call('filesystem_list', { path: workspace });
  assert.ok(list.entries.some(e => e.name === '问候 [1].txt'));
  const collision = await call('filesystem_write', { path: file, content: 'overwrite' });
  assert.equal(collision.error.code, 'FILE_EXISTS');
  const conflict = await call('filesystem_write', { path: file, content: 'overwrite', expected_sha256: '0'.repeat(64) });
  assert.equal(conflict.error.code, 'CONTENT_CONFLICT');
  const update = await call('filesystem_write', { path: file, content: '第二版', expected_sha256: read.sha256 });
  assert.equal(update.isError, false); assert.equal(readFileSync(file, 'utf8'), '第二版');
  const destination = path.join(workspace, '已移动.txt');
  const moved = await call('filesystem_move', { source: file, destination, expected_sha256: update.sha256 });
  assert.equal(moved.isError, false); assert.equal(existsSync(file), false);
  assert.equal(readFileSync(destination, 'utf8'), '第二版');
});

test('filesystem denies out-of-root, read-only writes, credentials, links and overwrite moves', async t => {
  const { root, workspace, readOnly, call } = await connect(t);
  const publicFile = path.join(readOnly, 'public.txt'); writeFileSync(publicFile, '只读资料', 'utf8');
  assert.equal((await call('filesystem_read', { path: publicFile })).content, '只读资料');
  assert.equal((await call('filesystem_write', { path: publicFile, content: '改写' })).error.code, 'PATH_NOT_ALLOWED');
  const outside = path.join(root, 'outside.txt'); writeFileSync(outside, 'outside', 'utf8');
  assert.equal((await call('filesystem_read', { path: outside })).error.code, 'PATH_NOT_ALLOWED');
  const key = path.join(workspace, '.env'); writeFileSync(key, 'TEST_ONLY=placeholder', 'utf8');
  assert.equal((await call('filesystem_read', { path: key })).error.code, 'PROTECTED_PATH');
  const secretDirectory = path.join(workspace, 'select-key'); mkdirSync(secretDirectory);
  assert.equal((await call('filesystem_list', { path: workspace })).entries.some(e => e.name === 'select-key'), false);
  const link = path.join(workspace, 'escape'); symlinkSync(readOnly, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('filesystem_read', { path: path.join(link, 'public.txt') })).error.code, 'LINK_NOT_ALLOWED');
  const hardlink = path.join(workspace, 'hardlink.txt'); linkSync(outside, hardlink);
  assert.equal((await call('filesystem_read', { path: hardlink })).error.code, 'LINK_NOT_ALLOWED');
  const source = path.join(workspace, 'source.txt');
  const destination = path.join(workspace, 'destination.txt');
  const written = await call('filesystem_write', { path: source, content: 'source' });
  writeFileSync(destination, 'keep', 'utf8');
  assert.equal((await call('filesystem_move', { source, destination, expected_sha256: written.sha256 })).error.code, 'FILE_EXISTS');
  assert.equal(readFileSync(destination, 'utf8'), 'keep'); assert.equal(readFileSync(source, 'utf8'), 'source');
  const credentialLike = path.join(workspace, 'ordinary.txt');
  const sample = 'sk-' + 'TESTONLY'.repeat(5);
  writeFileSync(credentialLike, sample, 'utf8');
  assert.equal((await call('filesystem_read', { path: credentialLike })).error.code, 'SENSITIVE_CONTENT');
  const audit = readFileSync(path.join(root, 'runtime', 'computer-audit.jsonl'), 'utf8');
  assert.equal(audit.includes(sample), false); assert.equal(audit.includes('只读资料'), false);
});

test('git status and a literal file diff are read-only MCP operations', async t => {
  const { workspace, call } = await connect(t);
  const git = args => { const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', shell: false, windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '--quiet']);
  const file = path.join(workspace, '笔记 [1].txt'); writeFileSync(file, 'before\n', 'utf8');
  git(['add', '--', '笔记 [1].txt']);
  git(['-c', 'user.name=Bridge Test', '-c', 'user.email=bridge@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  writeFileSync(file, 'after\n', 'utf8');
  const status = await call('git_status', { cwd: workspace });
  assert.equal(status.isError, false); assert.ok(status.stdout.includes('笔记 [1].txt'));
  const diff = await call('git_diff', { cwd: workspace, path: file });
  assert.equal(diff.isError, false); assert.ok(diff.stdout.includes('-before')); assert.ok(diff.stdout.includes('+after'));
  const directoryDiff = await call('git_diff', { cwd: workspace, path: workspace });
  assert.equal(directoryDiff.error.code, 'NOT_A_FILE');
  assert.equal(readFileSync(file, 'utf8'), 'after\n');
  // A benign configured clean filter writes only a fixture marker. Ordinary
  // Git invokes it; our read-only queries must explicitly suppress it.
  const marker = path.join(workspace, 'filter-ran.txt');
  const script = path.join(workspace, 'filter.cjs');
  writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(fs.readFileSync(0));`, 'utf8');
  writeFileSync(path.join(workspace, '.gitattributes'), '*.txt filter=probe\n', 'utf8');
  git(['config', 'filter.probe.clean', `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`]);
  git(['diff', '--no-ext-diff', '--no-textconv', '--', '笔记 [1].txt']);
  assert.equal(existsSync(marker), true, 'fixture proves native Git invokes the filter');
  rmSync(marker);
  assert.equal((await call('git_status', { cwd: workspace })).isError, false);
  assert.equal((await call('git_diff', { cwd: workspace, path: file })).isError, false);
  assert.equal(existsSync(marker), false, 'read-only queries must not invoke clean filters');
  git(['config', 'filter.probe.process', `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`]);
  git(['config', 'filter.probe.required', 'true']);
  assert.equal((await call('git_status', { cwd: workspace })).isError, false);
  assert.equal((await call('git_diff', { cwd: workspace, path: file })).isError, false);
  assert.equal(existsSync(marker), false, 'required process filters must also remain disabled');
  // A filter name altered by output redaction must fail closed, never override
  // the redacted name and accidentally leave the original command enabled.
  git(['config', 'filter.sk-TESTONLYTESTONLY.clean', 'echo test-only']);
  const refused = await call('git_status', { cwd: workspace });
  assert.equal(refused.error.code, 'SENSITIVE_CONTENT');
  assert.equal(refused.error.details.result, undefined, 'content refusal must not attach rejected Git output');
});

test('Windows short names cannot bypass protected installation or Git paths', { skip: process.platform !== 'win32' }, t => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'yuki-path-test-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const policy = new PathPolicy([repository], [repository], runtime);
  // Existing short names are probed as metadata only; no protected content is read.
  const aliases = [
    path.join(repository, 'tools/CODEX-~1/src/computer/query.ps1'),
    path.join(repository, 'tools/CODEX-~1/src/computer/new-test-file.txt'),
    path.join(repository, 'GIT~1/config'),
  ];
  let exercised = 0;
  for (const alias of aliases) {
    if (!existsSync(path.dirname(alias))) continue;
    assert.throws(() => policy.resolve(alias, { write: true, missing: true }), { code: 'PROTECTED_PATH' });
    exercised++;
  }
  if (exercised === 0) t.skip('Volume does not expose the known 8.3 aliases');
});
