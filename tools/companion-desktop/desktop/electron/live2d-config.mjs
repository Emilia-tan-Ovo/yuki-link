import { localRoot, resourcePath } from './live2d-resources.mjs';
import { normalizeMouth } from '../live2d-mouth.mjs';

export const DEFAULT_LIVE2D = Object.freeze({ schemaVersion: 1, model: null, sdk: null, mouth: null });
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function normalizeLive2D(value) {
  try {
    if (!keys(value, ['schemaVersion','model','sdk','mouth']) || value.schemaVersion !== 1) throw Error();
    let model = null, sdk = null;
    if (value.model != null) {
      const m = value.model;
      if (!keys(m, ['resourceId','root','entry','fingerprint']) || typeof m.resourceId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(m.resourceId) || !digest(m.fingerprint) || !resourcePath(m.entry).endsWith('.model3.json')) throw Error();
      model = { resourceId: m.resourceId, root: localRoot(m.root), entry: m.entry, fingerprint: m.fingerprint };
    }
    if (value.sdk != null) {
      const s = value.sdk;
      if (!keys(s, ['root','fingerprint','adapterApiVersion']) || s.adapterApiVersion !== 1 || !digest(s.fingerprint)) throw Error();
      // A persisted reference is only a candidate, never permission to execute JS.
      sdk = { root: localRoot(s.root), fingerprint: s.fingerprint, adapterApiVersion: 1 };
    }
    return { schemaVersion: 1, model, sdk, mouth: normalizeMouth(value.mouth) };
  } catch { throw Error('LIVE2D_CONFIG_INVALID'); }
}
