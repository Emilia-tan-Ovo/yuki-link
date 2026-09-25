import { sameVoiceScope, validRequestId } from './turn-contract.mjs';

export function normalizeMouth(value) {
  if (value === null || value === undefined) return null;
  const { parameterId, closed, open, gain = 1.9 } = value;
  if (typeof parameterId !== 'string' || !parameterId || /[\x00-\x1f]/.test(parameterId) || !Number.isFinite(closed) || !Number.isFinite(open) || closed === open || !Number.isFinite(gain) || gain <= 0 || gain > 4) throw Error('MOUTH_MAPPING_INVALID');
  if (Object.keys(value).some(key => !['parameterId', 'closed', 'open', 'gain'].includes(key))) throw Error('MOUTH_MAPPING_INVALID');
  return { parameterId, closed, open, gain };
}
const matches = (a, b) => !!a && !!b && sameVoiceScope(a.scope, b.scope) && a.requestId === b.requestId;

// Synthetic setters exercise this seam; only a real SDK adapter may supply
// actual model parameter bounds. Mapping alone never proves draw/talking ready.
export class Live2DMouth {
  constructor() { this.mapping = null; this.owner = null; this.setter = null; }
  map(config, parameters, setter) {
    this.dispose();
    try {
      const mapping = normalizeMouth(config);
      const found = parameters?.filter(p => p.id === mapping?.parameterId);
      if (!mapping || found?.length !== 1 || typeof setter !== 'function') return false;
      const p = found[0];
      if (!Number.isFinite(p.min) || !Number.isFinite(p.max) || p.min >= p.max || mapping.closed < p.min || mapping.closed > p.max || mapping.open < p.min || mapping.open > p.max) return false;
      this.mapping = mapping; this.setter = setter; this.close(); return true;
    } catch { this.mapping = null; this.setter = null; return false; }
  }
  close() {
    if (!this.mapping) return;
    try { this.setter(this.mapping.parameterId, this.mapping.closed); }
    catch { this.mapping = null; this.setter = null; this.owner = null; }
  }
  arm(owner) {
    this.reset();
    if (!owner?.scope || !sameVoiceScope(owner.scope, owner.scope) || !validRequestId(owner.requestId)) return;
    this.owner = { scope: { ...owner.scope }, requestId: owner.requestId, started: false };
  }
  started(owner) { if (matches(owner, this.owner)) this.owner.started = true; }
  amplitude({ scope, requestId, value }) {
    if (!this.mapping || !this.owner?.started || !matches({ scope, requestId }, this.owner)) return;
    const m = this.mapping;
    // Formula adapted from AAAAGENT cubism-renderer.mjs, commit
    // 2752349bcc7f7137b8b9e4ff9cccf34026d77aad; gain policy/bounds are Yuki's.
    const level = Number.isFinite(value) && value > 0 ? Math.min(1, m.gain * Math.sqrt(value)) : 0;
    try { this.setter(m.parameterId, m.closed + level * (m.open - m.closed)); }
    catch { this.dispose(); }
  }
  end(owner) { if (matches(owner, this.owner)) this.reset(); }
  reset() { this.owner = null; this.close(); }
  dispose() { this.reset(); this.mapping = null; this.setter = null; }
}
