import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTurnCoordinator } from '../desktop/electron/voice-turn.mjs';

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
