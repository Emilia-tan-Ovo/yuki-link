import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';

test('loopback management requires session, exact Origin, CSRF and fixed actions; diagnostic omits token', async t => {
  const calls = [], deploymentCalls = [];
  const supervisor = { snapshot: () => ({ version: 'test', units: {}, events: [] }), action: async (...args) => calls.push(args) };
  const server = createServer(supervisor, { deploymentCheck: async (...args) => deploymentCalls.push(args), deploymentUpdate: async (...args) => deploymentCalls.push(args) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/status')).status, 403);
  const page = await fetch(base); const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const state = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
  const headers = { cookie, origin: base, 'x-csrf-token': state.csrf, 'content-type': 'application/json' };
  const send = (extra = {}, body = { operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 'all', action: 'start' }) => fetch(base + '/api/action', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await send({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await send({ cookie: 'yuki_cc=' + 'é'.repeat(64) })).status, 403);
  assert.equal((await send({ origin: '' })).status, 403);
  assert.equal((await send({}, { operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 'yca', action: 'start', command: 'evil' })).status, 400);
  assert.equal((await send({}, { id: 'yca', action: 'start' })).status, 400);
  assert.equal((await send({}, { operation_id: 'not-a-uuid', id: 'yca', action: 'start' })).status, 400);
  assert.equal((await fetch(base + '/api/action', { headers })).status, 405);
  assert.equal((await send()).status, 200); assert.equal(calls.length, 1);
  let deploymentSequence = 0;
  const deploy = body => fetch(base + '/api/deployment', { method: 'POST', headers, body: JSON.stringify({
    operation_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++deploymentSequence).padStart(12, '0')}`, ...body }) });
  assert.equal((await deploy({ action: 'check', repo: 'evil' })).status, 400);
  assert.equal((await deploy({ action: 'arbitrary' })).status, 400);
  assert.equal((await deploy({ action: 'check' })).status, 200);
  assert.equal((await deploy({ action: 'prepare' })).status, 200);
  assert.equal((await deploy({ action: 'update-restart', confirm: true })).status, 200);
  assert.deepEqual(deploymentCalls.map(call => call.slice(0, 2)), [[{ operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003', action: 'check-remote', target: 'yca' }],
    [false, false], [true, true]]);
  assert.equal(deploymentCalls[1][2].action, 'prepare');
  assert.equal(deploymentCalls[2][2].action, 'update-and-restart');
  const diagnostic = await (await fetch(base + '/api/diagnostic', { headers: { cookie } })).text();
  assert.ok(!diagnostic.includes(state.csrf)); assert.ok(!diagnostic.includes(cookie));
  const status = await new Promise(resolve => { const req = http.get(base + '/', { headers: { Host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }); req.on('error', e => { throw e; }); });
  assert.equal(status, 403);
  const duplicate = createServer(supervisor); await assert.rejects(new Promise((resolve, reject) => { duplicate.on('error', reject); duplicate.listen(server.address().port, '127.0.0.1', resolve); }), { code: 'EADDRINUSE' });
});

test('daily services page uses the existing authenticated management API and returns an operation receipt', async t => {
  const calls = [];
  const snapshot = { at: new Date().toISOString(), autoRecovery: false, observeOnly: false, busy: null,
    units: { yca: { running: false, stale: false, deployment: {} }, tunnel: { running: false, stale: false } }, events: [] };
  const supervisor = {
    snapshot: () => snapshot,
    action: async (...args) => { calls.push(args); return snapshot; },
  };
  const server = createServer(supervisor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await new Promise((resolve, reject) => {
    const request = http.get(base + '/harness/services', { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
  });
  const html = page.body, cookie = page.headers['set-cookie'][0].split(';')[0];
  assert.equal(page.status, 200);
  assert.match(html, /href="\/"[^>]*>Control Center 高级维护/);
  assert.match(html, /src="\/harness\/services\.js"/);
  assert.match(html, /data-action="start"/);
  assert.match(html, /data-action="stop"/);
  assert.match(html, /data-action="restart"/);
  assert.match(html, /data-deployment-action="update-restart"/);
  assert.match(html, /id="auto-recovery"/);
  assert.doesNotMatch(html, /<input[^>]+(?:recovery|auto-recovery)/i);
  assert.equal(calls.length, 0, 'opening the daily page must not change recovery or service state');
  const state = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
  const operationId = '11111111-1111-4111-8111-111111111111';
  const response = await fetch(base + '/api/action', { method: 'POST', headers: { cookie, origin: base,
    'x-csrf-token': state.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: operationId, id: 'yca', action: 'start' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, operation_id: operationId, outcome: 'succeeded',
    completed_at: snapshot.at, snapshot });
  assert.deepEqual(calls, [['yca', 'start', false, { operationId, action: 'start', target: 'yca' }]]);
});

test('failed daily operation returns a correlated terminal receipt and never reports success', async t => {
  const error = Object.assign(new Error('safe'), { code: 'OBSERVED_UNOWNED' });
  const snapshot = { at: new Date().toISOString(), units: {}, events: [] };
  const server = createServer({ snapshot: () => snapshot, action: async () => { throw error; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`, page = await fetch(base);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const status = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
  const operationId = '33333333-3333-4333-8333-333333333333';
  const response = await fetch(base + '/api/action', { method: 'POST', headers: { cookie, origin: base,
    'x-csrf-token': status.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: operationId, id: 'yca', action: 'stop' }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, operation_id: operationId, outcome: 'failed', code: 'OBSERVED_UNOWNED' });
});

test('operation finalization uncertainty returns an unknown correlated receipt', async t => {
  const error = Object.assign(new Error('safe'), { code: 'EVENT_WRITE_FAILED', operationOutcome: 'unknown' });
  const snapshot = { at: new Date().toISOString(), units: {}, events: [] };
  const server = createServer({ snapshot: () => snapshot, action: async () => { throw error; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`, page = await fetch(base);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const status = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
  const operationId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const response = await fetch(base + '/api/action', { method: 'POST', headers: { cookie, origin: base,
    'x-csrf-token': status.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: operationId, id: 'yca', action: 'start' }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, operation_id: operationId, outcome: 'unknown', code: 'EVENT_WRITE_FAILED' });
});
