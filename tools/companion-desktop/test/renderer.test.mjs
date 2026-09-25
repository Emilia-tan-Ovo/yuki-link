import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function harness() {
  const elements = new Map();
  const makeNode = tag => ({ tag, dataset: {}, children: [], value: '', textContent: '', disabled: false, open: false, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = [...nodes]; }, addEventListener(name, handler) { this[name] = handler; }, scrollIntoView() {} });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      ...makeNode('element'), scrollHeight: 0,
      addEventListener(name, handler) { this[name] = handler; },
      focus() {}, showModal() {}, close() {}, requestSubmit() { this.submit({ preventDefault() {} }); }
    });
    return elements.get(id);
  };
  let deliver;
  const sent = [];
  const source = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    document: { getElementById: element, createElement: makeNode, querySelectorAll: () => [] },
    window: { yukiDesktop: { subscribe(callback) { deliver = callback; }, send(...args) { sent.push(args); } } },
    crypto: { randomUUID: () => 'request-1' }
  });
  return { element, sent, deliver };
}

test('new backend ready interrupts the old send and keeps its draft', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });

  deliver({ type: 'connection', generation: 1 });
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  element('text').value = '这条草稿';
  element('form').requestSubmit();
  assert.equal(sent.at(-1)[1].generation, 1);
  assert.equal(element('text').disabled, true);

  deliver({ type: 'connection', generation: 2 });
  assert.equal(element('text').disabled, true);
  deliver({ type: 'ready', generation: 2, history: [], status: { service: 'configured' } });
  assert.equal(element('text').disabled, false);
  assert.equal(element('send').disabled, false);
  assert.equal(element('text').value, '这条草稿');
  assert.match(element('notice').textContent, /上一条未完成的发送已中断/);

  element('form').requestSubmit();
  assert.equal(sent.at(-1)[1].generation, 2);
  deliver({ type: 'reply', messages: [], status: { service: 'verified' } });
  assert.equal(element('text').value, '');
});

test('thinking settings load/save and reasoning details are collapsed, text-safe and marked when truncated', () => {
  const { element, sent, deliver } = harness();
  element('settings-open').onclick();
  assert.deepEqual(sent.slice(-2).map(x => x[0]), ['persona-load', 'thinking-load']);
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'max' } });
  assert.equal(element('thinking-effort').disabled, true);
  assert.equal(element('thinking-effort').value, 'max');
  element('thinking-enabled').checked = true;
  element('thinking-enabled').onchange();
  element('thinking-save').onclick();
  assert.equal(sent.at(-1)[0], 'thinking-save');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)[1])), { schemaVersion: 1, enabled: true, effort: 'max' });
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'max' } });
  const reasoning = '<img src=x onerror=alert(1)> REASONING_ONLY_MARKER';
  deliver({ type: 'ready', generation: 1, status: { service: 'configured' }, history: [{ id: '1', role: 'assistant', text: '答案', createdAt: '2026-01-01', reasoningContent: reasoning, metadata: { requestedThinking: 'max', fullResponseMs: 1234, reasoningTruncated: true } }] });
  const item = element('messages').children.find(x => x.tag === 'article');
  const content = item.children[1];
  const details = content.children.find(x => x.tag === 'details');
  assert.equal(details.open, false);
  assert.equal(details.children[1].textContent, reasoning);
  assert.match(details.children[2].textContent, /未完整保存/);
  assert.match(content.children.find(x => x.className === 'message-meta').textContent, /完整回复耗时/);
});

test('thinking save acknowledges committed values while preserving a newer unsaved draft', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: true, effort: 'high' } });
  element('thinking-save').onclick();
  assert.equal(sent.at(-1)[1].effort, 'high');
  element('thinking-enabled').checked = false;
  element('thinking-enabled').onchange();
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'high' } });
  assert.equal(element('thinking-enabled').checked, false);
  assert.match(element('thinking-status').textContent, /已保存.*当前草稿未保存/);
  assert.equal(element('text').disabled, false);
  element('thinking-save').onclick();
  assert.equal(sent.at(-1)[1].enabled, false);
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  assert.match(element('thinking-status').textContent, /已保存/);
  assert.doesNotMatch(element('thinking-status').textContent, /未保存/);
});

test('thinking load gates all submit paths; quick selection auto-saves and keeps text editable', () => {
  const { element, sent, deliver } = harness();
  assert.deepEqual(sent.slice(0, 2).map(x => x[0]), ['ready', 'thinking-load']);
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  element('text').value = '草稿';
  assert.equal(element('send').disabled, true);
  element('form').requestSubmit();
  element('text').keydown({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault() {} });
  assert.equal(sent.filter(x => x[0] === 'submit').length, 0);
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'max' } });
  assert.equal(element('thinking-quick').value, 'off');
  assert.equal(element('send').disabled, false);
  element('thinking-quick').value = 'low'; element('thinking-quick').onchange();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), ['thinking-save', { schemaVersion: 1, enabled: true, effort: 'low' }]);
  assert.equal(element('text').disabled, false);
  assert.equal(element('send').disabled, true);
  element('form').requestSubmit();
  element('text').keydown({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault() {} });
  assert.equal(sent.filter(x => x[0] === 'submit').length, 0);
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'low' } });
  assert.equal(element('send').disabled, false);
  element('form').requestSubmit();
  assert.equal(sent.at(-1)[0], 'submit');
});

test('quick switching coalesces to latest desired and failure restores committed value', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  element('thinking-quick').value = 'low'; element('thinking-quick').onchange();
  element('thinking-quick').value = 'high'; element('thinking-quick').onchange();
  element('thinking-quick').value = 'max'; element('thinking-quick').onchange();
  assert.equal(sent.filter(x => x[0] === 'thinking-save').length, 1);
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'low' } });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), ['thinking-save', { schemaVersion: 1, enabled: true, effort: 'max' }]);
  deliver({ type: 'thinking', action: 'save', error: '思考设置未能保存。' });
  assert.equal(element('thinking-quick').value, 'low');
  assert.match(element('thinking-quick-status').textContent, /未能保存/);
  assert.equal(sent.filter(x => x[0] === 'thinking-save').length, 2);
  element('thinking-quick').value = 'off'; element('thinking-quick').onchange();
  assert.equal(sent.at(-1)[1].effort, 'low');
});

test('first failed quick save drops the unsent latest choice', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  element('thinking-quick').value = 'low'; element('thinking-quick').onchange();
  element('thinking-quick').value = 'max'; element('thinking-quick').onchange();
  deliver({ type: 'thinking', action: 'save', error: '思考设置未能保存。' });
  assert.equal(element('thinking-quick').value, 'off');
  assert.equal(sent.filter(x => x[0] === 'thinking-save').length, 1);
});

test('settings and composer sync committed values without replacing a newer settings draft', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: true, effort: 'high' } });
  element('thinking-quick').value = 'max'; element('thinking-quick').onchange();
  element('thinking-enabled').checked = false; element('thinking-enabled').onchange();
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'max' } });
  assert.equal(element('thinking-quick').value, 'max');
  assert.equal(element('thinking-enabled').checked, false);
  element('thinking-save').onclick();
  assert.equal(sent.at(-1)[1].enabled, false);
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  assert.equal(element('thinking-quick').value, 'off');
});

test('reconnect and stale load do not release a pending save or replace its committed result', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  element('thinking-quick').value = 'max'; element('thinking-quick').onchange();
  deliver({ type: 'connection', generation: 2 });
  deliver({ type: 'ready', generation: 2, history: [], status: { service: 'offline-preview' } });
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  element('text').value = '下一条'; element('form').requestSubmit();
  assert.equal(sent.filter(x => x[0] === 'submit').length, 0);
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'max' } });
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  assert.equal(element('thinking-quick').value, 'max');
  element('form').requestSubmit();
  assert.equal(sent.at(-1)[0], 'submit');
  assert.equal(sent.at(-1)[1].generation, 2);
});

test('saving Thinking during generation leaves the accepted turn running', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  element('text').value = '进行中的一条'; element('form').requestSubmit();
  assert.equal(sent.filter(x => x[0] === 'submit').length, 1);
  element('thinking-quick').value = 'max'; element('thinking-quick').onchange();
  deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'max' } });
  assert.equal(element('text').disabled, true);
  assert.equal(element('thinking-quick').value, 'max');
  deliver({ type: 'reply', messages: [], status: { service: 'offline-preview' } });
  assert.equal(element('text').disabled, false);
  element('text').value = '下一条'; element('form').requestSubmit();
  assert.equal(sent.filter(x => x[0] === 'submit').length, 2);
});

test('persona load, save, reset and failure keep draft separate from chat state', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  element('settings-open').onclick();
  assert.deepEqual(sent.slice(-2).map(x => x[0]), ['persona-load', 'thinking-load']);
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

test('explicit remember waits for committed worker reply; management correct/forget and reconnect keep draft honest', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  element('text').value = '记住：喜欢红茶'; element('form').requestSubmit();
  assert.equal(sent.at(-1)[0], 'memory');
  assert.equal(sent.at(-1)[1].action, 'remember');
  assert.equal(sent.filter(x => x[0] === 'submit').length, 0);
  assert.doesNotMatch(element('notice').textContent, /已记住/);
  deliver({ type: 'memory', generation: 1, action: 'remember', entry: { id: 'm1', text: '喜欢红茶' }, entries: [{ id: 'm1', text: '喜欢红茶' }] });
  assert.match(element('notice').textContent, /已记住/);
  assert.equal(element('text').value, '');
  element('settings-open').onclick();
  element('memory-target').value = 'm1'; element('memory-text').value = '喜欢绿茶'; element('memory-correct').onclick();
  assert.equal(sent.at(-1)[1].action, 'correct');
  assert.doesNotMatch(element('memory-status').textContent, /已更正/);
  deliver({ type: 'memory-error', generation: 1, message: '保存失败' });
  assert.match(element('memory-status').textContent, /保存失败/);
  assert.equal(element('memory-text').value, '喜欢绿茶');
  element('memory-correct').onclick();
  deliver({ type: 'connection', generation: 2 });
  deliver({ type: 'memory', generation: 1, action: 'correct', entries: [] });
  assert.doesNotMatch(element('memory-status').textContent, /已更正/);
  deliver({ type: 'ready', generation: 2, history: [], status: { service: 'offline-preview' } });
});

test('ambiguous memory text opens management; selected user message needs edited fact', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  deliver({ type: 'ready', generation: 1, history: [{ id: 'user-1', role: 'user', text: '很长的聊天', createdAt: '2026-01-01' }], status: { service: 'offline-preview' } });
  element('text').value = '请帮我记住这个'; element('form').requestSubmit();
  assert.equal(sent.filter(x => x[0] === 'submit').length, 0);
  assert.match(element('notice').textContent, /明确填写/);
  const item = element('messages').children.find(x => x.tag === 'article');
  item.children[1].children.find(x => x.className === 'memory-pick').onclick();
  assert.equal(element('memory-text').value, '');
  element('memory-text').value = '喜欢绿茶'; element('memory-add').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1)[1])).sourceRef, 'user-1');
  assert.equal(sent.at(-1)[1].sourceKind, 'selected_user_message');
});

test('correct and forget only display success after matching committed replies', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  deliver({ type: 'memory', generation: 1, action: 'list', entries: [{ id: 'old', text: '喜欢红茶' }] });
  element('memory-target').value = 'old'; element('memory-text').value = '喜欢绿茶'; element('memory-correct').onclick();
  assert.equal(sent.at(-1)[1].action, 'correct');
  assert.doesNotMatch(element('memory-status').textContent, /已更正/);
  deliver({ type: 'memory', generation: 1, id: 'request-1', action: 'correct', entries: [{ id: 'new', text: '喜欢绿茶' }] });
  assert.match(element('memory-status').textContent, /已更正/);
  assert.equal(element('memory-text').value, '');
  element('memory-target').value = 'new'; element('memory-forget').onclick();
  assert.equal(sent.at(-1)[1].action, 'forget');
  deliver({ type: 'memory', generation: 1, id: 'request-1', action: 'forget', entries: [] });
  assert.match(element('memory-status').textContent, /已从本机有效陪伴记忆移除/);
});
