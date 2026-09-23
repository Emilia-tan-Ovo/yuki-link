import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, copyFileSync } from 'node:fs';
import { fail, get, readJson, run, sleep } from './common.js';
import { matches } from './host.js';
import { tunnelEvents } from './tunnel-events.js';
import { deploymentTarget, verifyDeployment } from './deployment.js';
import { resolveCodexExecutable } from '../../codex-session-bridge/src/codex-executable.js';
import { FileImplementationLaunchAuthoritySource } from '../../codex-session-bridge/src/orchestration/implementation-launcher.ts';
import { FileReviewLaunchAuthoritySource } from '../../codex-session-bridge/src/orchestration/review-launcher.ts';

export class YcaUnit {
  constructor(config, host, state, persist, events) { Object.assign(this, { config, host, state, persist, events }); }
  markers(instance = this.state.instance) { return [this.state.entry ?? this.config.entry, ...(instance ? ['--control-instance', instance] : ['--runtime', this.config.runtime])]; }
  async observe() {
    const found = await this.host.inspect(this.config.node, this.markers());
    if (found.length > 1) return { running: true, owned: false, healthy: false, code: 'MULTIPLE_INSTANCES' };
    const p = found[0];
    let target = null, deploymentCode = null;
    try { if (this.config.deploymentRoot) target = deploymentTarget(this.config.deploymentRoot); }
    catch (e) { deploymentCode = e.code; }
    const expected = this.state.deployment;
    if (!p) {
      // A foreign launcher can use relative src/main.js. The port is a second
      // independent conflict check and never grounds permission to terminate it.
      try { await this.host.free(this.config.port); }
      catch { return { running: true, owned: false, healthy: false, code: 'PORT_CONFLICT' }; }
      const oldLock = readJson(path.join(this.config.runtime, 'bridge.lock'), null);
      const deployment = { running: null, target, launched: expected ?? null,
        state: deploymentCode ? 'invalid-target' : !this.config.deploymentRoot ? 'unmanaged' : target?.commit !== expected?.commit ? 'update-pending' : 'stopped' };
      return { running: false, owned: false, healthy: false, deployment, code: oldLock && oldLock.token !== this.state.lock?.token ? 'LEGACY_RUNTIME_LOCK' : deploymentCode, lastExit: this.state.lastExit ?? null };
    }
    const processMatches = matches(p, this.state.process);
    let owned = false;
    let diagnostic;
    try {
      const response = await get(`http://127.0.0.1:${this.config.controlPort}/status`, { token: this.state.token });
      diagnostic = response.status === 200 ? response.json : null;
      if (diagnostic?.instance !== this.state.instance || diagnostic?.pid !== p.pid || diagnostic?.service !== 'yuki-local-control') diagnostic = null;
    } catch { /* unknown activity is not idle */ }
    owned = processMatches && Boolean(diagnostic);
    if (!this.state.process && this.state.instance && diagnostic) {
      this.state.process = p; this.persist(); owned = true; // recover a spawn/persist interruption with instance authentication
    }
    let health;
    try { const h = await get(`http://127.0.0.1:${this.config.port}/healthz`); health = h.status === 200 && h.json?.service === 'yuki-computer-agent' && h.json.status === 'ok'; } catch { health = false; }
    if (owned && diagnostic && !this.state.lock) {
      const lock = readJson(path.join(this.config.runtime, 'bridge.lock'), null);
      if (lock?.pid === p.pid) { this.state.lock = lock; this.persist(); }
    }
    const activity = diagnostic?.active;
    const validActivity = activity && ['codex', 'computer', 'requests'].every(key => Number.isSafeInteger(activity[key]) && activity[key] >= 0);
    const runningSource = diagnostic?.source ?? null;
    const validTools = diagnostic?.tools && Number.isSafeInteger(diagnostic.tools.count) && diagnostic.tools.count >= 0
      && /^[a-f0-9]{64}$/.test(diagnostic.tools.sha256 ?? '');
    const verified = expected && runningSource?.commit === expected.commit && runningSource.dirty === false
      && validTools && diagnostic.tools.sha256 === expected.tools.sha256 && diagnostic.tools.count === expected.tools.count;
    const deployment = { running: runningSource, target, launched: expected ?? null,
      state: deploymentCode ? 'invalid-target' : !this.config.deploymentRoot ? 'unmanaged' : !verified ? 'unverified' : target?.commit !== expected.commit ? 'update-pending' : 'verified' };
    return { running: true, owned, authenticated: Boolean(diagnostic), instance: diagnostic?.instance ?? null,
      pid: p.pid, created: p.created, healthy: Boolean(health && owned && validActivity && !diagnostic.closing && (!expected || verified)), deployment,
      activity: validActivity ? activity : null, tools: validTools ? diagnostic.tools : null, lastBridge: diagnostic?.lastBridge ?? null,
      code: !diagnostic ? 'ACTIVITY_UNKNOWN' : !owned ? 'OBSERVED_UNOWNED' : !validActivity ? 'ACTIVITY_UNKNOWN'
        : expected && !runningSource ? 'DEPLOYMENT_OBSERVATION_PENDING' : expected && !verified ? 'DEPLOYMENT_UNVERIFIED'
          : !health ? 'HEALTH_FAILED' : deploymentCode };
  }
  async start({ commit = null, recovery = false, instance = null } = {}) {
    const before = await this.observe();
    if (before.running) { if (before.owned) return; throw fail(before.code ?? 'OBSERVED_UNOWNED'); }
    const pinnedCommit = commit ?? (recovery ? this.state.deployment?.commit : null);
    if ((commit || recovery) && this.config.deploymentRoot && !pinnedCommit) throw fail('DEPLOYMENT_EXPLICIT_START_REQUIRED');
    const deployment = this.config.deploymentRoot
      ? await verifyDeployment(this.config.deploymentRoot, pinnedCommit ?? undefined, this.config.node) : null;
    if (this.config.implementationLaunchAuthority) {
      if (!deployment?.launcherFlags?.implementationLaunchAuthority) throw fail('DEPLOYMENT_LAUNCHER_UNSUPPORTED');
      new FileImplementationLaunchAuthoritySource(this.config.implementationLaunchAuthority, {
        forbiddenRoots: [this.config.repo, this.config.deploymentRoot],
      }).snapshot('', '');
    }
    if (this.config.reviewLaunchAuthority) {
      if (!deployment?.launcherFlags?.reviewLaunchAuthority) throw fail('DEPLOYMENT_LAUNCHER_UNSUPPORTED');
      new FileReviewLaunchAuthoritySource(this.config.reviewLaunchAuthority, {
        forbiddenRoots: [this.config.repo, this.config.deploymentRoot],
      }).snapshot('', '', '');
    }
    const entry = deployment?.entry ?? this.config.entry, cwd = deployment?.cwd ?? this.config.cwd;
    for (const [name, file] of Object.entries({ NODE: this.config.node, YCA_ENTRY: entry, PWSH: this.config.pwsh })) if (!existsSync(file)) throw fail(`${name}_PATH_MISSING`);
    this.codexResolution = resolveCodexExecutable(this.config.codex);
    await this.host.free(this.config.port); await this.host.free(this.config.controlPort);
    if (this.config.harnessPort !== undefined) await this.host.free(this.config.harnessPort);
    const lockFile = path.join(this.config.runtime, 'bridge.lock');
    if (existsSync(lockFile)) {
      const lock = readJson(lockFile);
      // Unknown legacy locks remain untouched. Only our exact previous lock can
      // be retired after verifying its process is gone and no active orphan run exists.
      if (!this.state.lock || lock.token !== this.state.lock.token || lock.pid !== this.state.process?.pid) throw fail('LEGACY_RUNTIME_LOCK');
      if ((await this.host.inspect(this.config.node, [], lock.pid)).length) throw fail('RUNTIME_LOCKED');
      const runs = readJson(path.join(this.config.runtime, 'sessions.json'), { runs: {} }).runs;
      for (const r of Object.values(runs)) {
        if (['queued', 'running', 'stopping'].includes(r.status) && r.pid && (await this.host.inspect(this.config.node, [], r.pid)).length) throw fail('ORPHAN_TASK_REVIEW');
      }
      renameSync(lockFile, `${lockFile}.control-backup-${Date.now()}`);
    }
    this.state.instance = instance ?? randomUUID(); this.state.token = randomBytes(32).toString('hex'); this.state.process = null; this.state.lock = null;
    this.state.entry = entry; this.state.deployment = deployment ? { commit: deployment.commit, tools: deployment.tools } : null; this.persist();
    const args = [entry, '--transport', 'http', '--port', String(this.config.port), '--allow-cwd', this.config.repo,
      '--runtime', this.config.runtime, '--codex-bin', this.codexResolution.executable, '--pwsh-bin', this.config.pwsh,
      '--control-port', String(this.config.controlPort), '--control-instance', this.state.instance];
    if (this.config.servicesUrl) args.push('--services-url', this.config.servicesUrl);
    if (this.config.harnessPort !== undefined) args.push('--harness-port', String(this.config.harnessPort));
    // Older unmanaged YCA entries may not understand the deployment-era option.
    if (deployment) for (const root of this.config.controlRoots ?? []) args.push('--control-root', root);
    if (this.config.implementationLaunchAuthority) args.push('--implementation-launch-authority', this.config.implementationLaunchAuthority);
    if (this.config.reviewLaunchAuthority) args.push('--review-launch-authority', this.config.reviewLaunchAuthority);
    const child = spawn(this.config.node, args, { cwd, shell: false, windowsHide: true, detached: true,
      env: { ...process.env, YUKI_CONTROL_TOKEN: this.state.token }, stdio: ['ignore', 'ignore', 'ignore'] });
    const launchedInstance = this.state.instance;
    child.once('exit', code => {
      this.events.add('yca', 'process-exit', null, code);
      if (this.state.instance === launchedInstance) { this.state.lastExit = { at: new Date().toISOString(), exitCode: code }; this.persist(); }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fail('SPAWN_FAILED'))); });
    child.unref();
    const p = (await this.host.inspect(this.config.node, this.markers(), child.pid))[0];
    if (p?.matches) { this.state.process = p; this.persist(); }
  }
  async stop(confirm = false) {
    const current = await this.observe();
    if (!current.running) return;
    if (!current.owned) throw fail('OBSERVED_UNOWNED');
    // No blind taskkill fallback: a wedged process whose activity cannot be
    // authenticated needs operator investigation; live tasks are never guessed idle.
    if (!current.activity) throw fail('ACTIVITY_UNKNOWN');
    if (!confirm && Object.values(current.activity).some(n => n > 0)) throw fail('ACTIVE_TASKS');
    const result = await get(`http://127.0.0.1:${this.config.controlPort}/stop`, { token: this.state.token, method: 'POST', confirm });
    if (result.status !== 202) throw fail(result.status === 409 ? 'ACTIVE_TASKS' : 'STOP_REJECTED');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const p = (await this.host.inspect(this.config.node, this.markers(), current.pid))[0];
      if (!p) return;
      if (!matches(p, this.state.process)) throw fail('OWNERSHIP_CHANGED');
      await sleep(200);
    }
    throw fail('STOP_TIMEOUT');
  }
}

export function tunnelHealth(health, ready, system, at = Date.now()) {
  const route = system?.proxy_health?.find(p => p.route?.kind === 'control_plane');
  // Native reachability observations do not prove a successful model/tool call.
  const checked = route?.last_check;
  const checkTime = typeof checked === 'string' ? Date.parse(checked) : Date.parse(checked?.checked_at ?? checked?.at ?? checked?.time);
  const fresh = Number.isFinite(checkTime) && at - checkTime >= -5000 && at - checkTime < 120_000;
  const readyOK = ready?.status === 200 && ready.body.trim() === 'ready';
  const alive = health?.status === 200 && health.body.trim() === 'live';
  return { healthy: alive && readyOK, ready: readyOK, controlPlane: { kind: 'proxy_reachability_not_end_to_end', state: fresh && ['healthy', 'unhealthy', 'direct'].includes(route.health_state) ? route.health_state : 'unknown', evidenceAt: Number.isFinite(checkTime) ? new Date(checkTime).toISOString() : null,
    reason: !fresh ? 'EVIDENCE_UNAVAILABLE_OR_EXPIRED' : null },
    code: ready?.status === 401 || ready?.status === 403 || /requires auth/i.test(ready?.body ?? '') ? 'AUTH_REQUIRED' : !alive ? 'HEALTH_FAILED' : !readyOK ? 'MCP_NOT_READY' : null };
}

export class TunnelUnit {
  constructor(config, host, state, persist, events, invoke = run) { Object.assign(this, { config, host, state, persist, events, invoke }); }
  async verifyVersion() {
    const r = await this.invoke(this.config.bin, ['--version']);
    if (r.code !== 0 || !r.output.startsWith('0.0.14+0f870e50a973fa820d4c409000059e181e8d242b')) throw fail('VERSION_UNSUPPORTED');
  }
  records() {
    const alias = readJson(path.join(this.config.stateRoot, 'aliases.yaml'))[this.config.alias];
    const p = readJson(path.join(this.config.stateRoot, 'processes.yaml'))[this.config.alias];
    const profile = readJson(this.config.profile);
    if (!alias || alias.tunnel_id !== profile.control_plane?.tunnel_id || alias.profile_path !== this.config.profile
        || profile.mcp?.server_urls?.length !== 1 || profile.mcp.server_urls[0].url !== this.config.target || profile.mcp.commands?.length
        || !profile.control_plane.api_key?.startsWith('file:') || !profile.health?.listen_addr?.startsWith('127.0.0.1:')) throw fail('TOPOLOGY_CHANGED');
    return { alias, p, profile };
  }
  async observe() {
    const { p, profile } = this.records();
    const recent = tunnelEvents(profile.log.file);
    const communication = recent.filter(e => ['poll-recovered', 'forwarded-to-mcp'].includes(e.action)).at(-1);
    const communicationEvidence = { at: communication?.at ?? null, source: 'bounded native log tail', state: communication && Date.now() - Date.parse(communication.at) < 120_000 ? 'recent-local-evidence' : 'unknown-or-expired' };
    const found = await this.host.inspect(this.config.bin, ['run', '--profile-dir', path.dirname(this.config.profile), '--profile', this.config.alias]);
    if (!found.length) {
      if (p?.pid && (await this.host.inspect(this.config.bin, [], p.pid)).length) return { running: true, owned: false, healthy: false, code: 'PID_CONFLICT' };
      return { running: false, owned: false, healthy: false, recentEvents: recent, communication: communicationEvidence };
    }
    if (found.length !== 1 || found[0].pid !== p?.pid || p?.target_value !== this.config.target || p?.tunnel_id !== profile.control_plane.tunnel_id) return { running: true, owned: false, healthy: false, code: 'NATIVE_RUNTIME_CONFLICT' };
    const actual = found[0];
    let owned = matches(actual, this.state.process);
    // Connect intent persisted before invoking official runtime survives a manager crash.
    if (!this.state.process && this.state.connectingAt && Date.parse(actual.created) >= this.state.connectingAt - 2000 && p.target_value === this.config.target) {
      this.state.process = actual; this.persist(); owned = true;
    }
    let base, result = { healthy: false, code: 'HEALTH_FAILED', controlPlane: { state: 'unknown' } };
    try {
      base = readFileSync(profile.health.url_file, 'utf8').trim();
      const u = new URL(base); if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:' || u.pathname !== '/') throw fail('NON_LOOPBACK_URL');
      const [health, ready, system, status] = await Promise.all([get(base + '/healthz'), get(base + '/readyz'), get(base + '/api/system'), get(base + '/api/status')]);
      // A reused health port must never be reported as this tunnel.
      if (status.json?.control_plane_tunnel_id !== profile.control_plane.tunnel_id) throw fail('HEALTH_IDENTITY_MISMATCH');
      result = tunnelHealth(health, ready, system.json);
    } catch { base = null; }
    return { running: true, owned, pid: actual.pid, created: actual.created, ...result, recentEvents: recent, communication: communicationEvidence,
      code: !owned ? 'OBSERVED_UNOWNED' : result.code, ui: base ? base + '/ui' : null };
  }
  async start() {
    const observation = await this.observe();
    if (observation.running) { if (observation.owned) return; throw fail(observation.code); }
    if (!existsSync(this.config.bin)) throw fail('PATH_MISSING');
    await this.verifyVersion();
    const { profile } = this.records();
    // Fixed v0.0.14 connect rewrites its generated profile. Refuse extra settings
    // rather than silently discard custom authentication/proxy/transport options.
    const expected = ['admin_ui', 'config_version', 'control_plane', 'health', 'log', 'mcp'];
    if (Object.keys(profile).some(k => !expected.includes(k)) || Object.keys(profile.control_plane).some(k => !['api_key', 'base_url', 'tunnel_id'].includes(k))
      || Object.keys(profile.mcp).some(k => k !== 'server_urls') || profile.admin_ui.open_browser !== false
      || Object.keys(profile.admin_ui).some(k => k !== 'open_browser') || profile.config_version !== 1
      || Object.keys(profile.mcp.server_urls[0]).some(k => !['channel', 'url'].includes(k)) || profile.mcp.server_urls[0].channel !== 'main'
      || profile.health.listen_addr !== '127.0.0.1:0' || profile.health.url_file !== path.join(this.config.stateRoot, 'health', this.config.alias + '.url')
      || Object.keys(profile.health).some(k => !['listen_addr', 'url_file'].includes(k))
      || profile.log.level !== 'info' || profile.log.format !== 'json' || profile.log.file !== path.join(this.config.stateRoot, 'logs', this.config.alias + '.log')
      || Object.keys(profile.log).some(k => !['level', 'format', 'file'].includes(k))) throw fail('PROFILE_REVIEW_REQUIRED');
    copyFileSync(this.config.profile, path.join(this.config.backupDir, `tunnel-profile-${Date.now()}.json`));
    this.state.process = null; this.state.connectingAt = Date.now(); this.persist();
    const result = await this.invoke(this.config.bin, ['runtimes', 'connect', '--alias', this.config.alias, '--profile', this.config.alias,
      '--profile-dir', path.dirname(this.config.profile), '--tunnel-id', profile.control_plane.tunnel_id,
      '--runtime-api-key', profile.control_plane.api_key, '--mcp-server-url', this.config.target, '--control-plane-base-url', profile.control_plane.base_url, '--json'], {
      cwd: path.dirname(this.config.bin), env: { ...process.env, TUNNEL_CLIENT_STATE_DIR: this.config.stateRoot }, timeout: 45_000, limit: 2 * 1024 * 1024,
    });
    this.events.add('tunnel', 'native-connect', result.code === 0 ? null : 'NATIVE_CONNECT_FAILED', result.code);
    if (result.code !== 0) throw fail('NATIVE_CONNECT_FAILED');
    await this.observe();
  }
  async stop() {
    const o = await this.observe();
    if (!o.running) return;
    if (!o.owned) throw fail('OBSERVED_UNOWNED');
    await this.verifyVersion();
    // Recheck both native metadata and OS creation identity immediately before
    // native stop (which, in 0.0.14, otherwise only trusts the saved PID).
    const { p } = this.records();
    if (p.pid !== o.pid || !matches((await this.host.inspect(this.config.bin, [], p.pid))[0], this.state.process)) throw fail('OWNERSHIP_CHANGED');
    const result = await this.invoke(this.config.bin, ['runtimes', 'stop', this.config.alias, '--json'], { cwd: path.dirname(this.config.bin), env: { ...process.env, TUNNEL_CLIENT_STATE_DIR: this.config.stateRoot }, timeout: 15_000, limit: 2 * 1024 * 1024 });
    if (result.code !== 0) throw fail('NATIVE_STOP_FAILED');
    if ((await this.host.inspect(this.config.bin, [], o.pid)).length) throw fail('STOP_TIMEOUT');
  }
}
