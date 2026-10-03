import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, saveJson, readJson, sleep } from './common.js';
import { acquireMutationLock } from './mutation-lock.js';
import { compatibleDeployment, deploymentTarget, selectDeployment, verifyDeployment } from './deployment.js';
import { assertCardCompatibility, inspectCardDatabase } from './database-compatibility.js';

const ids = ['yca', 'windowsMcp', 'tunnel', 'windowsTunnel'];
const stopOrder = [...ids].reverse();
const tunnelIds = new Set(['tunnel', 'windowsTunnel']);
const dependencies = { tunnel: 'yca', windowsTunnel: 'windowsMcp' };
const dependencyCodes = { tunnel: ['YCA_NOT_READY', 'YCA_RECOVERY_FAILED'], windowsTunnel: ['WINDOWS_MCP_NOT_READY', 'WINDOWS_MCP_RECOVERY_FAILED'] };
const freshUnit = () => ({ desired: 'stopped', attempts: [], nextAt: null, blocked: null, stableSince: null, lastFailure: null, ownership: {} });
const defaults = () => ({ version: 3, autoRecovery: true, confirmedTools: null, operations: {}, updateTransaction: null,
  units: Object.fromEntries(ids.map(id => [id, freshUnit()])) });
const recoverable = new Set(['STARTUP_TIMEOUT', 'HEALTH_FAILED', 'YCA_NOT_READY', 'MCP_NOT_READY', 'WINDOWS_MCP_NOT_READY',
  'SPAWN_FAILED', 'NATIVE_CONNECT_FAILED', 'ACTIVITY_UNKNOWN', 'ACTIVITY_UNKNOWN_OR_BUSY', 'YCA_RECOVERY_FAILED', 'WINDOWS_MCP_RECOVERY_FAILED']);
const retryDelays = [2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000];
const permanent = new Set(['VERSION_UNSUPPORTED', 'PATH_MISSING', 'PORT_CONFLICT', 'MULTIPLE_INSTANCES', 'ORPHAN_TASK_REVIEW', 'RUNTIME_LOCKED', 'TOPOLOGY_CHANGED', 'PROFILE_REVIEW_REQUIRED', 'PID_CONFLICT', 'NATIVE_RUNTIME_CONFLICT', 'STATE_UNREADABLE', 'AUTH_REQUIRED', 'OWNERSHIP_CHANGED', 'PROFILE_CHANGED', 'MCP_RESPONSE_INVALID', 'WINDOWS_MCP_PYTHON_PATH_MISSING', 'DB_STRUCTURE_INVALID', 'DB_COMPATIBLE_RELEASE_UNAVAILABLE', 'DB_CONTRACT_INVALID', 'DB_SCHEMA_UNSUPPORTED', 'ENGINEERING_CAPABILITY_UNAVAILABLE', 'LIVE_SUPERVISOR_OWNER']);
for (const code of ['CODEX_EXECUTABLE_UNAVAILABLE', 'NODE_PATH_MISSING', 'YCA_ENTRY_PATH_MISSING', 'PWSH_PATH_MISSING']) permanent.add(code);
const unknownOperation = error => Object.assign(error, { operationOutcome: 'unknown' });
const mutationScope = new AsyncLocalStorage();
const validActivity = activity => Boolean(activity && ['codex', 'computer', 'requests'].every(key => Number.isSafeInteger(activity[key]) && activity[key] >= 0));
const sameProcess = (a, b) => Boolean(a?.pid && a?.created && b?.pid === a.pid && b?.created === a.created);
const recoveredYcaStartup = (state, observation) => {
  if (state.desired !== 'running' || !['STARTUP_TIMEOUT', 'RECOVERY_BUDGET_EXHAUSTED'].includes(state.blocked) || !observation?.running
    || !observation.healthy || !observation.owned || observation.authenticated !== true || observation.code
    || !state.ownership?.instance || observation.instance !== state.ownership.instance
    || !sameProcess(observation, state.ownership.process) || !validActivity(observation.activity)) return false;
  const expected = state.ownership.deployment;
  if (!expected) return observation.deployment?.state === 'unmanaged';
  const running = observation.deployment?.running;
  return ['verified', 'update-pending'].includes(observation.deployment?.state)
    && running?.commit === expected.commit && running.dirty === false
    && observation.tools?.count === expected.tools?.count && observation.tools?.sha256 === expected.tools?.sha256;
};
const recoveredTunnelStartup = (state, observation) => Boolean(state.desired === 'running' && ['STARTUP_TIMEOUT', 'RECOVERY_BUDGET_EXHAUSTED'].includes(state.blocked)
  && observation?.running === true && observation.owned === true && observation.healthy === true && !observation.code
  && sameProcess(observation, state.ownership?.process));

export class Supervisor {
  constructor({ stateFile, events, createUnits, clock = Date.now, observeOnly = false, startupMs = 30_000, intervalMs = 5000,
    deploymentOps = { inspectCardDatabase, verifyDeployment, compatibleDeployment, deploymentTarget, selectDeployment } }) {
    Object.assign(this, { stateFile, events, clock, observeOnly, startupMs, intervalMs });
    this.deploymentOps = deploymentOps;
    this.state = readJson(stateFile, defaults());
    this.state.operations ??= {};
    this.state.updateTransaction ??= null;
    // Legacy versions could persist an exhausted budget forever. Resume with
    // a bounded cooldown while keeping the last failure for diagnosis.
    for (const s of Object.values(this.state.units ?? {})) if (s.blocked === 'RECOVERY_BUDGET_EXHAUSTED') {
      s.blocked = null; s.nextAt ??= clock() + retryDelays.at(-1);
    }
    if (![1, 2, 3].includes(this.state.version) || !this.state.units) throw fail('STATE_INVALID');
    const loadedVersion = this.state.version;
    if (loadedVersion < 3) {
      for (const id of ids) this.state.units[id] ??= freshUnit();
      if (loadedVersion === 1 && !observeOnly) this.state.autoRecovery = true;
      this.state.version = 3;
      if (!observeOnly) this.persist();
    }
    if (ids.some(id => !this.state.units?.[id] || !Array.isArray(this.state.units[id].attempts))) throw fail('STATE_INVALID');
    if (this.state.autoRecovery === false && ids.some(id => this.state.units[id].desired === 'running') && !observeOnly) {
      this.state.autoRecovery = true;
      this.persist();
    }
    this.units = createUnits(this.state, change => this.persist(change)); this.observations = {};
    this.tail = Promise.resolve(); this.lockTail = Promise.resolve();
    this.lastTick = clock(); this.busy = null; this.codex = { cli: '未检查', account: '未检查', inference: '未在此验证' };
    this.deploymentLatest = null;
  }
  persist({ expectedLeases = null, unitExit = null } = {}) {
    if (unitExit) {
      const scope = mutationScope.getStore();
      if (!scope?.active || scope.supervisor !== this) {
        if (this.closed) return;
        // The unit callback updated its local object before calling persist.
        // Restore the durable value until this event is verified and merged.
        const local = this.state.units[unitExit.id]?.ownership;
        try {
          if (local) local.lastExit = readJson(this.stateFile, defaults()).units?.[unitExit.id]?.ownership?.lastExit ?? null;
        } catch { return; }
        void this.serial(() => this.withMutationLock(async () => {
          if (this.closed) return;
          const durable = readJson(this.stateFile, defaults());
          const current = durable.units?.[unitExit.id]?.ownership;
          if (!current || current.process?.pid !== unitExit.process?.pid || current.process?.created !== unitExit.process?.created
            || (unitExit.instance && current.instance !== unitExit.instance)) return;
          current.lastExit = unitExit.lastExit;
          saveJson(this.stateFile, durable);
          if (local?.process?.pid === unitExit.process?.pid && local?.process?.created === unitExit.process?.created) {
            local.lastExit = unitExit.lastExit;
          }
        })).catch(error => { try { this.events.add('supervisor', 'check-failed', error.code ?? 'CHECK_FAILED'); } catch { /* closing */ } });
        return;
      }
    }
    const scope = mutationScope.getStore();
    // A callback inherited from a completed action cannot publish that old
    // snapshot. Exit callbacks pass unitExit and take the merge path above.
    if (scope?.supervisor === this && !scope.active) return;
    if (scope?.active) scope.lock.assertHeld();
    const durable = readJson(this.stateFile, null);
    for (const id of ids) {
      const latest = durable?.units?.[id]?.ownership?.lease ?? null;
      if (expectedLeases) {
        if (JSON.stringify(latest) !== JSON.stringify(expectedLeases[id] ?? null)) throw fail('LIVE_SUPERVISOR_OWNER');
      } else if (durable?.units?.[id]?.ownership) {
        // Unrelated state writes must not erase a lease acquired by another
        // supervisor after this instance loaded its state.
        this.state.units[id].ownership.lease = latest;
      }
    }
    saveJson(this.stateFile, this.state);
  }
  operation(id) { return this.state.operations[id] ?? null; }
  recordOperation(operation, outcome, code = null) {
    if (!operation) return;
    const existing = this.state.operations[operation.operationId];
    this.state.operations[operation.operationId] = {
      operationId: operation.operationId, action: operation.action, target: operation.target,
      phase: outcome === 'requested' ? 'inspect' : outcome, outcome: outcome === 'requested' ? 'running' : outcome,
      deadline: outcome === 'requested' ? this.clock() + 10 * 60_000 : existing?.deadline ?? null,
      desired: outcome === 'requested' ? null : existing?.desired ?? null,
      restartBefore: outcome === 'requested' ? null : existing?.restartBefore ?? null,
      code, updatedAt: this.clock(),
    };
    try { this.persist(); } catch (error) { throw unknownOperation(error); }
    try { this.events.addOperation(operation.operationId, operation.action, operation.target, outcome, code); }
    catch (error) { throw unknownOperation(error); }
  }
  operationPhase(operation, phase) {
    if (!operation) return;
    const current = this.state.operations[operation.operationId];
    if (current?.outcome !== 'running') return;
    current.phase = phase; current.updatedAt = this.clock(); this.persist();
  }
  serial(fn) {
    const action = this.tail.then(fn); this.tail = action.catch(() => {}); return action;
  }
  async withMutationLock(fn) {
    const held = mutationScope.getStore();
    if (held?.supervisor === this && held.active) { held.lock.assertHeld(); return fn(); }
    // This instance can receive a late callback while a previous scope is
    // still releasing. Queue it behind release rather than treating our own
    // reservation as a foreign owner.
    const previous = this.lockTail;
    let finish;
    this.lockTail = new Promise(resolve => { finish = resolve; });
    await previous;
    try {
      const lock = await acquireMutationLock(this.stateFile, this.units.yca.config?.pwsh, this.identity);
      const scope = { supervisor: this, lock, active: true };
      try {
        const result = await mutationScope.run(scope, fn);
        lock.assertHeld();
        return result;
      } finally { scope.active = false; await lock.release(); }
    } finally { finish(); }
  }
  async mutateUnit(id, method, ...args) {
    const held = mutationScope.getStore();
    if (held?.supervisor !== this) return this.withMutationLock(() => this.mutateUnit(id, method, ...args));
    held.lock.assertHeld();
    // This check lives at the unit call boundary. A caller's earlier snapshot
    // or preflight cannot authorize a later generation's mutation.
    await this.checkDurableLease(id);
    held.lock.assertHeld();
    const result = await this.units[id][method](...args);
    held.lock.assertHeld();
    return result;
  }
  async checkDurableLease(id) {
    mutationScope.getStore()?.lock.assertHeld();
    const durable = readJson(this.stateFile, defaults());
    const lease = durable.units?.[id]?.ownership?.lease ?? this.state.units[id].ownership?.lease;
    if (durable.units?.[id]?.ownership) this.state.units[id].ownership.lease = lease;
    if (!lease?.supervisorInstance || lease.supervisorInstance === this.identity?.instance) return;
    const owner = lease.supervisorProcess;
    if (!owner?.pid || !owner?.created) throw fail('LIVE_SUPERVISOR_OWNER');
    const host = this.units.yca.host;
    if (!host?.inspect) throw fail('LIVE_SUPERVISOR_OWNER');
    const found = (await host.inspect(this.units.yca.config.node, [], owner.pid))[0];
    if (found?.matches && found.created === owner.created) throw fail('LIVE_SUPERVISOR_OWNER');
  }
  async assertMutationLease(id) {
    return this.checkDurableLease(id);
  }
  async assertMutationLeases(affected) {
    for (const id of affected) await this.assertMutationLease(id);
  }
  async observe() {
    if (!this.observeOnly && mutationScope.getStore()?.supervisor !== this)
      return this.withMutationLock(() => this.observe());
    await Promise.all(ids.map(async id => {
      try { this.observations[id] = { ...await this.units[id].observe(), at: this.clock(), source: id === 'yca' ? 'OS + YCA loopback' : id === 'windowsMcp' ? 'OS + startup MCP probe' : 'native metadata + OS + loopback' }; }
      catch (e) { this.observations[id] = { running: null, healthy: false, code: e.code ?? 'OBSERVATION_FAILED', at: this.clock(), source: 'local observation failed' }; }
    }));
    if (!this.observeOnly) {
      let changed = false;
      const durable = readJson(this.stateFile, defaults());
      const expectedLeases = Object.fromEntries(ids.map(id => [id, durable.units?.[id]?.ownership?.lease ?? null]));
      for (const id of ids) {
        const o = this.observations[id], ownership = this.state.units[id].ownership;
        if (durable.units?.[id]?.ownership) ownership.lease = durable.units[id].ownership.lease ?? null;
        if (!o?.running || !o.owned || !o.pid || !o.created) continue;
        const lease = ownership.lease;
        if (lease?.supervisorInstance && lease.supervisorInstance !== this.identity?.instance && lease.supervisorProcess) {
          const old = (await this.units.yca.host.inspect(this.units.yca.config.node, [], lease.supervisorProcess.pid))[0];
          if (old?.matches && old.created === lease.supervisorProcess.created) {
            this.observations[id] = { ...o, owned: false, healthy: false, code: 'LIVE_SUPERVISOR_OWNER' };
            continue;
          }
        }
        if (lease?.process?.pid === o.pid && lease?.process?.created === o.created
          && lease.supervisorInstance === this.identity?.instance && lease.expiresAt > this.clock() + 15_000) continue;
        ownership.lease = { component: id, supervisorInstance: this.identity?.instance ?? null,
          supervisorPid: this.identity?.pid ?? null, supervisorProcess: this.identity?.process ?? null,
          configId: this.identity?.configId ?? null,
          process: { pid: o.pid, created: o.created }, deploymentCommit: o.deployment?.running?.commit ?? null,
          generation: lease?.process?.pid === o.pid && lease?.process?.created === o.created ? (lease.generation ?? 1) : (lease?.generation ?? 0) + 1,
          renewedAt: this.clock(), expiresAt: this.clock() + 60_000 };
        changed = true;
      }
      if (changed) this.persist({ expectedLeases });
    }
    let reconciled = false;
    if (recoveredYcaStartup(this.state.units.yca, this.observations.yca)) { this.state.units.yca.blocked = null; reconciled = true; }
    for (const id of ['tunnel', 'windowsTunnel']) if (recoveredTunnelStartup(this.state.units[id], this.observations[id])) { this.state.units[id].blocked = null; reconciled = true; }
    if (recoveredTunnelStartup(this.state.units.windowsMcp, this.observations.windowsMcp)) { this.state.units.windowsMcp.blocked = null; reconciled = true; }
    if (reconciled) this.persist();
  }
  snapshot() {
    const at = this.clock();
    const yca = this.observations.yca;
    const runningTools = yca?.running && yca.owned && at - yca.at <= this.intervalMs * 3 ? yca.tools : null;
    const units = Object.fromEntries(ids.map(id => {
      const o = this.observations[id] ?? {}; const s = this.state.units[id];
      const stale = !o.at || at - o.at > this.intervalMs * 3;
      let status = stale || o.running === null || o.running === undefined ? '未知' : !o.running ? (s.desired === 'running' ? '失败' : '已停止')
        : o.healthy ? (tunnelIds.has(id) && (o.controlPlane?.state !== 'healthy' || o.communication?.state !== 'recent-local-evidence') ? '降级' : '可用') : '降级';
      if (s.nextAt && !stale) status = '恢复中';
      if (this.busy?.endsWith('start') && this.busy.startsWith(id)) status = '启动中';
      const value = { ...o, status, stale, desired: s.desired, blocked: s.blocked, nextAt: s.nextAt,
        lease: s.ownership?.lease ?? null,
        progressDeadline: s.inFlightDeadline ?? null, failureClass: s.blocked && permanent.has(s.blocked) ? 'fatal' : s.blocked ? 'waiting' : o.healthy ? 'healthy' : 'recoverable',
        retries: s.attempts.length, failureReason: s.lastFailure ?? null };
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
      units, operations: Object.values(this.state.operations).slice(-20), updateTransaction: this.state.updateTransaction,
      codex: this.codex, chatgpt: { status: '未在此验证' }, tools: { running: runningTools ?? null,
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
      if (!o.owned && !o.managedIdentity) throw fail(o.code === 'ACTIVITY_UNKNOWN' ? 'ACTIVITY_UNKNOWN' : 'OBSERVED_UNOWNED');
      if (!o.owned && o.managedIdentity && recorded) return recorded;
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
    if (running?.running === null || running?.running === undefined) throw unknownOperation(fail('DEPLOYMENT_SWITCH_UNKNOWN'));
    if (running?.running) {
      const commit = running.deployment?.running?.commit ?? null;
      const recorded = this.state.units.yca.ownership?.deployment?.commit ?? null;
      const isPrevious = previous.wasRunning && running.owned && sameProcess(running, previous)
        && commit === previous.commit && recorded === previous.commit;
      if (isPrevious) {
        if (!running.healthy || (previous.toolsSha && running.tools?.sha256 !== previous.toolsSha)) throw fail('DEPLOYMENT_ROLLBACK_FAILED');
        return 'restored';
      }
      if (this.candidateVerified(running, candidate, prepared)) {
        await this.observe(); running = this.observations.yca;
        if (this.candidateVerified(running, candidate, prepared)) return 'switched';
      }
      const owned = this.state.units.yca.ownership;
      const candidateCommit = running.deployment?.running?.commit ?? null;
      const isCandidate = candidate?.instance && owned?.instance === candidate.instance && running.instance === candidate.instance
        && running.owned && running.authenticated === true && sameProcess(running, owned.process)
        && (!candidate.process || sameProcess(running, candidate.process)) && owned.deployment?.commit === prepared.commit;
      if (!isCandidate) {
        if (running.owned && candidateCommit && (candidateCommit !== prepared.commit || owned?.instance !== candidate?.instance
            || running.instance && running.instance !== candidate?.instance || candidate?.process && !sameProcess(running, candidate.process)))
          throw fail('DEPLOYMENT_ROLLBACK_CONFLICT');
        throw unknownOperation(fail('DEPLOYMENT_SWITCH_UNKNOWN'));
      }
      if (!validActivity(running.activity)) throw unknownOperation(fail('DEPLOYMENT_SWITCH_UNKNOWN'));
      this.busy = 'yca:rollback-stop'; await this.mutateUnit('yca', 'stop', confirm);
      await this.observe(); running = this.observations.yca;
      if (running?.running !== false) throw unknownOperation(fail('DEPLOYMENT_ROLLBACK_UNKNOWN'));
    }
    if (!previous.wasRunning) return 'restored';
    this.busy = 'yca:rollback-start'; await this.startOne('yca', { commit: previous.commit });
    await this.observe(); running = this.observations.yca;
    if (!running?.owned || !running.healthy || running.deployment?.running?.commit !== previous.commit
        || (previous.toolsSha && running.tools?.sha256 !== previous.toolsSha)) throw fail('DEPLOYMENT_ROLLBACK_FAILED');
    return 'restored';
  }
  updateDeployment(prepare, { restart = false, confirm = false, operation = null } = {}) { return this.serial(() => this.withMutationLock(async () => {
    await this.assertMutationLeases(restart ? ['yca', 'tunnel'] : ['yca']);
    this.recordOperation(operation, 'requested');
    let tx = null, initial = null, committed = false;
    try {
      if (this.observeOnly) throw fail('DEPLOYMENT_CONFIRMATION_REQUIRED');
      if (typeof prepare !== 'function') throw fail('INVALID_ACTION');
      if (this.state.updateTransaction) throw fail('DEPLOYMENT_SWITCH_UNKNOWN');
      if (restart) {
        for (const id of ['yca', 'tunnel']) {
          const state = this.state.units[id]; state.attempts = []; state.blocked = null; state.nextAt = this.clock(); state.fatalRecheckAt = null;
        }
        this.persist();
        await this.guardImpact(confirm);
        const current = this.observations.yca;
        initial = { commit: this.currentYcaCommit(), wasRunning: current?.running === true,
          pid: current?.pid ?? null, created: current?.created ?? null };
      }
      this.busy = 'yca:update-prepare';
      this.operationPhase(operation, 'prepare');
      await this.assertMutationLeases(restart ? ['yca', 'tunnel'] : ['yca']);
      const prepared = await prepare();
      this.deploymentLatest = { commit: prepared.commit, branch: prepared.branch, checkedAt: new Date(this.clock()).toISOString(), error: null, stale: false };
      this.events.add('yca', 'deployment-prepared');
      if (!restart) {
        await this.observe();
        this.recordOperation(operation, 'succeeded');
        return this.snapshot();
      }
      const config = this.units.yca.config;
      const database = this.deploymentOps.inspectCardDatabase(config.companionCardStore);
      const sealed = await this.deploymentOps.verifyDeployment(config.deploymentRoot, prepared.commit, config.node);
      if (sealed.tools && (sealed.tools.sha256 !== prepared.tools?.sha256 || sealed.tools.count !== prepared.tools?.count))
        throw fail('DEPLOYMENT_PROBE_FAILED');
      const candidate = { ...sealed, tools: sealed.tools ?? prepared.tools };
      assertCardCompatibility(candidate.databaseContract, database);
      const rollback = await this.deploymentOps.compatibleDeployment(config.deploymentRoot, config.companionCardStore,
        [initial.commit, this.state.lastKnownGood?.commit], config.node,
        { requiredVersion: candidate.databaseContract.migrationTarget, exclude: [prepared.commit] });
      await this.observe();
      const afterPrepare = this.observations.yca;
      if (!afterPrepare?.owned && afterPrepare?.running && !afterPrepare.managedIdentity) throw fail('OBSERVED_UNOWNED');
      await this.guardImpact(confirm);
      const afterCommit = this.currentYcaCommit();
      if (afterCommit !== initial.commit || (afterPrepare?.running === true) !== initial.wasRunning
        || initial.wasRunning && (afterPrepare.pid !== initial.pid || afterPrepare.created !== initial.created))
        throw fail('DEPLOYMENT_CURRENT_CHANGED');
      const previous = structuredClone(afterPrepare), previousCommit = afterCommit;
      // A candidate that could migrate the DB beyond every trusted rollback
      // reader is rejected before stopping a single old process.
      tx = {
        operationId: operation?.operationId ?? randomUUID(), phase: 'prepared', candidateCommit: prepared.commit,
        candidateInstance: randomUUID(), rollbackCommit: rollback.commit,
        previousCommit, previousProcess: previous?.running ? { pid: previous.pid, created: previous.created } : null,
        databaseVersionBefore: database.version,
        selectedCommitBefore: this.deploymentOps.deploymentTarget?.(config.deploymentRoot)?.commit ?? null,
        tunnelDesired: this.state.units.tunnel.desired, confirm, startedAt: this.clock(),
      };
      this.state.updateTransaction = tx;
      this.state.units.yca.desired = 'running'; this.persist();
      this.operationPhase(operation, 'stop-dependents');
      await this.observe();
      if (this.observations.tunnel?.running) { await this.assertMutationLease('tunnel'); await this.mutateUnit('tunnel', 'stop', confirm); }
      tx.phase = 'dependents-stopped'; this.persist();
      this.operationPhase(operation, 'stop-root');
      await this.guardImpact(confirm);
      const now = this.observations.yca;
      if (previous?.running && (now?.pid !== previous.pid || now?.created !== previous.created)) throw fail('DEPLOYMENT_CURRENT_CHANGED');
      if (now?.running) { await this.assertMutationLease('yca'); await this.mutateUnit('yca', 'stop', confirm, structuredClone(now)); }
      tx.phase = 'root-stopped'; this.persist();
      this.operationPhase(operation, 'start-candidate');
      await this.observe();
      await this.startOne('yca', { commit: prepared.commit, instance: tx.candidateInstance, exactCommit: true });
      tx.phase = 'candidate-running'; this.persist();
      this.operationPhase(operation, 'verify-candidate');
      await this.observe();
      if (!this.candidateVerified(this.observations.yca, tx, candidate)) throw fail('DEPLOYMENT_SWITCH_UNVERIFIED');
      await sleep(1000);
      await this.observe();
      if (!this.candidateVerified(this.observations.yca, tx, candidate)) throw fail('DEPLOYMENT_SWITCH_UNVERIFIED');
      assertCardCompatibility(candidate.databaseContract, this.deploymentOps.inspectCardDatabase(config.companionCardStore));
      tx.phase = 'candidate-verified'; this.persist();
      this.operationPhase(operation, 'commit-selection');
      await this.assertMutationLease('yca');
      await this.deploymentOps.selectDeployment(config.deploymentRoot, prepared.commit, config.node);
      tx.phase = 'selected'; this.persist();
      if (tx.tunnelDesired === 'running') await this.startOne('tunnel');
      await this.observe();
      if (!(this.observations.yca?.healthy && this.observations.yca.owned)
        || tx.tunnelDesired === 'running' && !(this.observations.tunnel?.healthy && this.observations.tunnel.owned))
        throw fail('DEPLOYMENT_SWITCH_UNVERIFIED');
      this.state.lastKnownGood = { commit: prepared.commit, at: this.clock() };
      tx.phase = 'succeeded'; this.state.updateTransaction = null; this.persist();
      committed = true;
      this.report('deployment-switched');
      this.recordOperation(operation, 'succeeded');
      return this.snapshot();
    } catch (error) {
      if (committed) throw unknownOperation(error);
      if (tx) {
        tx.rollbackFromPhase = tx.phase; tx.phase = 'rollback'; this.persist();
        try {
          await this.rollbackUpdate(tx);
          this.report('deployment-rolled-back');
        } catch (rollbackError) {
          this.state.units.yca.blocked = rollbackError.code ?? 'DEPLOYMENT_ROLLBACK_FAILED';
          this.report('deployment-rollback-failed', rollbackError.code ?? 'DEPLOYMENT_ROLLBACK_FAILED');
          this.recordOperation(operation, 'unknown', rollbackError.code ?? 'DEPLOYMENT_ROLLBACK_FAILED');
          throw unknownOperation(rollbackError);
        }
      }
      this.report('deployment-update-failed', error.code ?? 'ACTION_FAILED');
      this.recordOperation(operation, error.operationOutcome === 'unknown' ? 'unknown' : 'failed', error.code ?? 'ACTION_FAILED');
      throw error;
    } finally {
      this.busy = null; this.persist();
    }
  })); }
  async rollbackUpdate(tx) {
    if (mutationScope.getStore()?.supervisor !== this) return this.withMutationLock(() => this.rollbackUpdate(tx));
    if (await this.cancelPreparedUpdate(tx)) return;
    const config = this.units.yca.config;
    const rollback = await this.deploymentOps.verifyDeployment(config.deploymentRoot, tx.rollbackCommit, config.node);
    assertCardCompatibility(rollback.databaseContract, this.deploymentOps.inspectCardDatabase(config.companionCardStore));
    await this.observe();
    if (this.observations.tunnel?.running) { await this.assertMutationLease('tunnel'); await this.mutateUnit('tunnel', 'stop', tx.confirm); }
    await this.observe();
    const running = this.observations.yca;
    if (running?.running !== true && running?.running !== false)
      throw unknownOperation(fail('DEPLOYMENT_ROLLBACK_UNKNOWN'));
    if (running?.running) {
      const commit = running.deployment?.running?.commit;
      if (!(running.owned || running.managedIdentity)
        || ![tx.previousCommit, tx.candidateCommit, tx.rollbackCommit].includes(commit)) throw fail('DEPLOYMENT_ROLLBACK_CONFLICT');
      if (commit === tx.candidateCommit && (running.instance !== tx.candidateInstance
        || !sameProcess(running, this.state.units.yca.ownership.process))) throw fail('DEPLOYMENT_ROLLBACK_CONFLICT');
      if (commit === tx.previousCommit && tx.previousProcess && !sameProcess(running, tx.previousProcess)
        && running.instance !== tx.candidateInstance) throw fail('DEPLOYMENT_ROLLBACK_CONFLICT');
      if (commit !== tx.rollbackCommit || !running.healthy) {
        await this.assertMutationLease('yca'); await this.mutateUnit('yca', 'stop', tx.confirm, structuredClone(running));
      }
    }
    await this.observe();
    if (!(this.observations.yca?.healthy && this.observations.yca?.owned
      && this.observations.yca.deployment?.running?.commit === tx.rollbackCommit)) {
      await this.startOne('yca', { commit: tx.rollbackCommit, exactCommit: true });
    }
    await this.assertMutationLease('yca');
    await this.deploymentOps.selectDeployment(config.deploymentRoot, tx.rollbackCommit, config.node);
    if (tx.tunnelDesired === 'running') await this.startOne('tunnel');
    await this.observe();
    if (!(this.observations.yca?.healthy && this.observations.yca?.owned)
      || tx.tunnelDesired === 'running' && !(this.observations.tunnel?.healthy && this.observations.tunnel?.owned))
      throw fail('DEPLOYMENT_ROLLBACK_FAILED');
    tx.phase = 'rolled-back'; this.state.updateTransaction = null; this.persist();
  }
  async cancelPreparedUpdate(tx) {
    if (!(tx.phase === 'prepared' || tx.phase === 'rollback' && tx.rollbackFromPhase === 'prepared')
      || !tx.previousProcess || !tx.selectedCommitBefore) return false;
    const config = this.units.yca.config;
    await this.observe();
    const previous = this.observations.yca;
    if (!previous?.running || !previous.healthy || !previous.owned || previous.code
      || !sameProcess(previous, tx.previousProcess)
      || previous.deployment?.running?.commit !== tx.previousCommit) return false;
    const database = this.deploymentOps.inspectCardDatabase(config.companionCardStore);
    const selected = this.deploymentOps.deploymentTarget?.(config.deploymentRoot)?.commit ?? null;
    if (database.version !== tx.databaseVersionBefore || selected !== tx.selectedCommitBefore) return false;
    this.state.updateTransaction = null;
    this.persist();
    return true;
  }
  report(action, code = null) {
    try { this.events.add('yca', action, code); } catch { /* metadata does not change a verified switch */ }
  }
  candidateVerified(running, candidate, prepared) {
    const owned = this.state.units.yca.ownership;
    return Boolean(running?.running && running.healthy && running.owned && running.authenticated === true
      && candidate?.candidateInstance && running.instance === candidate.candidateInstance && owned?.instance === candidate.candidateInstance
      && sameProcess(running, owned.process) && (!candidate.process || sameProcess(running, candidate.process))
      && owned.deployment?.commit === prepared.commit && running.deployment?.running?.commit === prepared.commit
      && running.deployment.running.dirty === false && running.tools?.sha256 === prepared.tools?.sha256
      && running.tools?.count === prepared.tools?.count && validActivity(running.activity));
  }
  async startOne(id, options = {}) {
    if (mutationScope.getStore()?.supervisor !== this) return this.withMutationLock(() => this.startOne(id, options));
    const s = this.state.units[id]; this.busy = `${id}:start`;
    s.inFlightDeadline = this.clock() + this.startupMs + 5000; this.persist();
    try {
      const dependency = dependencies[id];
      if (dependency && !this.observations[dependency]?.healthy) throw fail(dependencyCodes[id][0]);
      await this.assertMutationLease(id);
      await this.mutateUnit(id, 'start', options);
      const startedInstance = id === 'yca' ? this.state.units.yca.ownership.instance : null;
      const deadline = this.clock() + this.startupMs;
      do {
        await this.observe();
        const o = this.observations[id];
        if (o.healthy && o.owned && !o.code) { s.blocked = null; return; }
        const pending = id === 'yca' && startedInstance && this.state.units.yca.ownership.instance === startedInstance
          && (o.running === false && !o.code || ['ACTIVITY_UNKNOWN', 'DEPLOYMENT_OBSERVATION_PENDING'].includes(o.code)
            && !o.authenticated);
        if (o.running && o.code === 'OBSERVED_UNOWNED' && !o.managedIdentity) throw fail('OBSERVED_UNOWNED');
        if (o.code && !pending && (permanent.has(o.code) || o.code.startsWith('DEPLOYMENT_'))) throw fail(o.code);
        await sleep(200);
      } while (this.clock() < deadline);
      // One final observation closes the race where readiness lands exactly as
      // the startup window expires. A verified healthy process must not be
      // reported as a permanent STARTUP_TIMEOUT.
      await this.observe();
      if (this.observations[id]?.healthy && this.observations[id]?.owned && !this.observations[id]?.code) { s.blocked = null; return; }
      throw fail('STARTUP_TIMEOUT');
    } finally { s.inFlightDeadline = null; this.persist(); this.busy = null; }
  }
  action(id, action, confirm = false, operation = null) {
    if (![...ids, 'all'].includes(id) || !['start', 'stop', 'restart', 'retry', 'recover'].includes(action)
      || action === 'recover' && id !== 'all') return Promise.reject(fail('INVALID_ACTION'));
    return this.serial(() => this.withMutationLock(async () => {
      if (this.observeOnly) {
        this.recordOperation(operation, 'requested');
        this.recordOperation(operation, 'failed', 'DEPLOYMENT_CONFIRMATION_REQUIRED');
        throw fail('DEPLOYMENT_CONFIRMATION_REQUIRED');
      }
      const requested = id === 'all' ? [...ids] : [id];
      const selected = new Set(requested);
      if (action === 'stop' || action === 'restart') for (const key of requested) {
        for (const [dependent, root] of Object.entries(dependencies)) if (root === key) selected.add(dependent);
      }
      if (action !== 'stop') for (const key of [...selected]) if (dependencies[key]) selected.add(dependencies[key]);
      const desiredBefore = Object.fromEntries(ids.map(key => [key, this.state.units[key].desired]));
      const affected = ids.filter(key => selected.has(key));
      await this.assertMutationLeases(affected);
      this.recordOperation(operation, 'requested');
      // Owner commands cancel cooldown before any safety/deployment preflight.
      for (const key of affected) {
        const s = this.state.units[key]; s.attempts = []; s.blocked = null; s.nextAt = this.clock(); s.inFlightDeadline = null; s.fatalRecheckAt = null;
        if (action === 'stop') s.desired = 'stopped';
        else s.desired = action === 'restart' && !requested.includes(key)
          ? desiredBefore[key] : 'running';
      }
      try { this.persist(); } catch (error) { throw unknownOperation(error); }
      if (operation) {
        this.state.operations[operation.operationId].desired = Object.fromEntries(affected.map(key => [key, this.state.units[key].desired]));
        this.persist();
      }
      let failure = null, restartCommit = null;
      let ycaPlan = null;
      const failed = new Map();
      try {
        await this.assertMutationLeases(affected);
        if (this.state.updateTransaction) await this.rollbackUpdate(this.state.updateTransaction);
        this.operationPhase(operation, 'inspect');
        await this.observe();
        if (['stop', 'restart'].includes(action) && affected.some(key => key === 'yca' || key === 'tunnel')) await this.guardImpact(confirm);
        if (action !== 'stop' && affected.includes('yca')) {
          const current = this.observations.yca;
          if (action === 'restart') restartCommit = current?.running
            ? this.currentYcaCommit() : this.state.units.yca.ownership?.deployment?.commit ?? null;
          if (action === 'restart' || !(current?.healthy && current.owned && !current.code)) {
            const commit = restartCommit ?? (current?.running ? this.currentYcaCommit()
              : this.state.units.yca.ownership?.deployment?.commit ?? null);
            ycaPlan = await this.units.yca.preflightStart?.({ commit });
          }
        }
        if (action === 'restart' && operation) {
          this.state.operations[operation.operationId].restartBefore = Object.fromEntries(affected.map(key => {
            const o = this.observations[key];
            return [key, { running: o?.running ?? null, pid: o?.pid ?? null, created: o?.created ?? null }];
          }));
          this.persist();
        }
        if (['stop', 'restart'].includes(action)) {
          const expectedYca = structuredClone(this.observations.yca);
          this.operationPhase(operation, 'stop-dependents');
          for (const key of stopOrder.filter(key => selected.has(key))) {
            if (Object.entries(dependencies).some(([dependent, root]) => root === key && failed.has(dependent))) {
              failed.set(key, fail('DEPENDENT_STOP_FAILED')); continue;
            }
            try {
              if (this.observations[key]?.running === false) continue;
              this.busy = `${key}:stop`; await this.assertMutationLease(key); await this.mutateUnit(key, 'stop', confirm, key === 'yca' ? expectedYca : null);
              this.events.add(key, 'stopped');
            } catch (error) { failed.set(key, error); }
          }
        }
        if (action !== 'stop') {
          this.operationPhase(operation, 'start-roots');
          for (const key of affected) {
            if (failed.has(key)) continue;
            if (dependencies[key] && failed.has(dependencies[key])) { failed.set(key, fail(dependencyCodes[key][0])); continue; }
            if (action === 'restart' && !requested.includes(key) && desiredBefore[key] !== 'running') continue;
            await this.observe();
            const o = this.observations[key];
            try {
              if (o?.healthy && o.owned && !o.code) continue;
              if (o?.running && !(o.healthy && o.owned && !o.code)) {
                if (!o.owned && !o.managedIdentity) throw fail(o.code ?? 'OBSERVED_UNOWNED');
                this.operationPhase(operation, 'cleanup');
                await this.assertMutationLease(key);
                await this.mutateUnit(key, 'stop', confirm, key === 'yca' ? structuredClone(o) : null);
                await this.observe();
                if (this.observations[key]?.running !== false) throw fail('STOP_OUTCOME_UNKNOWN');
              }
              const options = key === 'yca' ? { ...(restartCommit ? { commit: restartCommit } : {}), ...(ycaPlan ? { plan: ycaPlan } : {}) } : {};
              this.operationPhase(operation, dependencies[key] ? 'start-dependents' : 'start-roots');
              await this.startOne(key, options); this.events.add(key, 'started');
            } catch (error) {
              failed.set(key, error);
            }
          }
        }
        this.operationPhase(operation, 'verify');
        await this.observe();
        for (const key of affected) {
          const o = this.observations[key];
          if (!failed.has(key) && action === 'stop' && o?.running !== false) failed.set(key, fail('STOP_OUTCOME_UNKNOWN'));
          if (!failed.has(key) && action !== 'stop' && this.state.units[key].desired === 'running'
            && !(o?.healthy && o.owned && !o.code)) failed.set(key, fail(o?.code ?? 'HEALTH_FAILED'));
          if (!failed.has(key)) {
            this.state.units[key].blocked = null;
            this.state.units[key].nextAt = null;
            this.state.units[key].lastFailure = null;
          }
        }
        if (failed.size) throw failed.values().next().value;
      } catch (e) {
        if (!failed.size) for (const key of affected) failed.set(key, e);
        for (const [key, error] of failed) {
          this.state.units[key].blocked = error.code ?? 'ACTION_FAILED';
          this.state.units[key].lastFailure = error.code ?? 'ACTION_FAILED';
          if (permanent.has(error.code)) {
            this.state.units[key].nextAt = null;
            this.state.units[key].fatalRecheckAt = this.clock() + 60_000;
          } else if (this.state.units[key].desired === 'running') this.state.units[key].nextAt = this.clock() + this.intervalMs;
        }
        try { this.events.add(id, action, e.code ?? 'ACTION_FAILED'); }
        catch (eventError) { failure = unknownOperation(eventError); }
        failure ??= e;
      }
      try { this.busy = null; this.persist(); await this.observe(); }
      catch (finalizationError) { throw unknownOperation(finalizationError); }
      if (failure) {
        if (failure.operationOutcome === 'unknown') {
          this.recordOperation(operation, 'unknown', failure.code); throw failure;
        }
        this.recordOperation(operation, 'failed', failure.code ?? 'ACTION_FAILED');
        throw failure;
      }
      this.recordOperation(operation, 'succeeded');
      return this.snapshot();
    }));
  }
  setRecovery(enabled) { return this.serial(async () => {
    if (this.observeOnly) throw fail('DEPLOYMENT_CONFIRMATION_REQUIRED');
    if (typeof enabled !== 'boolean') throw fail('INVALID_ACTION');
    if (!enabled && ids.some(id => this.state.units[id].desired === 'running')) throw fail('RECOVERY_REQUIRED_FOR_RUNNING');
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
  reconcileStartup() { return this.serial(() => this.withMutationLock(async () => {
    await this.observe();
    if (this.observeOnly) return this.snapshot();
    const tx = this.state.updateTransaction;
    const txOperationId = tx?.operationId ?? null;
    if (tx) {
      const recorded = this.state.operations[tx.operationId];
      const operation = recorded ? { operationId: tx.operationId, action: recorded.action, target: recorded.target } : null;
      try {
        if (tx.phase === 'selected') {
          const candidate = await this.deploymentOps.verifyDeployment(this.units.yca.config.deploymentRoot, tx.candidateCommit, this.units.yca.config.node);
          if (this.candidateVerified(this.observations.yca, tx, candidate)) {
            if (tx.tunnelDesired === 'running') await this.startOne('tunnel');
            await this.observe();
            if (tx.tunnelDesired !== 'running' || this.observations.tunnel?.healthy && this.observations.tunnel?.owned) {
              this.state.lastKnownGood = { commit: tx.candidateCommit, at: this.clock() };
              this.state.updateTransaction = null; this.persist();
              this.recordOperation(operation, 'succeeded');
              this.reconcileOperations(txOperationId);
              return this.snapshot();
            }
          }
        }
        await this.rollbackUpdate(tx);
        this.recordOperation(operation, 'failed', 'DEPLOYMENT_INTERRUPTED');
      } catch (error) {
        tx.phase = 'recovery-needed'; tx.lastFailure = error.code ?? 'DEPLOYMENT_SWITCH_UNKNOWN'; this.persist();
        this.state.units.yca.blocked = tx.lastFailure;
        this.state.units.tunnel.blocked = tx.lastFailure;
        this.persist();
        this.recordOperation(operation, 'unknown', tx.lastFailure);
      }
    }
    this.reconcileOperations(txOperationId);
    return this.snapshot();
  })); }
  reconcileOperations(txOperationId = null) {
    for (const recorded of Object.values(this.state.operations)) {
      if (recorded.outcome !== 'running' || recorded.operationId === txOperationId) continue;
      const operation = { operationId: recorded.operationId, action: recorded.action, target: recorded.target };
      const desired = recorded.desired;
      const observed = desired && Object.entries(desired).map(([id, intent]) => ({ id, intent, observation: this.observations[id] }));
      let complete = observed?.length && observed.every(({ intent, observation }) => intent === 'stopped'
        ? observation?.running === false : observation?.healthy && observation.owned && !observation.code);
      if (complete && ['restart', 'restart-current'].includes(recorded.action)) {
        // A healthy old process already satisfies desired=running. Clean
        // restart needs a durable pre-stop witness and a different OS creation
        // identity after the stop/start phase reached verification.
        complete = recorded.phase === 'verify' && observed.every(({ id, intent, observation }) => {
          const before = recorded.restartBefore?.[id];
          if (!before || ![true, false].includes(before.running)) return false;
          if (intent === 'stopped') return observation.running === false;
          if (!observation.pid || !observation.created) return false;
          return before.running === false || before.pid && before.created && !sameProcess(observation, before);
        });
      }
      const fatal = observed?.some(({ id, observation }) => this.state.units[id]?.blocked && permanent.has(this.state.units[id].blocked)
        || observation?.code && permanent.has(observation.code));
      const expired = !Number.isFinite(recorded.deadline) || this.clock() >= recorded.deadline;
      if (complete) this.recordOperation(operation, 'succeeded');
      else if (fatal) {
        const failed = observed.find(({ id, observation }) => permanent.has(observation?.code)
          || permanent.has(this.state.units[id]?.blocked));
        this.recordOperation(operation, 'failed', permanent.has(failed.observation?.code)
          ? failed.observation.code : this.state.units[failed.id].blocked);
      }
      else this.recordOperation(operation, 'unknown', expired ? 'OPERATION_DEADLINE_EXCEEDED' : 'OPERATION_INTERRUPTED');
    }
  }
  tick() { return this.serial(() => this.withMutationLock(async () => {
    const at = this.clock();
    if (at - this.lastTick > this.intervalMs * 3) {
      this.events.add('supervisor', 'long-check-gap');
    }
    this.lastTick = at; await this.observe();
    if (this.observeOnly || !this.state.autoRecovery || this.state.updateTransaction) return;
    for (const id of ids) {
      const s = this.state.units[id], o = this.observations[id];
      if (s.desired !== 'running') continue;
      const dependency = dependencies[id];
      if (dependency && !(this.observations[dependency]?.healthy && this.observations[dependency]?.owned)) {
        s.stableSince = null;
        const [notReady] = dependencyCodes[id];
        s.blocked = notReady;
        s.lastFailure = this.observations[dependency]?.code ?? notReady;
        s.nextAt = Math.max(at + this.intervalMs, this.state.units[dependency].nextAt ?? at);
        continue;
      }
      if (o.healthy && o.owned && !o.code) {
        s.failures = 0; s.nextAt = null; s.stableSince ??= at;
        s.blocked = null;
        if (!s.blocked) s.lastFailure = null;
        if (id === 'yca' && o.deployment?.running?.commit && o.deployment.running.dirty === false
          && at - s.stableSince > 30_000 && this.state.lastKnownGood?.commit !== o.deployment.running.commit) {
          this.state.lastKnownGood = { commit: o.deployment.running.commit, at };
        }
        if (at - s.stableSince >= 600_000) s.attempts = [];
        continue;
      }
      s.stableSince = null;
      if (o.code && (permanent.has(o.code) || o.code.startsWith('DEPLOYMENT_') && o.code !== 'DEPLOYMENT_OBSERVATION_PENDING')) {
        s.blocked = o.code; s.lastFailure = o.code; s.nextAt = null; continue;
      }
      if (s.blocked && permanent.has(s.blocked)) {
        if (s.fatalRecheckAt && at < s.fatalRecheckAt && (!o.code || o.code === s.blocked)) continue;
        s.blocked = null; s.fatalRecheckAt = null;
      }
      if (dependency && dependencyCodes[id].includes(s.blocked)) s.blocked = null;
      if (s.inFlightDeadline) {
        if (at < s.inFlightDeadline) { s.nextAt = s.inFlightDeadline; continue; }
        s.inFlightDeadline = null;
      }
      if (o.running === null || o.running === undefined || o.running && !o.owned) {
        s.blocked = o.code ?? 'OBSERVATION_FAILED'; s.lastFailure = s.blocked; s.nextAt = at + this.intervalMs; continue;
      }
      if (tunnelIds.has(id) && o.running) {
        s.degradedSince ??= at;
        if (at - s.degradedSince < 120_000) {
          s.blocked = o.code ?? 'HEALTH_FAILED'; s.lastFailure = s.blocked; s.nextAt = at + 30_000; continue;
        }
      } else s.degradedSince = null;
      if (o.running) {
        s.failures = (s.failures ?? 0) + 1;
        if (s.failures < 3) { s.nextAt = at + this.intervalMs; continue; }
        if (id === 'yca' && (!validActivity(o.activity) || Object.values(o.activity).some(n => n > 0))) {
          s.blocked = 'ACTIVITY_UNKNOWN_OR_BUSY'; s.lastFailure = o.code ?? s.blocked;
          s.nextAt = at + this.intervalMs; continue;
        }
      }
      if (s.blocked === 'ACTIVITY_UNKNOWN_OR_BUSY') s.blocked = null;
      if (!s.nextAt) {
        s.nextAt = at + retryDelays[Math.min(s.attempts.length, retryDelays.length - 1)]; this.persist(); continue;
      }
      if (at < s.nextAt) continue;
      s.attempts.push(at); s.attempts = s.attempts.slice(-20); s.nextAt = at + retryDelays[Math.min(s.attempts.length, retryDelays.length - 1)]; this.persist();
      this.events.add(id, 'recovery-attempt', o.code ?? 'PROCESS_EXITED');
      try {
        await this.assertMutationLease(id);
        const commit = id === 'yca' ? this.state.units.yca.ownership?.deployment?.commit ?? null : null;
        const plan = id === 'yca' ? await this.units.yca.preflightStart?.({ recovery: true, commit }) : null;
        if (o.running) { await this.assertMutationLease(id); await this.mutateUnit(id, 'stop', false); }
        await this.startOne(id, { recovery: true, commit, ...(plan ? { plan } : {}) });
        s.blocked = null; s.lastFailure = null; s.failures = 0; s.nextAt = null; s.degradedSince = null;
      } catch (e) {
        s.lastFailure = e.code ?? 'RECOVERY_FAILED';
        s.blocked = e.code ?? 'RECOVERY_FAILED';
        if (permanent.has(e.code) || e.code?.startsWith('DEPLOYMENT_')) {
          s.nextAt = null; s.fatalRecheckAt = at + 60_000;
        }
        this.events.add(id, 'recovery-failed', s.lastFailure);
      }
    }
    this.persist();
  })); }
}
