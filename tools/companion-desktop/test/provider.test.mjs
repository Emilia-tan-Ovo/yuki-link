import test from 'node:test';
import assert from 'node:assert/strict';
import { deepSeekProvider } from '../backend/provider.mjs';

test('DeepSeek text adapter sends Emilia context to the documented chat endpoint', async () => {
  let request;
  const provider = deepSeekProvider('fixture-value', async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '你好，桓宇。' } }] }) };
  });
  const text = await provider({ text: '你好', history: [{ role: 'user', content: '昨天见' }, { role: 'assistant', content: '明天见' }], system: 'Emilia' });
  assert.equal(text, '你好，桓宇。');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(JSON.stringify(body).includes('fixture-value'), false);
});
