import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateModelResources, readManifestFile } from './live2d-resources.mjs';
import { DEFAULT_LIVE2D } from './live2d-config.mjs';
import { initialLive2DReadiness } from '../live2d-loader.mjs';

const failure = code => Object.assign(Error(code), { code });
const safeCode = error => /^(RESOURCE_[A-Z_]+|MODEL_SCHEMA_INVALID|MODEL_JSON_INVALID|REFERENCE_TYPE_UNKNOWN|MOUTH_MAPPING_INVALID)$/.test(error?.code) ? error.code : 'RESOURCE_UNREADABLE';
export class Live2DResources {
  constructor({ settings, validate = validateModelResources }) { this.settings = settings; this.validate = validate; this.epoch = 0; this.manifest = null; this.checkedAt = null; this.error = null; }
  snapshot() {
    const config = this.settings.snapshot().live2d ?? DEFAULT_LIVE2D, result = initialLive2DReadiness();
    result.configured = !!config.model; result.sdkConfigured = !!config.sdk;
    result.sdk.state = config.sdk ? 'unreviewed' : 'unconfigured';
    if (config.model) {
      result.resourceId = config.model.resourceId;
      result.displayName = basename(config.model.entry).replace(/[\x00-\x1f]/g, '');
      result.resourcesVerified = this.manifest?.revision === config.model.fingerprint && this.manifest?.root === config.model.root && this.manifest?.entry === config.model.entry;
      result.revision = result.resourcesVerified ? this.manifest.revision : null;
      result.model = { state: result.resourcesVerified ? 'files-verified' : 'unverified', revision: result.revision };
      result.mouthCandidate = result.resourcesVerified ? this.manifest.mouthCandidate : null;
      if (result.resourcesVerified) result.summary = { fileCount: this.manifest.files.length, declarationCount: this.manifest.declarationCount, totalBytes: this.manifest.totalBytes, fingerprint: this.manifest.revision };
      result.checkedAt = this.checkedAt;
    }
    result.resourcesVerified = result.resourcesVerified === true;
    result.code = this.error ?? (!result.configured ? 'LIVE2D_UNCONFIGURED' : !result.resourcesVerified ? 'MODEL_UNVERIFIED' : result.sdkConfigured ? 'SDK_UNREVIEWED' : 'SDK_UNCONFIGURED');
    return result;
  }
  async select(file) {
    const epoch = ++this.epoch; this.manifest = null; this.error = null;
    try {
      const manifest = await this.validate({ root: dirname(file), entry: basename(file) });
      if (epoch !== this.epoch) return false;
      const config = { ...DEFAULT_LIVE2D, model: { resourceId: randomUUID(), root: manifest.root, entry: manifest.entry, fingerprint: manifest.revision } };
      try { await this.settings.saveLive2D(config); } catch { throw failure('LIVE2D_SAVE_FAILED'); }
      if (epoch !== this.epoch) return false;
      this.manifest = manifest; this.checkedAt = Date.now();
      return true;
    } catch (error) { if (epoch === this.epoch) this.error = error.code === 'LIVE2D_SAVE_FAILED' ? error.code : safeCode(error); throw failure(error.code === 'LIVE2D_SAVE_FAILED' ? error.code : safeCode(error)); }
  }
  async refresh() {
    const epoch = ++this.epoch, config = this.settings.snapshot().live2d;
    this.manifest = null; this.error = null;
    if (!config?.model) return;
    try {
      const m = config.model, manifest = await this.validate({ root: m.root, entry: m.entry, expectedRevision: m.fingerprint, mouth: config.mouth });
      if (epoch === this.epoch) { this.manifest = manifest; this.checkedAt = Date.now(); }
    } catch (error) { if (epoch === this.epoch) this.error = safeCode(error); }
  }
  async disable() {
    const epoch = ++this.epoch;
    try { await this.settings.saveLive2D(DEFAULT_LIVE2D); } catch { throw failure('LIVE2D_SAVE_FAILED'); }
    if (epoch === this.epoch) { this.manifest = null; this.error = null; this.checkedAt = null; }
  }
  invalidate() { ++this.epoch; this.manifest = null; this.error = null; this.checkedAt = null; }
  async read(resourceId, revision, name) {
    const epoch = this.epoch, config = this.settings.snapshot().live2d;
    if (!config?.model || config.model.resourceId !== resourceId || config.model.fingerprint !== revision || !this.manifest) throw failure('RESOURCE_REVOKED');
    try {
      const m = config.model, manifest = await this.validate({ root: m.root, entry: m.entry, expectedRevision: revision, mouth: config.mouth });
      if (epoch !== this.epoch) throw failure('RESOURCE_REVOKED');
      const bytes = await readManifestFile(manifest, name);
      if (epoch !== this.epoch) throw failure('RESOURCE_REVOKED');
      return bytes;
    } catch (error) { if (epoch === this.epoch) { this.manifest = null; this.error = safeCode(error); } throw failure(safeCode(error)); }
  }
}
