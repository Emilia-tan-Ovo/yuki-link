// Adapted from AAAAGENT BackendSession -> DialoguePipeline text path at
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. See THIRD_PARTY_NOTICES.md.
import { DialoguePipeline } from './dialogue-pipeline.mjs';
import { SqliteMemoryStore } from './sqlite-memory.mjs';
import { DEFAULT_ROLE_CARD } from './prompt-composer.mjs';
import { randomUUID } from 'node:crypto';
import { TurnCancelledError } from './turn-cancellation.mjs';
import { normalizeUserText, initialMediaReadiness, validRequestId } from '../desktop/turn-contract.mjs';

const IDENTITY = 'Emilia';

export class BackendSession {
  constructor({ directory, provider, mode = 'real' }) {
    this.memory = new SqliteMemoryStore(directory);
    this.provider = provider;
    this.pipeline = provider ? new DialoguePipeline({ memory: this.memory, dialogue: provider }) : null;
    this.mode = mode;
    this.busy = false;
    this.requestState = 'configured';
    this.activeTurn = null;
    this.turns = new Map();
    this.closed = false;
  }
  status() {
    const service = this.mode === 'preview' ? 'offline-preview' : this.provider ? this.requestState : 'unconfigured';
    return { identity: IDENTITY, service, capabilities: this.runtimeCapabilities() };
  }
  runtimeCapabilities() {
    return { text: { implemented: true, mode: this.mode, service: this.statusService() }, memoryManagement: true, voice: false, live2d: false, engineeringCards: false, mediaReadiness: initialMediaReadiness() };
  }
  statusService() { return this.mode === 'preview' ? 'offline-preview' : this.provider ? this.requestState : 'unconfigured'; }
  history() {
    return this.memory.history();
  }
  displayHistory() { return this.memory.displayHistory(); }
  listMemories() { return this.memory.listMemories(); }
  memoryMutation(fn) { if (this.busy) throw Error('上一条消息尚未完成，请稍后再管理记忆。'); return fn(); }
  remember(value) { return this.memoryMutation(() => this.memory.remember(value)); }
  correctMemory(id, text) { return this.memoryMutation(() => this.memory.correct(id, text)); }
  forgetMemory(id) { return this.memoryMutation(() => this.memory.forget(id)); }
  async submit(value, roleCard = DEFAULT_ROLE_CARD, thinking = { schemaVersion: 1, enabled: false, effort: 'high' }, scope = {}) {
    const text = normalizeUserText(value);
    if (!this.provider) throw Error('DeepSeek 凭据未配置；请在设置中配置后再发送。');
    if (this.busy) throw Error('上一条消息尚未完成。');
    if (this.closed) throw new TurnCancelledError();
    const requestId = scope.requestId ?? randomUUID();
    if (!validRequestId(requestId) || this.turns.has(requestId)) throw Error('对话输入标识无效或重复。');
    const turn = { requestId, controller: new AbortController(), outcome: 'pending', mediaAllowed: true };
    this.turns.set(requestId, turn);
    this.activeTurn = turn;
    this.busy = true;
    const isCurrent = () => !this.closed && this.activeTurn === turn && !turn.controller.signal.aborted;
    try {
      const runtime = this.runtimeCapabilities();
      const result = await this.pipeline.run(text, { roleCard, thinking, runtime, memory: this.memory.recall(text), requestId, signal: turn.controller.signal, isCurrent,
        onCommitted: messages => { turn.outcome = 'alreadyCommitted'; turn.turnId = messages[0].turnId; },
        onProviderFailure: () => { if (isCurrent() && this.mode === 'real') this.requestState = 'unknown'; },
        onProviderSuccess: () => { if (isCurrent() && this.mode === 'real') this.requestState = 'verified'; } });
      return { ...result, requestId, committed: true, status: this.status() };
    } finally {
      if (turn.outcome === 'pending') turn.outcome = 'notCommitted';
      if (this.activeTurn === turn) { this.activeTurn = null; this.busy = false; }
    }
  }
  cancel(requestId) {
    const turn = this.turns.get(requestId);
    if (!turn || this.closed) return { requestId, outcome: this.closed ? 'unknown-after-disconnect' : 'unknown-request' };
    turn.mediaAllowed = false;
    if (turn.outcome === 'pending') {
      turn.outcome = 'cancelled';
      turn.controller.abort();
      if (this.activeTurn === turn) { this.activeTurn = null; this.busy = false; }
    }
    return { requestId, outcome: turn.outcome, turnId: turn.turnId,
      ...(turn.outcome === 'alreadyCommitted' ? { messages: this.displayHistory().filter(row => row.turnId === turn.turnId) } : {}) };
  }
  // Downstream media must ask after commit and recheck its own scope on delivery.
  // This projection never contains reasoning, metadata, prompt or Memory.
  mediaText(requestId) {
    const turn = this.turns.get(requestId);
    if (this.closed || !turn?.mediaAllowed || turn.outcome !== 'alreadyCommitted') return null;
    const assistant = this.displayHistory().find(row => row.turnId === turn.turnId && row.role === 'assistant');
    return assistant ? { requestId, turnId: turn.turnId, finalText: assistant.text } : null;
  }
  close() {
    if (this.closed) return;
    if (this.activeTurn) this.cancel(this.activeTurn.requestId);
    this.closed = true;
    this.turns.clear();
    this.memory.close();
  }
}
