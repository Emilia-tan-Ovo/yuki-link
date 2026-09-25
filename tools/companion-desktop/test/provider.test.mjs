import test from 'node:test';
import assert from 'node:assert/strict';
import { deepSeekProvider, previewProvider } from '../backend/provider.mjs';

test('DeepSeek text adapter sends Emilia context to the documented chat endpoint', async () => {
  let request;
  const provider = deepSeekProvider('fixture-value', async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '你好，桓宇。' } }] }) };
  });
  const messages = [{ role: 'system', content: 'Emilia' }, { role: 'user', content: '昨天见' }, { role: 'assistant', content: '明天见' }, { role: 'user', content: '你好' }];
  const text = await provider({ messages });
  assert.equal(text, '你好，桓宇。');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(body.messages, messages);
  assert.equal(JSON.stringify(body).includes('fixture-value'), false);
});

test('offline preview consumes composed messages without assembling another prompt', async () => {
  assert.equal(await previewProvider()({ messages: [{ role: 'system', content: 'Core' }, { role: 'user', content: '你好' }] }), '离线预览回复：已收到「你好」。这不是 DeepSeek 回复。');
});
