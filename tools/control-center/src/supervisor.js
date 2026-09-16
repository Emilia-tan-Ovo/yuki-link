import { fail, saveJson, readJson, sleep } from './common.js';

const ids = ['yca', 'tunnel'];
const defaults = () => ({ version: 1, autoRecovery: false, confirmedTools: null, units: Object.fromEntries(ids.map(id => [id,
  { desired: 'stopped', attempts: [], nextAt: null, blocked: null, stableSince: null, ownership: {} }])) });
const permanent = new Set(['VERSION_UNSUPPORTED', 'PATH_MISSING', 'PORT_CONFLICT', 'LEGACY_RUNTIME_LOCK', 'ORPHAN_TASK_REVIEW', 'RUNTIME_LOCKED', 'OBSERVED_UNOWNED', 'TOPOLOGY_CHANGED', 'PROFILE_REVIEW_REQUIRED', 'PID_CONFLICT', 'NATIVE_RUNTIME_CONFLICT', 'STATE_UNREADABLE', 'ACTIVITY_UNKNOWN', 'AUTH_REQUIRED', 'STOP_TIMEOUT', 'OWNERSHIP_CHANGED']);

export class Supervisor {
  constructor({ stateFile, events, createUnits, clock = Date.now, observeOnly = false, startupMs = 30_000, intervalMs = 5000 }) {
    Object.assign(this, { stateFile, events, clock, observeOnly, startupMs, intervalMs });
    this.state = readJson(stateFile, defaults());
    if (this.state.version !== 1 || ids.some(id => !this.state.units?.[id] || !Array.isArray(this.state.units[id].attempts))) throw fail('STATE_INVALID');
    this.units = createUnits(this.state, () => this.persist()); this.observations = {}; this.tail = Promise.resolve();
    this.lastTick = clock(); this.graceUntil = 0; this.busy = null; this.codex = { cli: '未检查', account: '未检查', inference: '未在此验证' };
  }
  persist() { saveJson(this.stateFile, this.state); }
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
    return { at: new Date(at).toISOString(), versions: this.versions ?? {}, supervisor: this.identity ?? null, observeOnly: this.observeOnly, busy: this.busy, autoRecovery: this.state.autoRecovery,
      units: Object.fromEntries(ids.map(id => {
        const o = this.observations[id] ?? {}; const s = this.state.units[id];
        const stale = !o.at || at - o.at > this.intervalMs * 3;
        let status = stale || o.running === null || o.running === undefined ? '未知' : !o.running ? (s.desired === 'running' ? '失败' : '已停止')
          : o.healthy ? (id === 'tunnel' && (o.controlPlane?.state !== 'healthy' || o.communication?.state !== 'recent-local-evidence') ? '降级' : '可用') : '降级';
        if (s.nextAt && !stale) status = '恢复中';
        if (this.busy?.endsWith('start') && this.busy.startsWith(id)) status = '启动中';
        return [id, { ...o, status, stale, desired: s.desired, blocked: s.blocked, nextAt: s.nextAt, retries: s.attempts.length }];
      })), codex: this.codex, chatgpt: { status: '未在此验证' }, tools: { local: this.localTools ?? null, running: this.observations.yca?.tools ?? null,
        confirmed: this.state.confirmedTools, possibleRefresh: Boolean(this.state.confirmedTools && this.localTools && this.state.confirmedTools.sha256 !== this.localTools.sha256) }, events: this.events.items };
  }
  async guardImpact(confirm) {
    await this.observe();
    const o = this.observations.yca;
    if (o.running === false) return;
    if (!o.activity || Object.values(o.activity).some(n => n > 0)) {
      if (!confirm) throw fail(o.activity ? 'ACTIVE_TASKS' : 'ACTIVITY_UNKNOWN');
    }
  }
  async startOne(id) {
    const s = this.state.units[id]; this.busy = `${id}:start`;
    try {
      if (id === 'tunnel' && !this.observations.yca?.healthy) throw fail('YCA_NOT_READY');
      await this.units[id].start();
      const deadline = this.clock() + this.startupMs;
      do {
        await this.observe();
        const o = this.observations[id];
        if (o.healthy) { s.blocked = null; return; }
        if (o.code && permanent.has(o.code)) throw fail(o.code);
        await sleep(200);
      } while (this.clock() < deadline);
      throw fail('STARTUP_TIMEOUT');
    } finally { this.busy = null; }
  }
  action(id, action, confirm = false) {
    if (![...ids, 'all'].includes(id) || !['start', 'stop', 'restart', 'retry'].includes(action)) return Promise.reject(fail('INVALID_ACTION'));
    return this.serial(async () => {
      if (this.observeOnly) throw fail('DEPLOYMENT_CONFIRMATION_REQUIRED');
      const selected = id === 'all' ? ids : [id];
      const stopping = ['stop', 'restart'].includes(action);
      // User stop intent is durable even when stopping is blocked by task safety.
      if (stopping) { for (const key of selected) { this.state.units[key].desired = 'stopped'; this.state.units[key].nextAt = null; } this.persist(); }
      try {
        if (stopping) {
          await this.guardImpact(confirm);
          for (const key of [...selected].reverse()) { this.busy = `${key}:stop`; await this.units[key].stop(confirm); this.events.add(key, 'stopped'); }
        }
        if (action !== 'stop') {
          for (const key of selected) {
            const s = this.state.units[key]; s.desired = 'running'; s.blocked = null; s.nextAt = null;
            if (action === 'retry') s.attempts = []; this.persist();
            await this.observe(); await this.startOne(key); this.events.add(key, 'started');
          }
        }
      } catch (e) { for (const key of selected) this.state.units[key].blocked = e.code ?? 'ACTION_FAILED'; this.events.add(id, action, e.code ?? 'ACTION_FAILED'); throw e; }
      finally { this.busy = null; this.persist(); await this.observe(); }
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
    if (!this.localTools) throw fail('SCHEMA_UNAVAILABLE');
    this.state.confirmedTools = { ...this.localTools, at: new Date(this.clock()).toISOString(), source: '用户点击人工确认' }; this.persist();
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
      try { if (o.running) await this.units[id].stop(false); await this.startOne(id); }
      catch (e) { if (permanent.has(e.code)) s.blocked = e.code; this.events.add(id, 'recovery-failed', e.code ?? 'RECOVERY_FAILED'); }
    }
    this.persist();
  }); }
}
