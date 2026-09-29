import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fail, sleep } from './common.js';
import { matches } from './host.js';

const MCP_STARTUP_TIMEOUT_MS = 10_000;
const MCP_PROBE_TIMEOUT_MS = 5_000;

const markers = port => ['windows_mcp', 'serve', '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', String(port)];

function parseSseJson(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch { /* keep looking */ }
  }
  try { return JSON.parse(text); } catch { return null; }
}

export async function probeWindowsMcp(port, fetchImpl = fetch) {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'yuki-control-center-probe', version: '1' } },
  };
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MCP_PROBE_TIMEOUT_MS),
    });
    const payload = parseSseJson(await response.text());
    const info = payload?.result?.serverInfo;
    if (response.status !== 200 || info?.name !== 'windows-mcp' || typeof info.version !== 'string')
      return { healthy: false, code: 'MCP_RESPONSE_INVALID', status: response.status };
    return { healthy: true, code: null, status: response.status, serverName: info.name, serverVersion: info.version };
  } catch {
    return { healthy: false, code: 'MCP_NOT_READY', status: null };
  }
}

export class WindowsMcpUnit {
  constructor(config, host, state, persist, events, { spawnProcess = spawn, probe = probeWindowsMcp } = {}) {
    Object.assign(this, { config, host, state, persist, events, spawnProcess, probe });
  }

  markers() { return markers(this.config.port); }

  async observe() {
    const found = await this.host.inspect(this.config.python, this.markers());
    if (found.length > 1) return { running: true, owned: false, healthy: false, code: 'MULTIPLE_INSTANCES' };
    const p = found[0];
    if (!p) {
      try { await this.host.free(this.config.port); }
      catch { return { running: true, owned: false, healthy: false, code: 'PORT_CONFLICT' }; }
      return { running: false, owned: false, healthy: false, lastExit: this.state.lastExit ?? null, mcpProbe: this.state.lastProbe ?? null };
    }
    const owned = matches(p, this.state.process);
    const identityChanged = Boolean(this.state.process && !owned);
    const probe = this.state.lastProbe?.pid === p.pid && this.state.lastProbe?.created === p.created ? this.state.lastProbe : null;
    return {
      running: true, owned, healthy: Boolean(owned && probe?.healthy), pid: p.pid, created: p.created,
      mcpProbe: probe, serverVersion: probe?.serverVersion ?? null,
      code: identityChanged ? 'OWNERSHIP_CHANGED' : !owned ? 'OBSERVED_UNOWNED' : !probe?.healthy ? (probe?.code ?? 'MCP_NOT_READY') : null,
    };
  }

  async start() {
    const before = await this.observe();
    if (before.running) { if (before.owned && before.healthy) return; throw fail(before.code ?? 'OBSERVED_UNOWNED'); }
    if (!existsSync(this.config.python)) throw fail('WINDOWS_MCP_PYTHON_PATH_MISSING');
    await this.host.free(this.config.port);

    this.state.process = null;
    this.state.lastProbe = null;
    this.persist();
    const args = ['-m', 'windows_mcp', 'serve', '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', String(this.config.port)];
    const child = this.spawnProcess(this.config.python, args, {
      cwd: this.config.cwd ?? undefined, shell: false, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('exit', code => {
      this.events.add('windowsMcp', 'process-exit', null, code);
      if (this.state.process?.pid === child.pid) {
        this.state.lastExit = { at: new Date().toISOString(), exitCode: code };
        this.persist();
      }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fail('SPAWN_FAILED'))); });
    child.unref();

    const actual = (await this.host.inspect(this.config.python, this.markers(), child.pid))[0];
    if (!actual?.matches) throw fail('OWNERSHIP_CHANGED');
    this.state.process = actual;
    this.persist();

    const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try { await this.host.free(this.config.port); }
      catch {
        await sleep(150);
        const result = await this.probe(this.config.port);
        this.state.lastProbe = { ...result, at: new Date().toISOString(), pid: actual.pid, created: actual.created };
        this.persist();
        if (!result.healthy) throw fail(result.code ?? 'MCP_NOT_READY');
        return;
      }
      await sleep(100);
    }
    throw fail('MCP_NOT_READY');
  }

  async stop() {
    const current = await this.observe();
    if (!current.running) return;
    if (!current.owned) throw fail(current.code ?? 'OBSERVED_UNOWNED');
    const found = (await this.host.inspect(this.config.python, this.markers(), current.pid))[0];
    if (!found || !matches(found, current) || !matches(found, this.state.process)) throw fail('OWNERSHIP_CHANGED');

    try { process.kill(current.pid, 'SIGTERM'); }
    catch (error) { if (error?.code !== 'ESRCH') throw fail('STOP_OUTCOME_UNKNOWN'); }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!(await this.host.inspect(this.config.python, this.markers(), current.pid)).length) {
        this.state.lastStop = { at: new Date().toISOString(), pid: current.pid, created: current.created, state: 'stopped' };
        this.persist();
        return;
      }
      await sleep(200);
    }
    throw fail('STOP_TIMEOUT');
  }
}
