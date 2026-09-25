import { randomUUID } from 'node:crypto';
import { normalizeUserText, sameVoiceScope, validRequestId } from '../turn-contract.mjs';

// Main owns scopes; Phase A leaves canAttempt false. Device/provider adapters
// will call these transitions in B. Tests inject deterministic evidence only.
export class VoiceTurnCoordinator {
  constructor({ canAttempt = () => false } = {}) { this.canAttempt = canAttempt; this.epoch = 0; this.current = null; this.state = 'idle'; }
  matches(scope) { return sameVoiceScope(scope, this.current?.scope); }
  start(connectionGeneration) {
    if (!this.canAttempt()) return { outcome: 'unavailable', state: 'idle' };
    if (!['idle', 'cancelled', 'error'].includes(this.state)) return { outcome: 'busy', state: this.state };
    const scope = { schemaVersion: 1, connectionGeneration, voiceTurnId: randomUUID(), voiceEpoch: ++this.epoch };
    this.current = { scope, outputAllowed: true };
    this.state = 'preparing';
    return { outcome: 'accepted', state: this.state, scope };
  }
  captureReady(scope) { if (!this.matches(scope) || this.state !== 'preparing') return false; this.state = 'listening'; return true; }
  finish(scope) { if (!this.matches(scope) || this.state !== 'listening') return false; this.state = 'transcribing'; return true; }
  final(scope, value) {
    if (!this.matches(scope) || this.state !== 'transcribing') return null;
    const text = normalizeUserText(value);
    this.current.text = text; this.state = 'awaiting-submit';
    return { type: 'voice-final', generation: scope.connectionGeneration, scope, text };
  }
  acceptSubmit(scope, requestId, text) {
    if (!this.matches(scope) || this.state !== 'awaiting-submit' || !validRequestId(requestId) || normalizeUserText(text) !== this.current.text) return false;
    this.current.requestId = requestId; delete this.current.text; this.state = 'thinking'; return true;
  }
  stopOutput(scope) {
    if (!this.matches(scope)) return { outcome: 'stale', cancelModel: false };
    this.current.outputAllowed = false;
    return { outcome: 'output-disabled', cancelModel: false };
  }
  cancel(scope) {
    if (!this.matches(scope)) return { outcome: 'stale' };
    this.current.outputAllowed = false; delete this.current.text;
    this.state = this.current.requestId ? 'cancelling' : 'cancelled';
    return { outcome: this.current.requestId ? 'pending' : 'cancelled', requestId: this.current.requestId };
  }
  acknowledge({ requestId, outcome }) {
    if (requestId !== this.current?.requestId || this.state !== 'cancelling') return;
    if (['cancelled', 'alreadyCommitted', 'notCommitted'].includes(outcome)) this.state = 'cancelled';
  }
  complete(requestId) {
    if (requestId === this.current?.requestId && this.state === 'thinking') this.state = 'idle';
  }
  disconnect() { this.current = null; ++this.epoch; this.state = 'idle'; }
}
