import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('new backend ready interrupts the old send and keeps its draft', () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, value: '', textContent: '', disabled: false, scrollHeight: 0,
      replaceChildren() {}, append() {}, addEventListener(name, handler) { this[name] = handler; },
      focus() {}, requestSubmit() { this.submit({ preventDefault() {} }); }
    });
    return elements.get(id);
  };
  let deliver;
  const sent = [];
  const source = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    document: { getElementById: element, createElement: () => ({ dataset: {} }), querySelectorAll: () => [] },
    window: { yukiDesktop: { subscribe(callback) { deliver = callback; }, send(...args) { sent.push(args); } } },
    crypto: { randomUUID: () => 'request-1' }
  });

  deliver({ type: 'connection', generation: 1 });
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  element('text').value = '请记住这条草稿';
  element('form').requestSubmit();
  assert.equal(sent.at(-1)[1].generation, 1);
  assert.equal(element('text').disabled, true);

  deliver({ type: 'connection', generation: 2 });
  assert.equal(element('text').disabled, true);
  deliver({ type: 'ready', generation: 2, history: [], status: { service: 'configured' } });
  assert.equal(element('text').disabled, false);
  assert.equal(element('send').disabled, false);
  assert.equal(element('text').value, '请记住这条草稿');
  assert.match(element('notice').textContent, /上一条未完成的发送已中断/);

  element('form').requestSubmit();
  assert.equal(sent.at(-1)[1].generation, 2);
  deliver({ type: 'reply', messages: [], status: { service: 'verified' } });
  assert.equal(element('text').value, '');
});
