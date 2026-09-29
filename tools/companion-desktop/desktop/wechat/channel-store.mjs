import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const initial = () => ({ version: 3, binding: null, epoch: randomUUID(), boundAt: null, cursor: '', paused: true, seen: {} });
const keyFor = (epoch, id) => digest(JSON.stringify([epoch, id]));

/** Caller supplies OS protected seal/open and an installation-private file path. */
export class ChannelStore {
  constructor(file, crypto, state) { this.file = file; this.crypto = crypto; this.state = state; this.queue = Promise.resolve(); }
  static async load(file, crypto) {
    if (typeof crypto?.seal !== 'function' || typeof crypto?.open !== 'function') throw Error('Channel encryption port required');
    let state;
    try { state = JSON.parse(await crypto.open(await readFile(file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('Channel metadata unavailable'); state = initial(); }
    if (!state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen) || ![1, 2, 3].includes(state.version)) throw Error('Channel metadata invalid');
    if (state.version === 1) {
      // Preserve old claims as non-replayable; a new bind always creates a fresh epoch.
      state.legacyScope = state.scope;
      state.epoch = state.scope ?? randomUUID();
      state.version = 3;
    }
    if (state.version === 2) { state.version = 3; state.paused = true; }
    if (typeof state.epoch !== 'string' || !state.epoch) throw Error('Channel metadata invalid');
    return new ChannelStore(file, crypto, state);
  }
  snapshot() {
    return structuredClone({ version: this.state.version, epoch: this.state.epoch, boundAt: this.state.boundAt,
      binding: this.state.binding ? { configured: true } : null, paused: this.state.paused,
      claims: Object.fromEntries(Object.entries(this.state.seen).map(([key, claim]) => [key, { status: claim.status, delivery: claim.delivery }])) });
  }
  binding() { return this.state.binding ? structuredClone(this.state.binding) : null; }
  epoch() { return this.state.epoch; }
  boundAt() { return this.state.boundAt; }
  paused() { return this.state.paused; }
  lastDelivery() { return Object.values(this.state.seen).filter(row => row.epoch === this.state.epoch && row.delivery && row.delivery !== 'none').sort((a,b) => (b.claimedAt ?? 0) - (a.claimedAt ?? 0))[0]?.delivery ?? 'none'; }
  lastInputAt() { const at = Object.values(this.state.seen).reduce((latest,row) => row.epoch === this.state.epoch ? Math.max(latest,row.claimedAt ?? 0) : latest,0); return at ? new Date(at).toISOString() : null; }
  cursor() { return this.state.cursor; }
  record(id, epoch = this.state.epoch) {
    const legacy = epoch === this.state.epoch && this.state.legacyScope ? digest(`${this.state.legacyScope}\0${id}`) : null;
    return structuredClone(this.state.seen[keyFor(epoch, id)] ?? (legacy ? this.state.seen[legacy] : null) ?? null);
  }
  async change(update) {
    const job = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = update(next);
      if (result === false) return false;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(await this.crypto.seal(JSON.stringify(next)), 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
        this.state = next;
        return result;
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async bind(auth, at) {
    if (!auth || !auth.userId || !auth.botId || !auth.token || !auth.baseUrl || !Number.isSafeInteger(at)) throw Error('Invalid WeChat binding');
    return this.change(state => { state.binding = structuredClone(auth); state.boundAt = at; state.epoch = randomUUID(); state.paused = true; delete state.legacyScope; delete state.scope; state.cursor = ''; });
  }
  unresolvedClaims() { return Object.values(this.state.seen).filter(row => row.inboundId && ['pending','processing','unknown'].includes(row.status)).map(row => ({ id: row.inboundId, epoch: row.epoch })); }
  async unbind(expectedEpoch) { return this.change(state => { if (expectedEpoch && state.epoch !== expectedEpoch) return false; state.binding = null; state.boundAt = null; state.cursor = ''; state.paused = true; state.epoch = randomUUID(); }); }
  async setPaused(value, epoch = this.state.epoch) { return this.change(state => { if (state.epoch !== epoch || !state.binding) return false; state.paused = !!value; }); }
  async setCursor(cursor, epoch = this.state.epoch) {
    if (typeof cursor !== 'string' || cursor.length > 100000) throw Error('Invalid cursor');
    return this.change(state => { if (!state.binding || state.epoch !== epoch) return false; state.cursor = cursor; });
  }
  async claim(id, contextToken, { epoch = this.state.epoch, text, backendGeneration = null, at = Date.now() } = {}) {
    if (!this.state.binding || this.state.paused || typeof id !== 'string' || !id || id.length > 256 || typeof contextToken !== 'string' || !contextToken || contextToken.length > 8192 || typeof text !== 'string') return false;
    const key = keyFor(epoch, id), payloadDigest = digest(JSON.stringify({ text, contextToken }));
    return this.change(state => {
      if (state.epoch !== epoch || state.paused) return false;
      const legacyKey = state.legacyScope ? digest(`${state.legacyScope}\0${id}`) : null;
      if (legacyKey && state.seen[legacyKey]) return false;
      if (state.seen[key]) {
        if (state.seen[key].payloadDigest !== payloadDigest || state.seen[key].contextToken !== contextToken) throw Error('Inbound claim conflict');
        return false;
      }
      state.seen[key] = { status: 'pending', kind: 'text', inboundId: id, epoch, operationId: randomUUID(), payloadDigest, backendGeneration,
        recipient: state.binding.userId, contextToken, claimedAt: at, turnId: null, messageId: null, delivery: 'none', parts: [] };
      return true;
    });
  }
  async finish(id, epoch, update) {
    const key = keyFor(epoch, id);
    return this.change(state => {
      if (!state.seen[key]) return false;
      Object.assign(state.seen[key], update);
      return true;
    });
  }
}
