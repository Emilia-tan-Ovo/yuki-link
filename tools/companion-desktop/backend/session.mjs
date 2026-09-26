// Adapted from AAAAGENT BackendSession -> DialoguePipeline text path at
// 2752349bcc7f7137b8b9e4ff9cccf34026d77aad. See THIRD_PARTY_NOTICES.md.
import { DialoguePipeline } from './dialogue-pipeline.mjs';
import { SqliteMemoryStore } from './sqlite-memory.mjs';
import { EngineeringCardStore } from './engineering-card-store.mjs';
import { EngineeringCards, modelCandidate } from './engineering-cards.mjs';
import { DEFAULT_ROLE_CARD } from './prompt-composer.mjs';
import { randomUUID } from 'node:crypto';
import { TurnCancelledError } from './turn-cancellation.mjs';
import { normalizeUserText, initialMediaReadiness, validRequestId } from '../desktop/turn-contract.mjs';

const IDENTITY = 'Emilia';
// Count-based window: 32 recent terminal requests plus the active owner.
// IDs expire on eviction; retained IDs still reject duplicate submit. No timer.
const COMPLETED_TURN_LIMIT = 32;

export class BackendSession {
  constructor({ directory, provider, mode = 'real', issueSource, workflowSource, candidateSources }) {
    this.memory = new SqliteMemoryStore(directory);
    this.cardStore = new EngineeringCardStore(directory);
    this.provider = provider;
    this.cards = new EngineeringCards({ store: this.cardStore, extract: text => modelCandidate(mode === 'real' ? provider : null,text), issueSource, workflowSource, candidateSources });
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
    const mediaReadiness = this.mediaReadiness ?? initialMediaReadiness();
    return { text: { implemented: true, mode: this.mode, service: this.statusService() }, memoryManagement: true, voice: this.mode === 'real' && this.statusService() === 'verified' && mediaReadiness.voice.ready === true, live2d: false, engineeringCards: true, mediaReadiness };
  }
  statusService() { return this.mode === 'preview' ? 'offline-preview' : this.provider ? this.requestState : 'unconfigured'; }
  history() {
    return this.memory.history();
  }
  displayHistory() { return this.memory.displayHistory(); }
  listMemories() { return this.memory.listMemories(); }
  async cardCommand(data) {
    if (data.action === 'list') return { cards: this.cardStore.list() };
    if (data.action === 'create') return { card: await this.cards.create(data.original, data.focus) };
    if (data.action === 'edit') return await this.cards.edit(data.cardId,data.expectedRevision,data.fields);
    if (data.action === 'confirm') return this.cards.confirm(data.cardId,data.expectedRevision,'desktop-user-action');
    if (data.action === 'revoke') return this.cards.revoke(data.cardId,data.expectedRevision);
    if (data.action === 'refresh') return { card: await this.cards.refresh(data.cardId) };
    throw Error('工程卡片操作无效。');
  }
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
      this.pruneTurns();
    }
  }
  pruneTurns() {
    let completed = this.turns.size - (this.activeTurn ? 1 : 0);
    for (const [requestId, turn] of this.turns) {
      if (completed <= COMPLETED_TURN_LIMIT) break;
      if (turn === this.activeTurn) continue;
      this.turns.delete(requestId); --completed;
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
    this.pruneTurns();
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
    this.cardStore.close();
  }
}
