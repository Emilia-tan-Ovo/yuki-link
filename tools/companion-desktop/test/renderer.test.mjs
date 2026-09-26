import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizeUserText, sameVoiceScope, validRequestId } from '../desktop/turn-contract.mjs';
import { RendererVoice } from '../desktop/voice-ui.mjs';
import { RendererLive2D } from '../desktop/live2d-ui.mjs';
import { initialLive2DReadiness } from '../desktop/live2d-loader.mjs';
import { DEFAULT_VOICE } from '../desktop/voice-config.mjs';
import { VoiceReadiness } from '../desktop/electron/voice-readiness.mjs';

test('missing Live2D resources remain pending in the same window without blocking text or voice controls', () => {
  const h = harness(), readiness = new VoiceReadiness(); readiness.reset(true);
  h.deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  h.deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  h.deliver({ type: 'live2d-settings', readiness: initialLive2DReadiness() });
  h.deliver({ type: 'voice-settings', voice: { ...DEFAULT_VOICE, enabled: true }, readiness: readiness.snapshot(true, 'configured'), credentialConfigured: true });
  assert.equal(h.element('live2d-status').dataset.ready, 'false');
  assert.match(h.element('live2d-status').textContent, /SDK 未配置/);
  assert.equal(h.element('send').disabled, false); assert.equal(h.element('voice-start').disabled, false);
  h.element('live2d-select').onclick(); assert.equal(h.sent.at(-1)[0], 'live2d-select'); assert.equal(h.sent.at(-1).length, 1);
  const facts = { ...initialLive2DReadiness(), configured: true, resourcesVerified: true, displayName: 'C:\\private\\avatar.model3.json', code: 'SDK_UNCONFIGURED' };
  h.deliver({ type: 'live2d-settings', readiness: facts });
  assert.equal(h.element('live2d-status').textContent.includes('private'), false);
  assert.match(h.element('live2d-status').textContent, /实际加载待验证/);
  assert.equal(h.element('live2d-status').dataset.ready, 'false');
});

test('engineering card UI confirms saved revision only and shows not dispatched', () => {
  const h = harness();
  h.deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  h.element('engineering-card-panel').open = true; h.element('engineering-card-panel').toggle();
  assert.equal(h.sent.at(-1)[0], 'engineering-card'); assert.equal(h.sent.at(-1)[1].action, 'list');
  h.element('card-original').value = '给 yuki-link 的 #129 只做设计'; h.element('card-create').onclick();
  const request = h.sent.at(-1)[1]; assert.equal(request.action, 'create');
  const card = { cardId: 'card-1', revision: 1, state: 'pending', content: { original: h.element('card-original').value, summary: '处理 #129', projectKey: 'yuki-link', repository: 'Emilia-tan-Ovo/yuki-link', ticket: { number: 129, title: 'COMPANION-004', url: 'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129' }, resolution: { status: 'verified_existing', reason: 'GitHub' }, desiredPhase: 'ticket-design', endpoint: 'design-only' } };
  h.deliver({ type: 'engineering-card', generation: 1, id: request.id, action: 'create', card });
  h.element('card-confirm').onclick(); const confirmation = h.sent.at(-1)[1];
  assert.deepEqual(Object.keys(confirmation).sort(), ['action','cardId','expectedRevision','generation','id']);
  assert.equal(confirmation.expectedRevision, 1);
  h.deliver({ type: 'engineering-card', generation: 1, id: confirmation.id, action: 'confirm', card: { ...card, state: 'confirmed', confirmation: { revision: 1 } } });
  assert.match(h.element('card-state').textContent, /尚未派发/);
  assert.equal(h.sent.some(([name]) => /dispatch|task-stop|codex/.test(name)), false);
});

test('ordinary engineering text creates a card candidate while everyday chat remains dialogue', () => {
  const h = harness();
  h.deliver({ type:'ready', generation:1, history:[], status:{service:'configured'} });
  h.deliver({ type:'thinking', action:'load', thinking:{schemaVersion:1,enabled:false,effort:'high'} });
  h.element('text').value = '给 yuki-link 的 #129 只做设计'; h.element('form').requestSubmit();
  assert.equal(h.sent.at(-1)[0],'engineering-card');
  assert.equal(h.sent.at(-1)[1].original,'给 yuki-link 的 #129 只做设计');
  assert.equal(h.element('engineering-card-panel').open,true);
  assert.equal(h.sent.filter(([name]) => name === 'submit').length,0);
  h.element('text').value = '今晚吃什么'; h.element('form').requestSubmit();
  assert.equal(h.sent.at(-1)[0],'submit');
});

test('reopen restores verified card focus and ambiguous card offers same-card candidate choice', () => {
  const h = harness();
  h.deliver({type:'ready',generation:1,history:[],status:{service:'configured'}});
  h.deliver({type:'thinking',action:'load',thinking:{schemaVersion:1,enabled:false,effort:'high'}});
  const focused={cardId:'focused',revision:1,state:'confirmed',content:{original:'处理 #129',summary:'处理 COMPANION-004',projectKey:'yuki-link',repository:'Emilia-tan-Ovo/yuki-link',ticket:{repository:'Emilia-tan-Ovo/yuki-link',number:129,title:'COMPANION-004',url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'},resolution:{status:'verified_existing'},desiredPhase:'implementation',endpoint:'to-pr',extraAuthorization:{merge:false,deploy:false}},confirmation:{revision:1}};
  h.deliver({type:'engineering-card',generation:1,action:'list',cards:[focused]});
  h.element('text').value='继续004'; h.element('form').requestSubmit();
  assert.equal(h.sent.at(-1)[1].focus.ticket.number,129);
  const request=h.sent.at(-1)[1];
  const candidates=[{repository:'Emilia-tan-Ovo/yuki-link',number:120,title:'ORCH-004',routeKey:'ORCH-004',url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/120'},{repository:'Emilia-tan-Ovo/yuki-link',number:129,title:'COMPANION-004',routeKey:'COMPANION-004',url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'}];
  const ambiguous={...focused,cardId:'pending',state:'pending',confirmation:null,content:{...focused.content,original:'继续004',summary:'继续004',ticket:null,candidates,resolution:{status:'ambiguous',reason:'存在多个候选'}}};
  h.deliver({type:'engineering-card',generation:1,id:request.id,action:'create',card:ambiguous});
  assert.equal(h.element('card-clarify').hidden,false);
  assert.match(h.element('card-candidate').children[1].textContent,/COMPANION-004.*#129/);
  h.element('card-candidate').value=candidates[1].url; h.element('card-choose').onclick();
  const edit=h.sent.at(-1)[1]; assert.equal(edit.action,'edit'); assert.equal(edit.cardId,'pending'); assert.equal(edit.fields.ticket,'#129');
  h.deliver({type:'engineering-card',generation:1,id:edit.id,action:'edit',card:{...focused,cardId:'pending',revision:2,state:'pending',confirmation:null}});
  assert.equal(h.element('card-identity').textContent.includes('revision 2'),true);
  assert.equal(h.element('card-clarify').hidden,true);
  assert.match(h.element('card-state').textContent,/尚未派发/);
});

test('voice engineering card handoff consumes the matching final without starting dialogue', () => {
  const h = harness();
  h.deliver({type:'ready',generation:1,history:[],status:{service:'configured'}});
  h.deliver({type:'thinking',action:'load',thinking:{schemaVersion:1,enabled:false,effort:'high'}});
  const scope = {schemaVersion:1,connectionGeneration:1,voiceTurnId:'voice-1',voiceEpoch:1,requestId:'voice-request'};
  h.deliver({type:'voice-state',generation:1,scope,state:'awaiting-submit'});
  h.deliver({type:'voice-final',generation:1,scope,text:'给 yuki-link 的 #129 只做设计'});
  assert.equal(h.sent.at(-1)[0],'engineering-card');
  assert.equal(h.sent.at(-1)[1].voiceScope.voiceTurnId,'voice-1');
  assert.equal(h.sent.filter(([name]) => name === 'submit').length,0);
});

test('dirty engineering card fields block confirmation until saved revision is shown', () => {
  const h = harness();
  h.deliver({ type:'ready', generation:1, history:[], status:{service:'configured'} });
  const card = {cardId:'card-1',revision:1,state:'pending',content:{original:'给 yuki-link 的 #129 只做设计',summary:'设计',projectKey:'yuki-link',repository:'Emilia-tan-Ovo/yuki-link',ticket:{number:129,title:'COMPANION-004',url:'https://github.com/Emilia-tan-Ovo/yuki-link/issues/129'},resolution:{status:'verified_existing',reason:'GitHub'},desiredPhase:'ticket-design',endpoint:'design-only',extraAuthorization:{merge:false,deploy:false}}};
  h.deliver({type:'engineering-card',generation:1,action:'list',cards:[card]});
  h.element('card-summary').value = '修改后的设计'; h.element('card-summary').input();
  assert.equal(h.element('card-confirm').disabled,true);
  const count = h.sent.length; h.element('card-confirm').onclick(); assert.equal(h.sent.length,count);
  h.element('card-edit').onclick(); const save = h.sent.at(-1)[1]; assert.equal(save.action,'edit');
  h.deliver({type:'engineering-card',generation:1,id:save.id,action:'edit',card:{...card,revision:2,content:{...card.content,summary:'修改后的设计'}}});
  assert.equal(h.element('card-confirm').disabled,false);
  h.element('card-confirm').onclick(); assert.equal(h.sent.at(-1)[1].expectedRevision,2);
});

test('voice settings/control wiring never acquires devices on load or calls engineering', async () => {
  const h = harness(), readiness = new VoiceReadiness(); readiness.reset(true);
  h.deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  h.deliver({ type: 'voice-settings', voice: { ...DEFAULT_VOICE, enabled: true }, readiness: readiness.snapshot(true, 'configured'), credentialConfigured: true });
  assert.equal(h.element('voice-start').disabled, false); assert.match(h.element('voice-readiness').textContent, /语音已准备好/);
  h.element('voice-start').onclick(); await new Promise(r => setImmediate(r));
  assert.equal(h.sent.at(-1)[0], 'voice-command'); assert.equal(h.sent.at(-1)[1].action, 'start');
  assert.equal(h.sent.some(([name,value]) => name === 'engineering-card' && value.action !== 'list' || name === 'task-stop'), false);
});
import { VoiceTurnCoordinator } from '../desktop/electron/voice-turn.mjs';

function harness(onSend = () => {}) {
  const elements = new Map();
  const makeNode = tag => ({ tag, dataset: {}, children: [], value: '', textContent: '', disabled: false, open: false, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = [...nodes]; }, addEventListener(name, handler) { this[name] = handler; }, scrollIntoView() {} });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      ...makeNode('element'), scrollHeight: 0,
      addEventListener(name, handler) { this[name] = handler; },
      focus() {}, showModal() { this.open = true; }, close() {}, requestSubmit() { this.submit({ preventDefault() {} }); }
    });
    return elements.get(id);
  };
  let deliver;
  const sent = [];
  let sequence = 0;
  const source = readFileSync(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
  runInNewContext(source.replace(/^import .*;\r?$/gm, ''), {
    normalizeUserText, sameVoiceScope, RendererVoice, RendererLive2D, setTimeout, clearTimeout,
    document: { getElementById: element, createElement: makeNode, querySelectorAll: () => [] },
    window: { yukiDesktop: { subscribe(callback) { deliver = callback; }, send(...args) { sent.push(args); onSend(...args); } } },
    crypto: { randomUUID: () => 'request-' + ++sequence }
  });
  return { element, sent, deliver };
}

// Execute the actual main Memory IPC and backend delivery seams with synthetic transport.
function voiceMemoryHarness() {
  const handlers = new Map(), commands = [];
  const voice = new VoiceTurnCoordinator({ canAttempt: () => true });
  const ui = harness((channel, value) => handlers.get('yuki:' + channel)?.({}, value));
  let backend;
  const main = readFileSync(new URL('../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const callback = main.slice(main.indexOf('  currentStatus = message?.status'), main.indexOf('\n} });'));
  const memory = main.slice(main.indexOf("ipcMain.on('yuki:memory'"), main.indexOf("ipcMain.on('yuki:credential'"));
  runInNewContext(`let currentStatus; setBackend((message, generation) => {${callback}\n});\n${memory}`, {
    voice, validRequestId, media: { backend: () => false, state() {}, publish() {} }, deliver: ui.deliver, trusted: () => true,
    connection: { generation: 1, send(command) { commands.push(command); return true; } },
    ipcMain: { on(name, handler) { handlers.set(name, handler); } },
    setBackend(callback) { backend = callback; }
  });
  ui.deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  ui.deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  const final = text => {
    const { scope } = voice.start(1); voice.captureReady(scope); voice.finish(scope);
    ui.deliver({ type: 'voice-state', generation: 1, scope, state: voice.state });
    ui.deliver(voice.final(scope, text)); return scope;
  };
  return { ...ui, voice, commands, final, backend };
}

test('voice Memory waits for matching backend success or failure then releases main owner', () => {
  for (const type of ['memory', 'memory-error']) {
    const h = voiceMemoryHarness();
    h.final('记住：喜欢绿茶');
    const command = h.commands.at(-1);
    assert.equal(h.voice.start(1).outcome, 'busy');
    h.backend({ type, id: 'unrelated', action: 'remember', entries: [], message: '保存失败' }, 1);
    h.backend({ type, id: command.id, action: 'remember', entries: [], message: '保存失败' }, 0);
    assert.equal(h.voice.start(1).outcome, 'busy');
    h.backend({ type, id: command.id, action: 'remember', entries: [], message: '保存失败' }, 1);
    assert.equal(h.voice.state, type === 'memory' ? 'idle' : 'error');
    assert.equal(h.voice.start(1).outcome, 'accepted');
    assert.equal(h.sent.filter(([channel]) => channel === 'submit').length, 0);
  }
});

test('voice management handoff releases main only after local UI opened without claiming mutation', () => {
  const h = voiceMemoryHarness();
  h.final('帮我更正记忆');
  assert.equal(h.element('settings').open, true);
  assert.match(h.element('notice').textContent, /管理区/);
  assert.doesNotMatch(h.element('notice').textContent, /已记住|已更正/);
  assert.equal(h.voice.state, 'idle');
  assert.equal(h.voice.start(1).outcome, 'accepted');
});

function queuedVoiceHarness() {
  const h = harness();
  h.deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  h.deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  const scope = { schemaVersion: 1, connectionGeneration: 1, voiceTurnId: 'queued', voiceEpoch: 1 };
  const final = { type: 'voice-final', generation: 1, scope, text: '待发送的语音' };
  const queue = () => { h.deliver({ type: 'voice-state', generation: 1, scope, state: 'transcribing' }); h.deliver(final); };
  const submits = () => h.sent.filter(([channel]) => channel === 'submit');
  return { ...h, scope, final, queue, submits };
}

test('queued voice final wakes once after matching memoryPending ack or error', () => {
  for (const type of ['memory', 'memory-error']) {
    const h = queuedVoiceHarness();
    h.element('text').value = '记住：喜欢绿茶'; h.element('form').requestSubmit();
    const memory = h.sent.at(-1)[1]; h.queue();
    assert.equal(h.submits().length, 0);
    h.deliver({ type, generation: 1, id: 'stale', action: 'remember', entries: [], message: '失败' });
    assert.equal(h.submits().length, 0);
    h.deliver({ type, generation: 1, action: 'remember', entries: [], message: '无标识' });
    assert.equal(h.submits().length, 0);
    h.deliver({ type, generation: 1, id: memory.id, action: 'remember', entries: [], message: '失败' });
    assert.equal(h.submits().length, 1);
    h.deliver(h.final);
    assert.equal(h.submits().length, 1);
  }
});

test('queued voice final wakes once after typed reply, error or matching cancel acknowledgement', () => {
  for (const type of ['reply', 'error', 'cancel-ack']) {
    const h = queuedVoiceHarness();
    h.element('text').value = '文字问题'; h.element('form').requestSubmit();
    const typed = h.submits()[0][1]; h.queue();
    if (type === 'cancel-ack') h.element('cancel-reply').onclick();
    h.deliver({ type, generation: 1, requestId: 'old', outcome: 'cancelled', messages: [], status: { service: 'verified' } });
    assert.equal(h.submits().length, 1);
    h.deliver({ type, generation: 1, requestId: typed.requestId, outcome: 'cancelled', messages: [], status: { service: 'verified' } });
    assert.equal(h.submits().length, 2);
    assert.equal(h.submits()[1][1].text, h.final.text);
    h.deliver(h.final); h.deliver({ type: 'notice', text: '通知' });
    assert.equal(h.submits().length, 2);
  }
});

test('queued voice final never wakes a cancelled, unknown or reconnected owner', () => {
  for (const state of ['cancelling', 'cancelled', 'unknown', 'error', 'reconnect']) {
    const h = queuedVoiceHarness();
    h.element('thinking-save').onclick(); h.queue();
    if (state === 'reconnect') {
      h.deliver({ type: 'connection', generation: 2 });
      h.deliver({ type: 'ready', generation: 2, history: [], status: { service: 'verified' } });
    } else h.deliver({ type: 'voice-state', generation: 1, scope: h.scope, state });
    h.deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
    h.deliver(h.final);
    assert.equal(h.submits().length, 0, state);
  }
});

test('queued voice final waits for Thinking save and an unknown model cancel owner', () => {
  const h = queuedVoiceHarness();
  h.element('text').value = '文字问题'; h.element('form').requestSubmit();
  const typed = h.submits()[0][1];
  h.element('thinking-save').onclick(); h.queue(); h.element('cancel-reply').onclick();
  h.deliver({ type: 'cancel-ack', generation: 1, requestId: typed.requestId, outcome: 'unknown-request' });
  h.deliver({ type: 'reply', generation: 1, requestId: typed.requestId, messages: [], status: { service: 'verified' } });
  h.deliver({ type: 'thinking', action: 'save', thinking: { schemaVersion: 1, enabled: true, effort: 'high' } });
  h.deliver(h.final);
  assert.equal(h.submits().length, 1);
  h.deliver({ type: 'cancel-ack', generation: 1, requestId: typed.requestId, outcome: 'cancelled' });
  assert.equal(h.submits().length, 2);
  const voice = h.submits()[1][1];
  h.deliver({ type: 'reply', generation: 1, requestId: voice.requestId, origin: 'voice-final', voiceScope: h.scope, messages: [], status: { service: 'verified' } });
  h.deliver(h.final); h.element('settings-open').onclick();
  h.deliver({ type: 'notice', text: '通知' });
  h.deliver({ type: 'persona', action: 'load', roleCard: { text: '已保存角色卡' } });
  h.deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: true, effort: 'high' } });
  assert.equal(h.submits().length, 2);
});

test('queued voice final dispatches after Thinking save resolves to committed settings', () => {
  for (const error of [undefined, '保存失败，原设置继续生效']) {
    const h = queuedVoiceHarness();
    h.element('thinking-save').onclick(); h.queue();
    h.deliver({ type: 'notice', text: '通知' });
    assert.equal(h.submits().length, 0);
    h.deliver({ type: 'thinking', action: 'save', error, thinking: { schemaVersion: 1, enabled: true, effort: 'high' } });
    assert.equal(h.submits().length, 1);
  }
});

test('only matching request can release a round; cancel acknowledgement preserves a newer draft', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  element('text').value = '第一条'; element('form').requestSubmit();
  const first = sent.at(-1)[1];
  deliver({ type: 'error', generation: 1, requestId: 'old', message: '旧错误' });
  assert.equal(element('text').disabled, true);
  element('cancel-reply').onclick();
  assert.equal(sent.at(-1)[0], 'cancel-model');
  assert.match(element('notice').textContent, /等待.*确认/);
  assert.equal(element('text').disabled, true);
  deliver({ type: 'cancel-ack', generation: 1, requestId: first.requestId, outcome: 'cancelled' });
  assert.equal(element('text').disabled, false);
  element('text').value = '第二条'; element('form').requestSubmit();
  const second = sent.at(-1)[1];
  assert.notEqual(first.requestId, second.requestId);
  deliver({ type: 'cancel-ack', generation: 1, requestId: first.requestId, outcome: 'cancelled' });
  deliver({ type: 'reply', generation: 1, requestId: first.requestId, committed: false, messages: [], status: { service: 'verified' } });
  deliver({ type: 'ready', generation: 0, history: [], status: { service: 'unconfigured' } });
  assert.equal(element('text').disabled, true);
  assert.equal(element('text').value, '第二条');
  element('text').value = '新草稿';
  deliver({ type: 'reply', generation: 1, requestId: second.requestId, committed: true, messages: [], status: { service: 'verified' } });
  assert.equal(element('text').disabled, false);
  assert.equal(element('text').value, '新草稿');
});

test('voice final uses typed dispatcher once, preserves typed draft and follows Thinking and Memory gates', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  const scope = { schemaVersion: 1, connectionGeneration: 1, voiceTurnId: 'v1', voiceEpoch: 1 };
  deliver({ type: 'voice-state', generation: 1, scope, state: 'transcribing' });
  element('text').value = '正在编辑的草稿';
  const final = { type: 'voice-final', generation: 1, scope, text: ' 识别\r\n文字 ' };
  deliver(final);
  assert.equal(sent.filter(x => x[0] === 'submit').length, 0);
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  assert.equal(sent.filter(x => x[0] === 'submit').length, 1);
  const submitted = sent.at(-1)[1];
  assert.equal(submitted.text, '识别\n文字');
  assert.equal(submitted.origin, 'voice-final');
  deliver(final);
  assert.equal(sent.filter(x => x[0] === 'submit').length, 1);
  deliver({ type: 'reply', generation: 1, requestId: submitted.requestId, origin: 'voice-final', voiceScope: scope, committed: true, messages: [], status: { service: 'verified' } });
  assert.equal(element('text').value, '正在编辑的草稿');
  const nextScope = { ...scope, voiceTurnId: 'v2', voiceEpoch: 2 };
  deliver({ type: 'voice-state', generation: 1, scope: nextScope, state: 'transcribing' });
  deliver({ type: 'voice-final', generation: 1, scope: nextScope, text: '记住：喜欢绿茶' });
  assert.equal(sent.at(-1)[0], 'memory');
  assert.equal(sent.at(-1)[1].text, '喜欢绿茶');
  deliver({ type: 'memory', generation: 1, id: sent.at(-1)[1].id, action: 'remember', entries: [] });
  assert.equal(element('text').value, '正在编辑的草稿');
  assert.equal(sent.filter(x => x[0] === 'engineering-card' && x[1].action !== 'list' || /task-stop|card-cancel/.test(x[0])).length, 0);
});

test('cancel disconnect is unknown; committed acknowledgement restores history once without clearing draft', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'configured' } });
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  element('text').value = '保留'; element('form').requestSubmit();
  const request = sent.at(-1)[1];
  element('cancel-reply').onclick();
  const row = { id: 'committed', turnId: 'turn', role: 'assistant', text: '已落库', createdAt: '2026-01-01' };
  const ack = { type: 'cancel-ack', generation: 1, requestId: request.requestId, outcome: 'alreadyCommitted', messages: [row] };
  deliver(ack); deliver(ack);
  assert.equal(element('messages').children.filter(x => x.tag === 'article').length, 1);
  assert.equal(element('text').value, '保留');
  assert.match(element('notice').textContent, /已提交/);
  element('form').requestSubmit(); element('cancel-reply').onclick();
  deliver({ type: 'disconnected', generation: 1 });
  assert.match(element('notice').textContent, /未知/);
  assert.equal(element('text').disabled, true);
});

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
  assert.match(element('notice').textContent, /已保存历史为准/);

  element('form').requestSubmit();
  assert.equal(sent.at(-1)[1].generation, 2);
  deliver({ type: 'reply', generation: 2, requestId: sent.at(-1)[1].requestId, committed: true, messages: [], status: { service: 'verified' } });
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
  deliver({ type: 'reply', generation: 1, requestId: sent.find(x => x[0] === 'submit')[1].requestId, committed: true, messages: [], status: { service: 'offline-preview' } });
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
  assert.equal(element('service').dataset.state, 'configured'); // uncorrelated errors cannot change service truth
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
  deliver({ type: 'memory', generation: 1, id: sent.at(-1)[1].id, action: 'remember', entry: { id: 'm1', text: '喜欢红茶' }, entries: [{ id: 'm1', text: '喜欢红茶' }] });
  assert.match(element('notice').textContent, /已记住/);
  assert.equal(element('text').value, '');
  element('settings-open').onclick();
  element('memory-target').value = 'm1'; element('memory-text').value = '喜欢绿茶'; element('memory-correct').onclick();
  assert.equal(sent.at(-1)[1].action, 'correct');
  assert.doesNotMatch(element('memory-status').textContent, /已更正/);
  deliver({ type: 'memory-error', generation: 1, id: sent.at(-1)[1].id, message: '保存失败' });
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

test('ambiguous forget and correction requests stay in local memory management', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  for (const phrase of ['忘掉我喜欢红茶', '忘记我喜欢红茶', '纠正一下我的偏好']) {
    element('text').value = phrase; element('form').requestSubmit();
    assert.equal(sent.filter(x => x[0] === 'submit').length, 0, phrase);
    assert.equal(sent.at(-1)[1].action, 'list');
    assert.match(element('notice').textContent, /选择目标/);
  }
});

test('open memory settings invalidates old options on reconnect and refreshes on new ready', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  element('settings-open').onclick();
  const oldRequest = sent.findLast(x => x[0] === 'memory')[1];
  deliver({ type: 'memory', generation: 1, id: oldRequest.id, action: 'list', entries: [{ id: 'old', text: '喜欢红茶' }] });
  assert.equal(element('memory-target').children.length, 2);
  deliver({ type: 'connection', generation: 2 });
  assert.equal(element('memory-target').children.length, 1);
  assert.equal(element('memory-target').disabled, true);
  assert.match(element('memory-status').textContent, /待重新读取/);
  deliver({ type: 'memory', generation: 1, id: oldRequest.id, action: 'list', entries: [{ id: 'old', text: '喜欢红茶' }] });
  assert.equal(element('memory-target').children.length, 1);
  deliver({ type: 'ready', generation: 2, history: [], status: { service: 'offline-preview' } });
  const newRequest = sent.findLast(x => x[0] === 'memory')[1];
  assert.equal(newRequest.action, 'list');
  assert.equal(newRequest.generation, 2);
  deliver({ type: 'memory', generation: 1, id: oldRequest.id, action: 'list', entries: [{ id: 'old', text: '喜欢红茶' }] });
  assert.equal(element('memory-target').disabled, true);
  deliver({ type: 'memory', generation: 2, id: newRequest.id, action: 'list', entries: [{ id: 'new', text: '喜欢绿茶' }] });
  assert.equal(element('memory-target').disabled, false);
  assert.equal(element('memory-target').children[1].value, 'new');
});

test('correct and forget only display success after matching committed replies', () => {
  const { element, sent, deliver } = harness();
  deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
  deliver({ type: 'memory', generation: 1, action: 'list', entries: [{ id: 'old', text: '喜欢红茶' }] });
  element('memory-target').value = 'old'; element('memory-text').value = '喜欢绿茶'; element('memory-correct').onclick();
  assert.equal(sent.at(-1)[1].action, 'correct');
  assert.doesNotMatch(element('memory-status').textContent, /已更正/);
  deliver({ type: 'memory', generation: 1, id: sent.at(-1)[1].id, action: 'correct', entries: [{ id: 'new', text: '喜欢绿茶' }] });
  assert.match(element('memory-status').textContent, /已更正/);
  assert.equal(element('memory-text').value, '');
  element('memory-target').value = 'new'; element('memory-forget').onclick();
  assert.equal(sent.at(-1)[1].action, 'forget');
  deliver({ type: 'memory', generation: 1, id: sent.at(-1)[1].id, action: 'forget', entries: [] });
  assert.match(element('memory-status').textContent, /已从本机有效陪伴记忆移除/);
});

test('ordinary correction chat is not hijacked by memory management', () => {
  for (const phrase of ['请纠正我的代码', '纠正我的英语发音']) {
    const { element, sent, deliver } = harness();
    deliver({ type: 'thinking', action: 'load', thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
    deliver({ type: 'ready', generation: 1, history: [], status: { service: 'offline-preview' } });
    element('text').value = phrase;
    element('form').requestSubmit();
    assert.equal(sent.at(-1)[0], 'submit', phrase);
    assert.equal(sent.at(-1)[1].text, phrase);
  }
});
