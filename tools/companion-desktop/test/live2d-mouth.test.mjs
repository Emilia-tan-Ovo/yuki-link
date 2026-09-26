import test from 'node:test';
import assert from 'node:assert/strict';
import { Live2DMouth, normalizeMouth } from '../desktop/live2d-mouth.mjs';
import { RendererVoice } from '../desktop/voice-ui.mjs';
const scope = { schemaVersion: 1, connectionGeneration: 1, voiceTurnId: 'voice-1', voiceEpoch: 1 };
const owner = { scope, requestId: 'reply-1' };
test('synthetic parameter setter changes only after matching playback started and RMS', () => {
  const writes = [], mouth = new Live2DMouth();
  assert.equal(mouth.map({ parameterId: 'Mouth', closed: 0, open: 1 }, [{ id: 'Mouth', min: 0, max: 1 }], (id, value) => writes.push([id, value])), true);
  mouth.arm(owner); mouth.amplitude({ ...owner, value: .25 }); assert.deepEqual(writes.at(-1), ['Mouth', 0]);
  mouth.started(owner); mouth.amplitude({ ...owner, value: .25 }); assert.deepEqual(writes.at(-1), ['Mouth', .95]);
  mouth.amplitude({ ...owner, value: 0 }); assert.deepEqual(writes.at(-1), ['Mouth', 0]);
  mouth.reset(); mouth.amplitude({ ...owner, value: 1 }); assert.deepEqual(writes.at(-1), ['Mouth', 0]);
});
test('mouth policy validates gain and actual parameter bounds without guessing a missing parameter', () => {
  assert.equal(normalizeMouth({ parameterId: 'Mouth', closed: 0, open: 1 }).gain, 1.9);
  for (const gain of [0, -1, 4.01, NaN, Infinity]) assert.throws(() => normalizeMouth({ parameterId: 'Mouth', closed: 0, open: 1, gain }), /MOUTH_MAPPING_INVALID/);
  const writes = [], mouth = new Live2DMouth(), setter = (...args) => writes.push(args);
  for (const config of [null, { parameterId: 'Missing', closed: 0, open: 1 }, { parameterId: 'Mouth', closed: -1, open: 1 }, { parameterId: 'Mouth', closed: 0, open: 0 }]) {
    assert.equal(mouth.map(config, [{ id: 'Mouth', min: 0, max: 1 }], setter), false);
    mouth.arm(owner); mouth.started(owner); mouth.amplitude({ ...owner, value: 1 });
  }
  assert.equal(writes.length, 0);
});
test('synthetic clamp, reversed range, stale request/scope and terminal events preserve owner fencing', () => {
  const values = [], mouth = new Live2DMouth();
  mouth.map({ parameterId: 'Mouth', closed: 1, open: -1, gain: 4 }, [{ id: 'Mouth', min: -1, max: 1 }], (_id, value) => values.push(value));
  mouth.arm(owner); mouth.started({ ...owner, requestId: 'stale' }); mouth.amplitude({ ...owner, value: 1 }); assert.equal(values.at(-1), 1);
  mouth.started(owner); mouth.amplitude({ ...owner, value: 100 }); assert.equal(values.at(-1), -1);
  mouth.amplitude({ ...owner, value: NaN }); assert.equal(values.at(-1), 1);
  for (const reason of ['ended', 'stop', 'cancel', 'error', 'reconnect', 'stale-scope']) {
    mouth.arm(owner); mouth.started(owner); mouth.amplitude({ ...owner, value: 1 }); mouth.reset(reason);
    mouth.started(owner); mouth.amplitude({ ...owner, value: 1 }); assert.equal(values.at(-1), 1);
  }
  const next = { scope: { ...scope, voiceEpoch: 2 }, requestId: 'reply-2' };
  mouth.arm(next); mouth.started(next); mouth.amplitude({ ...next, value: 1 });
  mouth.end(owner); mouth.amplitude({ ...owner, value: 0 }); assert.equal(values.at(-1), -1);
  mouth.end(next); assert.equal(values.at(-1), 1);
});
test('RendererVoice synthetic playback wiring closes on cancel/error/reconnect and rejects late owner callbacks', async () => {
  const values = [], outputs = [], sent = [], nodes = new Map(), mouth = new Live2DMouth();
  mouth.map({ parameterId: 'Mouth', closed: 0, open: 1 }, [{ id: 'Mouth', min: 0, max: 1 }], (_id, value) => values.push(value));
  class Playback {
    constructor({ emit }) { this.emit = emit; outputs.push(this); }
    async play() {} async stop() {}
  }
  const ui = new RendererVoice({ host: { send: (...args) => sent.push(args) }, element: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); }, getGeneration: () => 1, notice() {}, mediaDevices: null, Playback, playbackObserver: event => {
    if (event.type === 'armed') mouth.arm(event);
    else if (event.type === 'started') mouth.started(event);
    else if (event.type === 'amplitude') mouth.amplitude(event);
    else mouth.reset();
  } });
  const audio = s => ({ type: 'voice-play', generation: 1, scope: s, requestId: 'reply', wav: new Uint8Array([1]) });
  await ui.receive({ type: 'voice-state', generation: 1, scope, state: 'playback-pending' });
  await ui.receive(audio(scope)); const old = outputs[0];
  assert.ok(old, 'playback seam must use the supplied synthetic device');
  old.emit({ type: 'amplitude', value: 1 }); assert.equal(values.at(-1), 0);
  old.emit({ type: 'started' }); old.emit({ type: 'amplitude', value: .25 }); assert.equal(values.at(-1), .95);
  ui.command('stop-output'); assert.equal(values.at(-1), 0);
  old.emit({ type: 'started' }); old.emit({ type: 'amplitude', value: 1 }); assert.equal(values.at(-1), 0);
  const next = { ...scope, voiceEpoch: 2 };
  await ui.receive({ type: 'voice-state', generation: 1, scope: next, state: 'playback-pending' }); await ui.receive(audio(next));
  const current = outputs[1]; current.emit({ type: 'started' }); current.emit({ type: 'amplitude', value: 1 }); assert.equal(values.at(-1), 1);
  old.emit({ type: 'ended' }); old.emit({ type: 'amplitude', value: 0 }); assert.equal(values.at(-1), 1);
  current.emit({ type: 'error', code: 'PLAYBACK_FAILED' }); assert.equal(values.at(-1), 0);
  await ui.receive({ type: 'connection', generation: 1 }); current.emit({ type: 'started' }); current.emit({ type: 'amplitude', value: 1 }); assert.equal(values.at(-1), 0);
  assert.equal(sent.some(([name]) => /engineering|task-stop/.test(name)), false);
});
