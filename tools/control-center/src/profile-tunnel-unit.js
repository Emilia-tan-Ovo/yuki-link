import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fail, get, run, sleep } from './common.js';
import { matches } from './host.js';
import { tunnelHealth } from './units.js';
import { tunnelEvents } from './tunnel-events.js';

const VERSION = '0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0';
const STARTUP_TIMEOUT_MS = 15_000;

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export class ProfileTunnelUnit {
  constructor(config, host, state, persist, events, { spawnProcess = spawn, invoke = run, getHttp = get } = {}) {
    Object.assign(this, { config, host, state, persist, events, spawnProcess, invoke, getHttp });
  }

  markers() { return ['run', '--profile-file', this.config.profile]; }

  verifyProfile() {
    if (!existsSync(this.config.profile)) throw fail('PATH_MISSING');
    if (digest(this.config.profile) !== this.config.profileSha256) throw fail('PROFILE_CHANGED');
  }

  async verifyVersion() {
    const result = await this.invoke(this.config.bin, ['--version']);
    if (result.code !== 0 || !result.output.startsWith(VERSION)) throw fail('VERSION_UNSUPPORTED');
  }

  runtimeFiles() {
    return {
      health: path.join(this.config.stateDir, 'health.url'),
      log: path.join(this.config.stateDir, 'tunnel.log'),
      pid: path.join(this.config.stateDir, 'tunnel.pid'),
    };
  }

  async observe() {
    let profileCode = null;
    try { this.verifyProfile(); } catch (error) { profileCode = error.code ?? 'PROFILE_CHANGED'; }
    const found = await this.host.inspect(this.config.bin, this.markers());
    if (found.length > 1) return { running: true, owned: false, healthy: false, code: 'MULTIPLE_INSTANCES' };
    const actual = found[0];
    if (!actual) return {
      running: false, owned: false, healthy: false, code: profileCode,
      controlPlane: { state: 'unknown' },
      communication: { state: 'unknown-or-expired', at: null, source: 'bounded native log tail' },
    };
    const owned = matches(actual, this.state.process);
    if (!owned) return {
      running: true, owned: false, managedIdentity: !profileCode && (() => {
        try { return Number(readFileSync(this.runtimeFiles().pid, 'utf8').trim()) === actual.pid; } catch { return false; }
      })(), healthy: false, pid: actual.pid, created: actual.created,
      code: 'OBSERVED_UNOWNED', controlPlane: { state: 'unknown' },
      communication: { state: 'unknown-or-expired', at: null, source: 'bounded native log tail' },
    };
    if (profileCode) return {
      running: true, owned: true, healthy: false, pid: actual.pid, created: actual.created,
      code: profileCode, controlPlane: { state: 'unknown' },
      communication: { state: 'unknown-or-expired', at: null, source: 'bounded native log tail' },
    };

    const files = this.runtimeFiles();
    const recent = tunnelEvents(files.log);
    const communication = recent.filter(event => ['poll-recovered', 'forwarded-to-mcp'].includes(event.action)).at(-1);
    const communicationEvidence = {
      at: communication?.at ?? null,
      source: 'bounded native log tail',
      state: communication && Date.now() - Date.parse(communication.at) < 120_000 ? 'recent-local-evidence' : 'unknown-or-expired',
    };
    let result = { healthy: false, code: 'HEALTH_FAILED', controlPlane: { state: 'unknown' } };
    let base = null;
    try {
      base = readFileSync(files.health, 'utf8').trim();
      const url = new URL(base);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw fail('NON_LOOPBACK_URL');
      const [health, ready, system] = await Promise.all([
        this.getHttp(base + '/healthz'), this.getHttp(base + '/readyz'), this.getHttp(base + '/api/system'),
      ]);
      result = tunnelHealth(health, ready, system.json);
    } catch { base = null; }
    return {
      running: true, owned: true, pid: actual.pid, created: actual.created, ...result,
      ui: base ? base + '/ui' : null, recentEvents: recent, communication: communicationEvidence,
    };
  }

  async start() {
    const before = await this.observe();
    if (before.running) {
      if (before.owned && !['PROFILE_CHANGED', 'PATH_MISSING'].includes(before.code)) return;
      throw fail(before.code ?? 'OBSERVED_UNOWNED');
    }
    if (!existsSync(this.config.bin)) throw fail('PATH_MISSING');
    this.verifyProfile();
    await this.verifyVersion();

    mkdirSync(this.config.stateDir, { recursive: true });
    const files = this.runtimeFiles();
    for (const file of Object.values(files)) rmSync(file, { force: true });

    this.state.process = null;
    this.state.profileSha256 = this.config.profileSha256;
    this.persist();
    const args = [
      'run',
      '--profile-file', this.config.profile,
      '--health.listen-addr', '127.0.0.1:0',
      '--health.url-file', files.health,
      '--log.file', files.log,
      '--log.format', 'json',
      '--pid.file', files.pid,
    ];
    const child = this.spawnProcess(this.config.bin, args, {
      cwd: path.dirname(this.config.bin), shell: false, windowsHide: true, detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('exit', code => {
      this.events.add('windowsTunnel', 'process-exit', null, code);
      if (this.state.process?.pid === child.pid) {
        this.state.lastExit = { at: new Date().toISOString(), exitCode: code };
        this.persist();
      }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fail('SPAWN_FAILED'))); });
    child.unref();

    const actual = (await this.host.inspect(this.config.bin, this.markers(), child.pid))[0];
    if (!actual?.matches) throw fail('OWNERSHIP_CHANGED');
    this.state.process = actual;
    this.persist();

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const observation = await this.observe();
      if (observation.running && observation.owned && observation.healthy) return;
      if (!observation.running) throw fail('NATIVE_CONNECT_FAILED');
      await sleep(200);
    }
    throw fail('STARTUP_TIMEOUT');
  }

  async stop(confirm = false) {
    const current = await this.observe();
    if (!current.running) return;
    if (!current.owned && (!confirm || !current.managedIdentity)) throw fail(current.code ?? 'OBSERVED_UNOWNED');
    const actual = (await this.host.inspect(this.config.bin, this.markers(), current.pid))[0];
    if (!actual || !matches(actual, current) || current.owned && !matches(actual, this.state.process)) throw fail('OWNERSHIP_CHANGED');

    try { process.kill(current.pid, 'SIGTERM'); }
    catch (error) { if (error?.code !== 'ESRCH') throw fail('STOP_OUTCOME_UNKNOWN'); }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!(await this.host.inspect(this.config.bin, this.markers(), current.pid)).length) return;
      await sleep(200);
    }
    if (confirm) { await this.host.terminateTree(this.config.bin, this.markers(), current); return; }
    throw fail('STOP_TIMEOUT');
  }
}
