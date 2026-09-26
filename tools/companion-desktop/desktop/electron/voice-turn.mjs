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
    const scope = { schemaVersion: 1, connectionGeneration, voiceTurnId: randomUUID(), voiceEpoch: ++this.epoch, requestId: randomUUID() };
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
  acceptMemory(value) {
    if (!this.matches(value.voiceScope) || value.generation !== this.current.scope.connectionGeneration || this.state !== 'awaiting-submit' || !validRequestId(value.id)) return false;
    const text = this.current.text;
    if (value.voiceResult === 'remember' && value.action === 'remember' && value.sourceKind === 'explicit_chat' && /^记住\s*[:：]/u.test(text) && value.text === text.replace(/^记住\s*[:：]/u, '').trim()) {
      this.current.memoryId = value.id; this.state = 'memory-pending';
    } else if (value.voiceResult === 'management-opened' && value.action === 'list' && !/^记住\s*[:：]/u.test(text) && /记住|忘记记忆|更正记忆|(?:忘掉|忘记).*(?:我|记忆|偏好|喜欢)|(?:纠正|更正).*(?:记忆|偏好|喜欢)|(?:偏好|记忆|喜欢).*(?:忘掉|忘记|纠正|更正)/u.test(text)) {
      this.state = 'idle';
    } else return false;
    delete this.current.text; return true;
  }
  acceptCard(value) {
    if (!this.matches(value.voiceScope) || value.generation !== this.current.scope.connectionGeneration || this.state !== 'awaiting-submit' || value.action !== 'create' || !validRequestId(value.id) || value.original !== this.current.text) return false;
    delete this.current.text;
    this.state = 'idle';
    return true;
  }
  completeMemory(message, generation) {
    if (this.state !== 'memory-pending' || generation !== this.current.scope.connectionGeneration || message.id !== this.current.memoryId) return null;
    if (message.type !== 'memory-error' && !(message.type === 'memory' && message.action === 'remember')) return null;
    this.state = message.type === 'memory' ? 'idle' : 'error';
    delete this.current.memoryId;
    return { type: 'voice-state', generation, scope: this.current.scope, state: this.state, outcome: message.type === 'memory' ? 'memory-committed' : 'memory-failed' };
  }
  stopOutput(scope) {
    if (!this.matches(scope)) return { outcome: 'stale', cancelModel: false };
    this.current.outputAllowed = false;
    if (['synthesizing', 'playback-pending', 'speaking'].includes(this.state)) this.state = 'cancelled';
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
  committed(message) {
    if (!message.committed || message.requestId !== this.current?.requestId || this.state !== 'thinking' || !this.current.outputAllowed) return false;
    this.state = 'synthesizing'; return true;
  }
  audio(scope, requestId) {
    if (!this.matches(scope) || requestId !== this.current.requestId || !this.current.outputAllowed || this.state !== 'synthesizing') return false;
    this.state = 'playback-pending'; return true;
  }
  playback(scope, event) {
    if (!this.matches(scope) || !this.current.outputAllowed) return false;
    if (event === 'started' && this.state === 'playback-pending') { this.state = 'speaking'; return true; }
    if (event === 'ended' && this.state === 'speaking') { this.state = 'idle'; return true; }
    return false;
  }
  fail(scope) { if (!this.matches(scope) || ['cancelled', 'cancelling', 'idle'].includes(this.state)) return false; this.current.outputAllowed = false; this.state = 'error'; return true; }
  disconnect() { this.current = null; ++this.epoch; this.state = 'idle'; }
}
