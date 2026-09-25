import test from 'node:test';
import assert from 'node:assert/strict';
import { deepSeekProvider, previewProvider } from '../backend/provider.mjs';

test('caller cancellation reaches fetch and late body completion cannot return a reply', async () => {
  const controller = new AbortController();
  let options, finish;
  const provider = deepSeekProvider('fixture-value', async (_url, value) => {
    options = value;
    return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) };
  });
  const pending = provider({ messages: [], signal: controller.signal });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(options.signal.aborted, true);
  finish({ choices: [{ finish_reason: 'stop', message: { content: 'late' } }] });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('DeepSeek text adapter sends Emilia context to the documented chat endpoint', async () => {
  let request;
  const provider = deepSeekProvider('fixture-value', async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '你好，桓宇。' } }] }) };
  });
  const messages = [{ role: 'system', content: 'Emilia' }, { role: 'user', content: '昨天见' }, { role: 'assistant', content: '明天见' }, { role: 'user', content: '你好' }];
  const result = await provider({ messages, thinking: { schemaVersion: 1, enabled: false, effort: 'high' } });
  assert.equal(result.content, '你好，桓宇。');
  assert.equal(result.reasoningContent, null);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.stream, false);
  assert.equal(request.options.signal.timeout, undefined);
  assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(body.messages, messages);
  assert.equal(JSON.stringify(body).includes('fixture-value'), false);
});

test('offline preview consumes composed messages without assembling another prompt', async () => {
  assert.deepEqual(await previewProvider()({ messages: [{ role: 'system', content: 'Core' }, { role: 'user', content: '你好' }], thinking: { enabled: true, effort: 'max' } }), { content: '离线预览回复：已收到「你好」。这不是 DeepSeek 回复。', reasoningContent: null, metadata: null });
});

for (const effort of ['low', 'high', 'max']) test(`thinking ${effort} uses exact body and separated result`, async () => {
  let request;
  const provider = deepSeekProvider('fixture-value', async (_url, options) => {
    request = options;
    return { ok: true, json: async () => ({ model: 'served-model', choices: [{ finish_reason: 'stop', message: { content: '最终回答', reasoning_content: '内部思考' } }] }) };
  });
  const result = await provider({ messages: [{ role: 'user', content: '问' }], thinking: { enabled: true, effort } });
  const body = JSON.parse(request.body);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, effort);
  assert.equal(body.stream, false);
  assert.equal(body.tools, undefined);
  assert.equal(result.reasoningContent, '内部思考');
  assert.equal(result.content, '最终回答');
  assert.equal(result.metadata.requestedThinking, effort);
  assert.equal(result.metadata.responseModel, 'served-model');
  assert.equal(result.metadata.finishReason, 'stop');
  assert.ok(result.metadata.fullResponseMs >= 0);
});

test('incomplete and malformed responses fail, even with reasoning', async () => {
  for (const choice of [
    { finish_reason: 'length', message: { content: '片段', reasoning_content: '思考' } },
    { finish_reason: 'content_filter', message: { content: '片段' } },
    { finish_reason: 'tool_calls', message: { content: '文字', tool_calls: [{}] } },
    { finish_reason: 'stop', message: { content: '文字', refusal: 'filtered' } },
    { finish_reason: 'stop', message: { content: ' ', reasoning_content: '思考' } },
    { finish_reason: 'stop', message: { content: '文字', reasoning_content: {} } }
  ]) await assert.rejects(deepSeekProvider('fixture-value', async () => ({ ok: true, json: async () => ({ choices: [choice] }) }))({ messages: [], thinking: { enabled: false, effort: 'high' } }));
});

test('off retains unexpected reasoning honestly; on accepts complete final without reasoning', async () => {
  const provider = deepSeekProvider('fixture-value', async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '完成', reasoning_content: '思考' } }] }) }));
  const off = await provider({ messages: [], thinking: { enabled: false, effort: 'high' } });
  assert.equal(off.reasoningContent, '思考');
  assert.equal(off.metadata.requestedThinking, 'off');
  const noReasoning = deepSeekProvider('fixture-value', async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '完成' } }] }) }));
  assert.equal((await noReasoning({ messages: [], thinking: { enabled: true, effort: 'low' } })).reasoningContent, null);
});
