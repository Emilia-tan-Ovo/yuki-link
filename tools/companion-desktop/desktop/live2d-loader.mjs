export function initialLive2DReadiness() {
  return { implemented: false, codeReady: true, configured: false, resourcesVerified: false,
    sdkConfigured: false, sdkLoaded: false, modelLoaded: false, drawReady: false, mouthMapped: false, talkingReady: false, ready: false,
    sdk: { state: 'unconfigured', revision: null }, model: { state: 'unconfigured', revision: null },
    resourceId: null, revision: null, displayName: null, checkedAt: null, mouthCandidate: null,
    code: 'LIVE2D_UNCONFIGURED', missing: ['sdk', 'model', 'draw', 'mouth-mapping', 'talking-verification'] };
}

// Must run on dimensions before allocation/upload and again on decoded dimensions.
// The production decode/draw call site awaits a reviewed, legally supplied SDK.
export function checkTextureBudget(textures, maxTextureSize) {
  if (!Number.isInteger(maxTextureSize) || maxTextureSize <= 0 || !Array.isArray(textures) || !textures.length || textures.length > 32) throw Error('TEXTURE_BUDGET');
  let rgba = 0;
  for (const { width, height } of textures) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > maxTextureSize || height > maxTextureSize) throw Error('TEXTURE_BUDGET');
    rgba += width * height * 4;
    if (!Number.isSafeInteger(rgba) || rgba > 256 * 1024 * 1024) throw Error('TEXTURE_BUDGET');
  }
  return true;
}

// No reviewed Core/Framework/shader hashes or prepared ESM artifact are bundled.
// A candidate pack's own manifest is NOT a trust root. There is intentionally no
// import(config.path), external script tag, stub SDK or successful production path.
export class OptionalLive2D {
  constructor({ syntheticLoader = null } = {}) { this.syntheticLoader = syntheticLoader; this.epoch = 0; this.adapter = null; }
  async load(facts) {
    this.dispose(); const epoch = this.epoch;
    const result = { ...initialLive2DReadiness(), configured: facts?.configured === true, resourcesVerified: facts?.resourcesVerified === true };
    result.code = !result.configured ? 'LIVE2D_UNCONFIGURED' : !result.resourcesVerified ? 'MODEL_UNVERIFIED' : facts.sdkConfigured ? 'SDK_UNREVIEWED' : 'SDK_UNCONFIGURED';
    if (!this.syntheticLoader || !result.resourcesVerified || facts.sdkConfigured) return result;
    result.evidence = 'synthetic-code-wiring';
    try {
      const adapter = await this.syntheticLoader();
      if (epoch !== this.epoch) adapter?.dispose?.();
      else { this.adapter = adapter; result.syntheticAdapterConstructed = true; }
    } catch { result.code = 'SYNTHETIC_ADAPTER_FAILED'; }
    return result;
  }
  dispose() { ++this.epoch; const adapter = this.adapter; this.adapter = null; try { adapter?.dispose?.(); } catch {} }
}
