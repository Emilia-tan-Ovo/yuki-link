import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fail, sleep } from './common.js';
import { matches } from './host.js';

const MCP_STARTUP_TIMEOUT_MS = 10_000;
const MCP_PROBE_TIMEOUT_MS = 5_000;

const markers = port => ['-m', 'windows_mcp', 'serve', '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', String(port)];

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
    // A matching command line and an MCP greeting are public observations.
    // Persisted spawn identity is the independent managed provenance.
    const portOwner = await this.host.portOwner?.(this.config.port);
    const portBound = portOwner === p.pid;
    const source = matches(p, this.state.process) || matches(p, this.state.managedProcess);
    const owned = matches(p, this.state.process) && portBound;
    const identityChanged = Boolean(this.state.process && !owned);
    // Readiness is a live observation. A successful startup probe is never a
    // permanent health lease for a process that later stops serving MCP.
    const result = await this.probe(this.config.port);
    const probe = { ...result, at: new Date().toISOString(), pid: p.pid, created: p.created };
    if (this.state.lastProbe?.healthy !== probe.healthy || this.state.lastProbe?.code !== probe.code
      || this.state.lastProbe?.pid !== p.pid || Date.now() - Date.parse(this.state.lastProbe?.at ?? 0) > 30_000) {
      this.state.lastProbe = probe; this.persist();
    }
    return {
      running: true, owned, managedIdentity: Boolean(p.matches && portBound && source),
      healthy: Boolean(owned && probe?.healthy), pid: p.pid, created: p.created,
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
    this.state.managedProcess = null;
    this.state.lastProbe = null;
    this.persist();
    const args = ['-m', 'windows_mcp', 'serve', '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', String(this.config.port)];
    const child = this.spawnProcess(this.config.python, args, {
      cwd: this.config.cwd ?? undefined, shell: false, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    let launchedProcess = null;
    child.once('exit', code => {
      this.events.add('windowsMcp', 'process-exit', null, code);
      if (launchedProcess && this.state.process?.pid === launchedProcess.pid
        && this.state.process.created === launchedProcess.created) {
        this.state.lastExit = { at: new Date().toISOString(), exitCode: code };
        this.persist({ unitExit: { id: 'windowsMcp', process: launchedProcess, lastExit: this.state.lastExit } });
      }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fail('SPAWN_FAILED'))); });
    child.unref();

    const actual = (await this.host.inspect(this.config.python, this.markers(), child.pid))[0];
    if (!actual?.matches || actual.pid !== child.pid || !actual.created) throw fail('OWNERSHIP_CHANGED');
    launchedProcess = { pid: actual.pid, created: actual.created };
    this.state.process = actual;
    this.state.managedProcess = actual;
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

  async stop(confirm = false) {
    const current = await this.observe();
    if (!current.running) return;
    if (!current.owned && (!confirm || !current.managedIdentity)) throw fail(current.code ?? 'OBSERVED_UNOWNED');
    const found = (await this.host.inspect(this.config.python, this.markers(), current.pid))[0];
    if (!found || !matches(found, current) || current.owned && !matches(found, this.state.process)) throw fail('OWNERSHIP_CHANGED');
    if (await this.host.portOwner?.(this.config.port) !== current.pid
      || !matches(found, this.state.process) && !matches(found, this.state.managedProcess)) throw fail('OWNERSHIP_CHANGED');

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
    if (confirm) {
      await this.host.terminateTree(this.config.python, this.markers(), current);
      this.state.lastStop = { at: new Date().toISOString(), pid: current.pid, created: current.created, state: 'interrupted' };
      this.persist();
      return;
    }
    throw fail('STOP_TIMEOUT');
  }
}
