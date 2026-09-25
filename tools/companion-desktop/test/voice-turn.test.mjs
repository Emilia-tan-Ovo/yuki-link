import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTurnCoordinator } from '../desktop/electron/voice-turn.mjs';

test('local Memory admission and terminal reject stale scope, generation and forged result', () => {
  const voice = new VoiceTurnCoordinator({ canAttempt: () => true });
  const prepare = text => { const { scope } = voice.start(1); voice.captureReady(scope); voice.finish(scope); voice.final(scope, text); return scope; };
  const old = prepare('记住：绿茶');
  const command = { generation: 1, id: 'memory-old', voiceScope: old, voiceResult: 'remember', action: 'remember', sourceKind: 'explicit_chat', text: '绿茶' };
  assert.equal(voice.acceptMemory({ ...command, voiceResult: 'memory-committed' }), false);
  assert.equal(voice.acceptMemory({ ...command, generation: 0 }), false);
  assert.equal(voice.acceptMemory({ ...command, text: '另一事实' }), false);
  assert.equal(voice.acceptMemory(command), true);
  assert.equal(voice.acceptMemory(command), false);
  voice.cancel(old);
  const next = prepare('记住：红茶');
  assert.equal(voice.acceptMemory(command), false);
  assert.equal(voice.acceptMemory({ ...command, id: 'memory-new', voiceScope: next, text: '红茶' }), true);
  assert.equal(voice.completeMemory({ type: 'memory', id: 'memory-old', action: 'remember' }, 1), null);
  assert.equal(voice.completeMemory({ type: 'memory', id: 'memory-new', action: 'remember' }, 0), null);
  assert.equal(voice.state, 'memory-pending');
  assert.equal(voice.start(1).outcome, 'busy');
  assert.equal(voice.completeMemory({ type: 'memory-error', id: 'memory-new' }, 1).outcome, 'memory-failed');
  assert.equal(voice.start(1).outcome, 'accepted');
});

test('voice lifecycle is unavailable in Phase A; deterministic scope admits one final and separates controls', () => {
  const unavailable = new VoiceTurnCoordinator();
  assert.equal(unavailable.start(1).outcome, 'unavailable');
  const voice = new VoiceTurnCoordinator({ canAttempt: () => true }); // synthetic wiring only
  const started = voice.start(1);
  const scope = started.scope;
  assert.equal(started.state, 'preparing');
  assert.equal(voice.finish(scope), false);
  assert.equal(voice.captureReady(scope), true);
  assert.equal(voice.finish(scope), true);
  assert.equal(voice.finish(scope), false);
  const final = voice.final(scope, ' 识别\r\n文字 ');
  assert.equal(final.text, '识别\n文字');
  assert.equal(voice.final(scope, 'duplicate'), null);
  assert.equal(voice.acceptSubmit(scope, 'model-1', final.text), true);
  assert.equal(voice.acceptSubmit(scope, 'model-2', final.text), false);
  assert.equal(voice.stopOutput(scope).cancelModel, false);
  const cancel = voice.cancel(scope);
  assert.equal(cancel.requestId, 'model-1');
  assert.equal(cancel.outcome, 'pending');
  assert.equal(voice.start(1).outcome, 'busy');
  voice.acknowledge({ requestId: 'model-1', outcome: 'alreadyCommitted' });
  assert.equal(voice.state, 'cancelled');
  const next = voice.start(1);
  assert.notEqual(next.scope.voiceTurnId, scope.voiceTurnId);
  assert.ok(next.scope.voiceEpoch > scope.voiceEpoch);
  assert.equal(voice.final(scope, 'late'), null);
  assert.equal(voice.cancel(scope).outcome, 'stale');
  voice.disconnect();
  assert.equal(voice.final(next.scope, 'late'), null);
});
