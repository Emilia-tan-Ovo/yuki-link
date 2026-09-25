import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, value: '', textContent: '', disabled: false, scrollHeight: 0,
      replaceChildren() {}, append() {}, addEventListener(name, handler) { this[name] = handler; },
      focus() {}, showModal() {}, close() {}, requestSubmit() { this.submit({ preventDefault() {} }); }
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
  return { element, sent, deliver };
}

test('new backend ready interrupts the old send and keeps its draft', () => {
  const { element, sent, deliver } = harness();

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

test('persona load, save, reset and failure keep draft separate from chat state', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  element('settings-open').onclick();
  assert.equal(sent.at(-1)[0], 'persona-load');
  deliver({ type: 'persona', action: 'load', roleCard: { schemaVersion: 1, text: '卡 A' } });
  assert.equal(element('role-card').value, '卡 A');
  element('role-card').value = '卡 B';
  element('role-card').input();
  assert.match(element('role-card-count').textContent, /3/);
  element('role-card-save').onclick();
  assert.equal(sent.at(-1)[0], 'persona-save');
  assert.equal(sent.at(-1)[1].schemaVersion, 1);
  assert.equal(sent.at(-1)[1].text, '卡 B');
  deliver({ type: 'persona', action: 'save', error: '保存失败' });
  assert.equal(element('role-card').value, '卡 B');
  assert.equal(element('text').disabled, false);
  assert.equal(element('notice').textContent, '');
  assert.match(element('role-card-status').textContent, /保存失败/);
  deliver({ type: 'error', status: { service: 'unknown' }, message: '网络失败' });
  assert.equal(element('text').disabled, false);
  assert.equal(element('service').dataset.state, 'unknown');
  element('role-card-reset').onclick();
  assert.equal(sent.at(-1)[0], 'persona-reset');
  deliver({ type: 'persona', action: 'reset', roleCard: { schemaVersion: 1, text: '默认卡' } });
  assert.equal(element('role-card').value, '默认卡');
});

test('reset commits the default without overwriting edits made while pending; later save commits the draft', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'persona', action: 'load', roleCard: { schemaVersion: 1, text: '卡 A' } });
  element('role-card-reset').onclick();
  assert.equal(sent.at(-1)[0], 'persona-reset');

  element('role-card').value = '新草稿';
  element('role-card').input();
  deliver({ type: 'persona', action: 'reset', roleCard: { schemaVersion: 1, text: '默认卡' } });
  assert.equal(element('role-card').value, '新草稿');
  assert.match(element('role-card-status').textContent, /默认卡已保存.*下一条.*当前草稿未保存/);

  element('role-card-save').onclick();
  assert.equal(sent.at(-1)[0], 'persona-save');
  assert.equal(sent.at(-1)[1].text, '新草稿');
  deliver({ type: 'persona', action: 'save', roleCard: { schemaVersion: 1, text: '新草稿' } });
  assert.equal(element('role-card').value, '新草稿');
  assert.match(element('role-card-status').textContent, /角色卡已保存/);
});
