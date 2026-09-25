import { sameVoiceScope, validRequestId } from '../desktop/turn-contract.mjs';
import { inspectPcmWav, CAPTURE_LIMITS } from '../desktop/media/wav.mjs';
import { createVoiceProvider, VoiceError } from './voice-provider.mjs';
// Controllers only own provider resources; admission/cancel ownership remains main's coordinator.
export class WorkerVoice {
  constructor({ config, key, preview, post, createVoice = createVoiceProvider }) {
    this.post = post; this.active = null;
    try { this.provider = !preview && config?.enabled ? createVoice({ config, key }) : null; } catch { this.provider = null; }
  }
  close() { this.active?.controller.abort(); this.active = null; }
  bindSubmit(data) { if (data.origin === 'voice-final' && sameVoiceScope(data.voiceScope, this.active?.scope) && !this.active.controller.signal.aborted && !this.active.requestId) this.active.requestId = data.requestId; }
  async handle(data, session) {
    if (data.type === 'voice-start') {
      if (!data.scope || data.scope.connectionGeneration !== data.generation || !validRequestId(data.scope.requestId)) return;
      this.close(); this.active = { scope: data.scope, controller: new AbortController(), asr: false, tts: false }; return;
    }
    const a = this.active;
    if (!a || !sameVoiceScope(a.scope, data.scope) || a.controller.signal.aborted) { data.wav?.fill(0); return; }
    if (data.type === 'voice-stop') { this.close(); return; }
    const stage = data.type === 'voice-asr' ? 'asr' : 'tts';
    if (stage === 'asr' && (a.asr || data.requestId !== a.scope.requestId) || stage === 'tts' && (a.tts || data.requestId !== a.requestId)) { data.wav?.fill(0); return; }
    const projection = stage === 'tts' ? session.mediaText(data.requestId) : null;
    if (stage === 'tts' && !projection) return;
    a[stage] = true;
    const current = () => this.active === a && !a.controller.signal.aborted;
    const identity = { generation: data.generation, scope: a.scope, requestId: data.requestId, stage };
    try {
      if (!this.provider) throw new VoiceError(stage, 'UNCONFIGURED');
      if (stage === 'asr') {
        inspectPcmWav(data.wav, CAPTURE_LIMITS);
        const result = await this.provider.transcribe({ scope: a.scope, wav: data.wav }, a.controller.signal);
        if (current()) this.post({ type: 'voice-asr-final', ...identity, text: result.text });
      } else {
        // mediaText is the only input: no renderer text, reasoning, prompt or history.
        const result = await this.provider.synthesize({ scope: a.scope, finalText: projection.finalText }, a.controller.signal);
        try { if (current() && session.mediaText(data.requestId)) this.post({ type: 'voice-audio', ...identity, wav: result.wav }); }
        finally { result.wav?.fill(0); }
      }
    } catch (error) { if (current()) this.post({ type: 'voice-error', ...identity, error: error instanceof VoiceError ? error.safe() : { stage, code: ['AUDIO_LIMIT', 'INVALID_RESPONSE'].includes(error?.message) ? error.message : 'PROVIDER_FAILED', retryable: false } }); }
    finally { data.wav?.fill(0); }
  }
}
