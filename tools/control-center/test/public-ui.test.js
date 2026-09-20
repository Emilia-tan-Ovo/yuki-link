import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadPublicScript(name, names) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: '', dataset: {}, hidden: false, disabled: false, checked: false,
      querySelector: child => element(`${selector} ${child}`),
    });
    return elements.get(selector);
  };
  const context = {
    console,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    document: { querySelector: element, querySelectorAll: () => [] },
    confirm: () => false,
    fetch: async () => { throw new Error('offline test seam'); },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 0,
  };
  const source = readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  vm.runInNewContext(`${source}\nglobalThis.__test = { ${names.join(', ')}, setState: value => { state = value; } };`, context, { filename: name });
  context.__test.setFetch = value => { context.fetch = value; };
  context.__test.text = selector => element(selector).textContent;
  return context.__test;
}

test('daily and advanced callers reject missing or mismatched operation receipts as unknown', async () => {
  const daily = loadPublicScript('services.js', ['operationOutcome', 'requestOperation']);
  const advanced = loadPublicScript('app.js', ['operationOutcome', 'post']);
  const expected = '11111111-1111-4111-8111-111111111111';
  for (const seam of [daily, advanced]) {
    assert.equal(seam.operationOutcome(true, { operation_id: '22222222-2222-4222-8222-222222222222', outcome: 'succeeded' }, expected), 'unknown');
    assert.equal(seam.operationOutcome(false, { outcome: 'failed', code: 'ACTION_FAILED' }, expected), 'unknown');
    assert.equal(seam.operationOutcome(true, { operation_id: expected, outcome: 'failed' }, expected), 'unknown');
    assert.equal(seam.operationOutcome(false, { operation_id: expected, outcome: 'succeeded' }, expected), 'unknown');
    assert.equal(seam.operationOutcome(true, { operation_id: expected, outcome: 'succeeded' }, expected), 'succeeded');
    assert.equal(seam.operationOutcome(false, { operation_id: expected, outcome: 'failed' }, expected), 'failed');
  }

  daily.setState({ csrf: 'daily-token' });
  let dailyPosts = 0;
  daily.setFetch(async url => {
    if (url === '/api/action') {
      dailyPosts++;
      return { ok: true, json: async () => ({ operation_id: '22222222-2222-4222-8222-222222222222', outcome: 'succeeded' }) };
    }
    throw new Error('status unavailable');
  });
  await daily.requestOperation('/api/action', { id: 'yca', action: 'start' });
  assert.equal(dailyPosts, 1, 'a mismatched receipt must not retry the operation');
  assert.match(daily.text('#notice'), /^操作结果未知：/);

  advanced.setState({ csrf: 'advanced-token' });
  let advancedPosts = 0;
  advanced.setFetch(async () => {
    advancedPosts++;
    return { ok: false, json: async () => ({ outcome: 'failed', code: 'ACTION_FAILED' }) };
  });
  await assert.rejects(advanced.post('/api/action', { id: 'yca', action: 'start' }), { code: 'OPERATION_RESULT_UNKNOWN', outcome: 'unknown', operation_id: expected });
  assert.equal(advancedPosts, 1, 'a missing correlated receipt must not retry the operation');
});

test('advanced event display renders operation metadata and preserves legacy events', () => {
  const { eventLine } = loadPublicScript('app.js', ['eventLine']);
  assert.equal(eventLine({ at: 'now', operation_id: 'op-1', action: 'start', target: 'yca', outcome: 'failed', code: 'PATH_MISSING' }),
    'now  op-1 / start / yca / failed / PATH_MISSING');
  assert.equal(eventLine({ at: 'then', component: 'tunnel', action: 'process-exit', code: null, exitCode: 7 }),
    'then  tunnel / process-exit / exit=7');
});
