import { randomUUID } from 'node:crypto';
import { fail, saveJson, readJson, sleep } from './common.js';

const ids = ['yca', 'tunnel'];
const defaults = () => ({ version: 1, autoRecovery: false, confirmedTools: null, units: Object.fromEntries(ids.map(id => [id,
  { desired: 'stopped', attempts: [], nextAt: null, blocked: null, stableSince: null, ownership: {} }])) });
const permanent = new Set(['VERSION_UNSUPPORTED', 'PATH_MISSING', 'PORT_CONFLICT', 'LEGACY_RUNTIME_LOCK', 'ORPHAN_TASK_REVIEW', 'RUNTIME_LOCKED', 'OBSERVED_UNOWNED', 'TOPOLOGY_CHANGED', 'PROFILE_REVIEW_REQUIRED', 'PID_CONFLICT', 'NATIVE_RUNTIME_CONFLICT', 'STATE_UNREADABLE', 'ACTIVITY_UNKNOWN', 'AUTH_REQUIRED', 'STOP_TIMEOUT', 'OWNERSHIP_CHANGED']);
for (const code of ['CODEX_EXECUTABLE_UNAVAILABLE', 'NODE_PATH_MISSING', 'YCA_ENTRY_PATH_MISSING', 'PWSH_PATH_MISSING']) permanent.add(code);
const unknownOperation = error => Object.assign(error, { operationOutcome: 'unknown' });

export class Supervisor {
  constructor({ stateFile, events, createUnits, clock = Date.now, observeOnly = false, startupMs = 30_000, intervalMs = 5000 }) {
    Object.assign(this, { stateFile, events, clock, observeOnly, startupMs, intervalMs });
    this.state = readJson(stateFile, defaults());
    if (this.state.version !== 1 || ids.some(id => !this.state.units?.[id] || !Array.isArray(this.state.units[id].attempts))) throw fail('STATE_INVALID');
    this.units = createUnits(this.state, () => this.persist()); this.observations = {}; this.tail = Promise.resolve();
    this.lastTick = clock(); this.graceUntil = 0; this.busy = null; this.codex = { cli: '未检查', account: '未检查', inference: '未在此验证' };
    this.deploymentLatest = null;
  }
  persist() { saveJson(this.stateFile, this.state); }
  recordOperation(operation, outcome, code = null) {
    if (!operation) return;
    try { this.events.addOperation(operation.operationId, operation.action, operation.target, outcome, code); }
    catch (error) { throw unknownOperation(error); }
  }
  serial(fn) {
    const action = this.tail.then(fn); this.tail = action.catch(() => {}); return action;
  }
  async observe() {
    await Promise.all(ids.map(async id => {
      try { this.observations[id] = { ...await this.units[id].observe(), at: this.clock(), source: id === 'yca' ? 'OS + YCA loopback' : 'native metadata + OS + loopback' }; }
      catch (e) { this.observations[id] = { running: null, healthy: false, code: e.code ?? 'OBSERVATION_FAILED', at: this.clock(), source: 'local observation failed' }; }
    }));
  }
  snapshot() {
    const at = this.clock();
    const yca = this.observations.yca;
    const runningTools = yca?.running && yca.owned && at - yca.at <= this.intervalMs * 3 ? yca.tools : null;
    const units = Object.fromEntries(ids.map(id => {
      const o = this.observations[id] ?? {}; const s = this.state.units[id];
      const stale = !o.at || at - o.at > this.intervalMs * 3;
      let status = stale || o.running === null || o.running === undefined ? '未知' : !o.running ? (s.desired === 'running' ? '失败' : '已停止')
        : o.healthy ? (id === 'tunnel' && (o.controlPlane?.state !== 'healthy' || o.communication?.state !== 'recent-local-evidence') ? '降级' : '可用') : '降级';
      if (s.nextAt && !stale) status = '恢复中';
      if (this.busy?.endsWith('start') && this.busy.startsWith(id)) status = '启动中';
      const value = { ...o, status, stale, desired: s.desired, blocked: s.blocked, nextAt: s.nextAt, retries: s.attempts.length };
      if (id === 'yca') {
        const deployment = { ...(o.deployment ?? {}) };
        if (this.deploymentLatest) deployment.latest = this.deploymentLatest;
        deployment.remoteDiffers = this.deploymentLatest?.commit && !this.deploymentLatest.stale && deployment.target?.commit
          ? this.deploymentLatest.commit !== deployment.target.commit : null;
        deployment.restartRequired = deployment.running?.commit && deployment.target?.commit
          ? deployment.running.commit !== deployment.target.commit : null;
        value.deployment = deployment;
      }
      return [id, value];
    }));
    return { at: new Date(at).toISOString(), versions: this.versions ?? {}, supervisor: this.identity ?? null, observeOnly: this.observeOnly, busy: this.busy, autoRecovery: this.state.autoRecovery,
      units, codex: this.codex, chatgpt: { status: '未在此验证' }, tools: { running: runningTools ?? null,
        confirmed: this.state.confirmedTools, possibleRefresh: Boolean(this.state.confirmedTools && runningTools && this.state.confirmedTools.sha256 !== runningTools.sha256) }, events: this.events.items };
  }
  async guardImpact(confirm) {
    await this.observe();
    const o = this.observations.yca;
    if (o.running === false) return;
    if (!o.activity || Object.values(o.activity).some(n => n > 0)) {
      if (!confirm) throw fail(o.activity ? 'ACTIVE_TASKS' : 'ACTIVITY_UNKNOWN');
    }
  }
  currentYcaCommit() {
    const o = this.observations.yca ?? {};
    const recorded = this.state.units.yca.ownership?.deployment?.commit ?? null;
    if (o.running) {
      if (!o.owned) throw fail('OBSERVED_UNOWNED');
      const running = o.deployment?.running?.commit ?? null;
      if (!running) {
        if (o.deployment?.state === 'unmanaged') return null;
        throw fail('DEPLOYMENT_CURRENT_UNKNOWN');
      }
      if (recorded && running !== recorded) throw fail('DEPLOYMENT_UNVERIFIED');
      return running;
    }
    if (recorded) return recorded;
    if (o.deployment?.state && o.deployment.state !== 'unmanaged') throw fail('DEPLOYMENT_CURRENT_UNKNOWN');
    return null;
  }
  checkDeployment(check, operation = null) { return this.serial(async () => {
    this.recordOperation(operation, 'requested');
    this.busy = 'yca:update-check';
    let failure = null;
    try {
      if (typeof check !== 'function') throw fail('INVALID_ACTION');
      const latest = await check();
      this.deploymentLatest = { ...latest, checkedAt: new Date(this.clock()).toISOString(), error: null, stale: false };
      this.events.add('yca', 'deployment-checked');
      await this.observe();
    } catch (e) {
      this.deploymentLatest = { ...(this.deploymentLatest ?? {}), checkedAt: new Date(this.clock()).toISOString(), error: e.code ?? 'DEPLOYMENT_CHECK_FAILED', stale: true };
      try { this.events.add('yca', 'deployment-check-failed', e.code ?? 'DEPLOYMENT_CHECK_FAILED'); }
      catch (eventError) { failure = unknownOperation(eventError); }
      failure ??= e;
    } finally { this.busy = null; }
    if (failure) {
      if (failure.operationOutcome === 'unknown') throw failure;
      this.recordOperation(operation, 'failed', failure.code ?? 'DEPLOYMENT_CHECK_FAILED');
      throw failure;
    }
    this.recordOperation(operation, 'succeeded');
    return this.snapshot();
  }); }
  async rollbackDeployment(previous, prepared, candidate, confirm) {
    await this.observe();
    let running = this.observations.yca;
    if (running?.running) {
      const commit = running.deployment?.running?.commit ?? null;
      const recorded = this.state.units.yca.ownership?.deployment?.commit ?? null;
      const isPrevious = running.owned && commit === previous.commit && recorded === previous.commit;
      if (isPrevious) {
        if (!previous.wasRunning) throw fail('DEPLOYMENT_ROLLBACK_CONFLICT');
        if (!running.healthy || (previous.toolsSha && running.tools?.sha256 !== previous.toolsSha)) throw fail('DEPLOYMENT_ROLLBACK_FAILED');
        this.events.add('yca', 'deployment-rolled-back');
        return;
      }
      const isCandidate = running.owned && commit === prepared.commit && recorded === prepared.commit
        && candidate?.instance && this.state.units.yca.ownership?.instance === candidate.instance;
      if (!isCandidate) throw fail('DEPLOYMENT_ROLLBACK_CONFLICT');
      this.busy = 'yca:rollback-stop'; await this.units.yca.stop(confirm);
      await this.observe(); running = this.observations.yca;
      if (running?.running) throw fail('DEPLOYMENT_ROLLBACK_FAILED');
    }
    if (!previous.wasRunning) { this.events.add('yca', 'deployment-rolled-back'); return; }
    this.busy = 'yca:rollback-start'; await this.startOne('yca', { commit: previous.commit });
    await this.observe(); running = this.observations.yca;
    if (!running?.healthy || running.deployment?.running?.commit !== previous.commit
        || (previous.toolsSha && running.tools?.sha256 !== previous.toolsSha)) throw fail('DEPLOYMENT_ROLLBACK_FAILED');
    this.events.add('yca', 'deployment-rolled-back');
  }
  updateDeployment(prepare, { restart = false, confirm = false, operation = null } = {}) { return this.serial(async () => {
    this.recordOperation(operation, 'requested');
    let previous = null, prepared = null, candidate = null, rollbackEligible = false;
    let failure = null;
    try {
      if (this.observeOnly) throw fail('DEPLOYMENT_CONFIRMATION_REQUIRED');
      if (typeof prepare !== 'function') throw fail('INVALID_ACTION');
      if (restart) {
        await this.guardImpact(confirm);
        const o = this.observations.yca;
        const commit = this.currentYcaCommit();
        previous = { commit, wasRunning: o?.running === true, pid: o?.pid ?? null, created: o?.created ?? null,
          toolsSha: o?.tools?.sha256 ?? this.state.units.yca.ownership?.deployment?.tools?.sha256 ?? null };
        if (previous.wasRunning && !previous.commit) throw fail('DEPLOYMENT_CURRENT_UNKNOWN');
      }
      this.busy = 'yca:update-prepare';
      prepared = await prepare();
      this.deploymentLatest = { commit: prepared.commit, branch: prepared.branch, checkedAt: new Date(this.clock()).toISOString(), error: null, stale: false };
      this.events.add('yca', 'deployment-prepared');
      await this.observe();
      if (restart) {
        // Preparation can take time. Re-check activity, ownership, release and process identity immediately before stopping.
        await this.guardImpact(confirm);
        const current = this.currentYcaCommit(), o = this.observations.yca;
        if (current !== previous.commit || (o?.running === true) !== previous.wasRunning
            || (previous.wasRunning && ((o?.pid ?? null) !== previous.pid || (o?.created ?? null) !== previous.created))) throw fail('DEPLOYMENT_CURRENT_CHANGED');
        const s = this.state.units.yca; s.desired = 'running'; s.blocked = null; s.nextAt = null; this.persist();
        if (previous.wasRunning) {
          this.busy = 'yca:update-stop'; await this.units.yca.stop(confirm); rollbackEligible = true; this.events.add('yca', 'update-stopped-old');
        } else rollbackEligible = true;
        candidate = { commit: prepared.commit, instance: randomUUID() };
        this.busy = 'yca:update-start'; await this.observe(); await this.startOne('yca', { commit: prepared.commit, instance: candidate.instance });
        await this.observe();
        const running = this.observations.yca;
        if (!running?.healthy || running.deployment?.running?.commit !== prepared.commit || running.tools?.sha256 !== prepared.tools?.sha256) throw fail('DEPLOYMENT_SWITCH_UNVERIFIED');
        this.events.add('yca', 'deployment-switched');
      }
    } catch (e) {
      let rollbackError = null;
      let reportingError = null;
      if (rollbackEligible && previous?.commit && prepared?.commit) {
        try { await this.rollbackDeployment(previous, prepared, candidate, confirm); }
        catch (rollback) {
          rollbackError = rollback;
          this.state.units.yca.blocked = rollback.code ?? 'DEPLOYMENT_ROLLBACK_FAILED';
          try { this.events.add('yca', 'deployment-rollback-failed', rollback.code ?? 'DEPLOYMENT_ROLLBACK_FAILED'); }
          catch (eventError) { reportingError = unknownOperation(eventError); }
        }
      }
      try { this.events.add('yca', 'deployment-update-failed', e.code ?? 'ACTION_FAILED'); }
      catch (eventError) { reportingError ??= unknownOperation(eventError); }
      failure = reportingError ?? (rollbackError ? fail(rollbackError.code ?? 'DEPLOYMENT_ROLLBACK_FAILED') : e);
    }
    try { this.busy = null; this.persist(); await this.observe(); }
    catch (finalizationError) { throw unknownOperation(finalizationError); }
    if (failure) {
      if (failure.operationOutcome === 'unknown') throw failure;
      this.recordOperation(operation, 'failed', failure.code ?? 'ACTION_FAILED');
      throw failure;
    }
    this.recordOperation(operation, 'succeeded');
    return this.snapshot();
  }); }
  async startOne(id, options = {}) {
    const s = this.state.units[id]; this.busy = `${id}:start`;
    try {
      if (id === 'tunnel' && !this.observations.yca?.healthy) throw fail('YCA_NOT_READY');
      await this.units[id].start(options);
      const deadline = this.clock() + this.startupMs;
      do {
        await this.observe();
        const o = this.observations[id];
        if (o.healthy) { s.blocked = null; return; }
        if (o.code && (permanent.has(o.code) || o.code.startsWith('DEPLOYMENT_'))) throw fail(o.code);
        await sleep(200);
      } while (this.clock() < deadline);
      throw fail('STARTUP_TIMEOUT');
    } finally { this.busy = null; }
  }
  action(id, action, confirm = false, operation = null) {
    if (![...ids, 'all'].includes(id) || !['start', 'stop', 'restart', 'retry'].includes(action)) return Promise.reject(fail('INVALID_ACTION'));
    return this.serial(async () => {
      this.recordOperation(operation, 'requested');
      if (this.observeOnly) {
        this.recordOperation(operation, 'failed', 'DEPLOYMENT_CONFIRMATION_REQUIRED');
        throw fail('DEPLOYMENT_CONFIRMATION_REQUIRED');
      }
      const selected = id === 'all' ? ids : [id];
      const stopping = ['stop', 'restart'].includes(action);
      let restartCommit = null;
      // User stop intent is durable even when stopping is blocked by task safety.
      if (stopping) { for (const key of selected) { this.state.units[key].desired = 'stopped'; this.state.units[key].nextAt = null; } this.persist(); }
      let failure = null;
      try {
        if (stopping) {
          await this.guardImpact(confirm);
          if (action === 'restart' && selected.includes('yca')) restartCommit = this.currentYcaCommit();
          for (const key of [...selected].reverse()) { this.busy = `${key}:stop`; await this.units[key].stop(confirm); this.events.add(key, 'stopped'); }
        }
        if (action !== 'stop') {
          for (const key of selected) {
            const s = this.state.units[key]; s.desired = 'running'; s.blocked = null; s.nextAt = null;
            if (action === 'retry') s.attempts = []; this.persist();
            await this.observe();
            let options = {};
            if (key === 'yca' && action === 'restart' && restartCommit) options = { commit: restartCommit };
            if (key === 'yca' && action === 'retry') {
              const commit = this.currentYcaCommit();
              if (commit) options = { commit };
            }
            await this.startOne(key, options); this.events.add(key, 'started');
          }
        }
      } catch (e) {
        for (const key of selected) this.state.units[key].blocked = e.code ?? 'ACTION_FAILED';
        try { this.events.add(id, action, e.code ?? 'ACTION_FAILED'); }
        catch (eventError) { failure = unknownOperation(eventError); }
        failure ??= e;
      }
      try { this.busy = null; this.persist(); await this.observe(); }
      catch (finalizationError) { throw unknownOperation(finalizationError); }
      if (failure) {
        if (failure.operationOutcome === 'unknown') throw failure;
        this.recordOperation(operation, 'failed', failure.code ?? 'ACTION_FAILED');
        throw failure;
      }
      this.recordOperation(operation, 'succeeded');
      return this.snapshot();
    });
  }
  setRecovery(enabled) { return this.serial(async () => {
    if (this.observeOnly) throw fail('DEPLOYMENT_CONFIRMATION_REQUIRED');
    if (typeof enabled !== 'boolean') throw fail('INVALID_ACTION');
    this.state.autoRecovery = enabled;
    if (!enabled) for (const s of Object.values(this.state.units)) s.nextAt = null;
    this.persist(); return this.snapshot();
  }); }
  confirmTools() { return this.serial(async () => {
    // This records the user's explicit manual check, never inspects ChatGPT cache.
    const tools = this.snapshot().tools.running;
    if (!tools) throw fail('SCHEMA_UNAVAILABLE');
    this.state.confirmedTools = { ...tools, at: new Date(this.clock()).toISOString(), source: '用户点击人工确认' }; this.persist();
  }); }
  tick() { return this.serial(async () => {
    const at = this.clock();
    if (at - this.lastTick > this.intervalMs * 3) {
      this.graceUntil = at + 30_000;
      for (const s of Object.values(this.state.units)) { s.failures = 0; if (s.nextAt) s.nextAt = this.graceUntil; }
      this.events.add('supervisor', 'long-check-gap');
    }
    this.lastTick = at; await this.observe();
    if (this.observeOnly || !this.state.autoRecovery) return;
    for (const id of ids) {
      const s = this.state.units[id], o = this.observations[id];
      if (s.desired !== 'running' || s.blocked) continue;
      if (o.healthy) {
        s.failures = 0; s.nextAt = null; s.stableSince ??= at;
        if (at - s.stableSince >= 600_000) s.attempts = [];
        continue;
      }
      s.stableSince = null;
      if (at < this.graceUntil) continue;
      // A live tunnel owns its network retries. No restart for auth/network
      // faults, unknown observations, or tasks of unknown activity.
      if (o.running === null || o.running === undefined || (o.running && !o.owned)) continue;
      if (id === 'tunnel' && o.running) continue;
      if (o.code?.startsWith('DEPLOYMENT_')) { s.blocked = o.code; continue; }
      if (o.running) {
        s.failures = (s.failures ?? 0) + 1;
        if (s.failures < 3) continue;
        if (!o.activity || Object.values(o.activity).some(n => n > 0)) { s.blocked = 'ACTIVITY_UNKNOWN_OR_BUSY'; continue; }
      }
      if (id === 'tunnel' && !this.observations.yca?.healthy) continue;
      if (!s.nextAt) {
        if (s.attempts.filter(t => at - t < 600_000).length >= 5) { s.blocked = 'RECOVERY_BUDGET_EXHAUSTED'; this.events.add(id, 'recovery-paused', s.blocked); continue; }
        s.nextAt = at + [2000, 5000, 10_000, 30_000][Math.min(s.attempts.length, 3)]; this.persist(); continue;
      }
      if (at < s.nextAt) continue;
      s.attempts.push(at); s.attempts = s.attempts.slice(-5); s.nextAt = null; this.persist();
      this.events.add(id, 'recovery-attempt', o.code ?? 'PROCESS_EXITED');
      try { if (o.running) await this.units[id].stop(false); await this.startOne(id, { recovery: true, commit: id === 'yca' ? this.state.units.yca.ownership?.deployment?.commit ?? null : null }); }
      catch (e) { if (permanent.has(e.code) || e.code?.startsWith('DEPLOYMENT_')) s.blocked = e.code; this.events.add(id, 'recovery-failed', e.code ?? 'RECOVERY_FAILED'); }
    }
    this.persist();
  }); }
}
