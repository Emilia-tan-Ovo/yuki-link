import { spawnDirect, readLines } from './process.js';
import { BridgeError } from './errors.js';

// Capability discovery is independent of session execution and contains no model table.
export class ModelCatalog {
  constructor(executable = 'codex', { ttlMs = 300_000, timeoutMs = 20_000 } = {}) {
    this.executable = executable;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.snapshot = null;
    this.refreshing = null;
  }

  async list(refresh = false) {
    if (!refresh && this.snapshot && Date.now() - Date.parse(this.snapshot.checked_at) < this.ttlMs) return structuredClone(this.snapshot);
    this.refreshing ??= this.discover().then(value => (this.snapshot = value)).finally(() => { this.refreshing = null; });
    return structuredClone(await this.refreshing);
  }

  async validate(model, reasoning) {
    const catalog = await this.list();
    const entry = catalog.models.find(candidate => candidate.model === model);
    if (!entry) throw new BridgeError('UNSUPPORTED_MODEL', 'Model is not advertised by this Codex installation.', { model, available_models: catalog.models.map(m => m.model) });
    if (!entry.reasoning.includes(reasoning)) throw new BridgeError('UNSUPPORTED_REASONING', 'Reasoning effort is not supported by this model.', { model, reasoning, supported_reasoning: entry.reasoning });
    return { model: entry.model, reasoning, capability_checked_at: catalog.checked_at };
  }

  async discover() {
    const child = spawnDirect(this.executable, ['app-server', '--stdio']);
    const pending = new Map();
    let nextId = 1;
    let finished = false;
    const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
    child.on('error', () => fail(new BridgeError('CAPABILITY_UNAVAILABLE', 'Cannot start the local Codex capability service.')));
    child.on('exit', () => { if (!finished) fail(new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex capability service exited early.')); });
    // Never expose startup diagnostics that may contain account/configuration details.
    child.stderr.resume();
    child.stdin.on('error', () => fail(new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex capability pipe closed.')));
    readLines(child.stdout, line => {
      try {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex rejected a capability request.'));
        else request.resolve(message.result);
      } catch { fail(new BridgeError('CAPABILITY_UNAVAILABLE', 'Invalid Codex capability JSON.')); }
    }, fail);
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const timer = setTimeout(() => { fail(new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex capability discovery timed out.')); child.kill(); }, this.timeoutMs);
    try {
      const initialized = await rpc('initialize', { clientInfo: { name: 'codex_session_bridge', version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const models = [];
      const cursors = new Set();
      let cursor;
      do {
        const page = await rpc('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page?.data)) throw new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex model directory has an unsupported shape.');
        for (const entry of page.data) {
          const efforts = entry.supportedReasoningEfforts?.map(option => option.reasoningEffort);
          if (typeof entry.model !== 'string' || !Array.isArray(efforts) || !efforts.length || efforts.some(e => typeof e !== 'string')) throw new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex did not advertise usable reasoning options.');
          models.push({ model: entry.model, name: entry.displayName, reasoning: efforts, default_reasoning: entry.defaultReasoningEffort });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex returned a repeated pagination cursor.');
        cursors.add(cursor);
      } while (cursor);
      if (!models.length) throw new BridgeError('CAPABILITY_UNAVAILABLE', 'Codex advertised no models.');
      return { source: 'codex app-server model/list', checked_at: new Date().toISOString(), user_agent: initialized?.userAgent ?? null, models };
    } finally {
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 2000);
      killTimer.unref();
      child.once('exit', () => clearTimeout(killTimer));
    }
  }
}
