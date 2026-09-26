import { Live2DMouth } from './live2d-mouth.mjs';
import { OptionalLive2D, initialLive2DReadiness } from './live2d-loader.mjs';

const explanations = { RESOURCE_MISSING: '模型引用文件缺失', RESOURCE_REPARSE: '资源包含不支持的重解析路径', RESOURCE_CHANGED: '资源已变更，请重新选择确认', RESOURCE_BUDGET: '资源超出本地安全预算', RESOURCE_PATH_INVALID: '模型引用路径无效', RESOURCE_FILE_TYPE: '模型引用不是普通文件', RESOURCE_INSPECTION_UNAVAILABLE: '本机资源安全检查不可用', MODEL_JSON_INVALID: '模型 JSON 无效', MODEL_SCHEMA_INVALID: '模型清单结构不支持', REFERENCE_TYPE_UNKNOWN: '模型包含未知引用类型', LIVE2D_SAVE_FAILED: '配置未能保存，原配置保留', WEBGL_CONTEXT_LOST: '绘图上下文已失效' };
export class RendererLive2D {
  constructor({ host, element, mouth = new Live2DMouth(), loader = new OptionalLive2D() }) {
    Object.assign(this, { host, element, mouth, loader }); this.facts = initialLive2DReadiness();
    for (const action of ['select','refresh','disable']) element('live2d-' + action).onclick = () => host.send('live2d-' + action);
    element('live2d-canvas').addEventListener('webglcontextlost', event => { event.preventDefault(); this.dispose(); this.facts = { ...this.facts, code: 'WEBGL_CONTEXT_LOST' }; this.render(); host.send('live2d-reset'); });
    globalThis.addEventListener?.('beforeunload', () => this.dispose()); this.render();
  }
  playback(event) {
    if (event.type === 'armed') this.mouth.arm(event);
    else if (event.type === 'started') this.mouth.started(event);
    else if (event.type === 'amplitude') this.mouth.amplitude(event);
    else if (['ended','error'].includes(event.type)) this.mouth.end(event);
    else this.mouth.reset();
  }
  receive(message) {
    if (['connection','disconnected'].includes(message.type)) this.dispose();
    if (message.type !== 'live2d-settings') return;
    this.dispose(); this.facts = message.readiness ?? initialLive2DReadiness();
    // This production loader only reports pending. No selected path is imported.
    void this.loader.load(this.facts); this.render();
  }
  render() {
    const f = this.facts, status = this.element('live2d-status');
    const name = typeof f.displayName === 'string' ? f.displayName.split(/[\\/]/).at(-1).replace(/[\x00-\x1f]/g, '') : '';
    const model = !f.configured ? '模型未配置' : f.resourcesVerified ? '模型文件已校验；实际加载待验证' : '模型文件待校验';
    const sdk = f.sdkConfigured ? 'SDK 来源/版本待核对，尚未加载' : 'SDK 未配置（未随包提供）';
    const error = f.code !== 'MODEL_UNVERIFIED' && (f.code?.startsWith('RESOURCE_') || f.code?.startsWith('MODEL_') || explanations[f.code]) ? (explanations[f.code] ?? '资源未通过校验') : '';
    status.textContent = `资源检查与口型接线已实现；Cubism 实际适配待资源。${name ? name + '：' : ''}${model}；${sdk}。绘制、嘴型映射、实际说话：待验证。${error ? error + '。' : ''}文字和语音保持独立可用。`;
    status.dataset.ready = 'false'; this.element('live2d-canvas').hidden = true;
    this.element('live2d-disable').disabled = !f.configured && !f.sdkConfigured;
    this.element('live2d-refresh').disabled = !f.configured;
  }
  dispose() { this.mouth.dispose(); this.loader.dispose(); }
}
