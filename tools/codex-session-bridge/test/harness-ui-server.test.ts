import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Harness } from '../src/harness/harness.ts';
import { createHarnessServer } from '../src/harness/server.ts';
import { StaticAssets } from '../src/harness/static-assets.ts';
import type { SessionDto, TicketDto } from '../src/harness/presentation-model.ts';

test('production SPA, allowlisted assets, session/security, exact fallback and scan semantics', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-ui-server-'));
  const harness = new Harness(root, { session: () => { throw Error('offline'); }, runs: () => [], events: () => [], attribution: () => null });
  const ticket = harness.register({ project_key: 'P', project_name: '真实工程', ticket_key: 'T', title: '真实 Ticket', reference: 'fixture' });
  let scans = 0; const scan = harness.scan.bind(harness); harness.scan = refresh => { if (refresh) scans++; scan(refresh); };
  const server = createHarnessServer(harness);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); harness.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = await fetch(base + '/conversations/' + ticket.conversation_id);
  assert.equal(home.status, 200); assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.match(home.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict; Path=\//);
  const cookie = home.headers.get('set-cookie')!.split(';')[0], html = await home.text();
  const csp = home.headers.get('content-security-policy')!;
  assert.match(csp, /script-src 'self'/); assert.match(csp, /connect-src 'self'/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>[^<]+/);
  const asset = /src="([^"]+\.js)"/.exec(html)![1];
  const response = await fetch(base + asset);
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /immutable/); assert.match(response.headers.get('content-type')!, /javascript/);
  for (const route of ['/api/unknown', '/assets/missing.js', '/unknown', '/tickets/nope', '/assets/index.html']) {
    const r = await fetch(base + route, { headers: { cookie } }); assert.equal(r.status, 404, route); assert.match(r.headers.get('content-type')!, /json/);
  }
  async function raw(target: string, headers: Record<string, string> = {}) {
    return new Promise<number>(resolve => { const req = http.request(base, { path: target, headers: { cookie, ...headers } }, r => { r.resume(); resolve(r.statusCode!); }); req.end(); });
  }
  for (const target of ['/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/%2findex.js', '/%zz', '//evil/', '/assets\\index.js']) assert.equal(await raw(target), 400, target);
  const deniedHeaders: Record<string, string>[] = [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }];
  for (const headers of deniedHeaders) assert.equal(await raw('/api/session', headers), 403);
  assert.equal((await fetch(base + '/api/session')).status, 403);
  const session = await (await fetch(base + '/api/session', { headers: { cookie } })).json() as SessionDto;
  assert.equal(session.composer.mode, 'read-only'); assert.equal(session.services_url, null);
  const detail = await (await fetch(base + '/api/ui/tickets/' + ticket.ticket_id, { headers: { cookie } })).json() as TicketDto;
  assert.equal(detail.ticket.title, '真实 Ticket'); assert.equal(detail.conversation.items[0].kind, 'lifecycle');
  await fetch(base + '/api/ui/conversations/' + ticket.conversation_id, { headers: { cookie } });
  await fetch(base + '/api/projects', { headers: { cookie } }); assert.equal(scans, 0);
  const post = (headers: Record<string, string>, body = '{}') => fetch(base + '/api/tickets/' + ticket.ticket_id + '/refresh', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({ 'x-csrf-token': session.csrf })).status, 403);
  assert.equal((await post({ origin: base, 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await post({ origin: base, 'x-csrf-token': session.csrf, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ origin: base, 'x-csrf-token': session.csrf }, 'x'.repeat(4097))).status, 413);
  assert.equal((await post({ origin: base, 'x-csrf-token': session.csrf }, '{')).status, 400);
  assert.equal((await post({ origin: base, 'x-csrf-token': session.csrf })).status, 200); assert.equal(scans, 1);
  const invalidPaging = await fetch(base + '/api/ui/conversations/' + ticket.conversation_id + '?after=1&before=2', { headers: { cookie } }); assert.equal(invalidPaging.status, 400);
  harness.start(5); await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(harness.checkedAt); harness.close();
});

test('static serving rejects unlisted files, missing build and linked assets', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-static-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(new StaticAssets(root).get('/')?.status, 503);
  mkdirSync(path.join(root, '.vite')); mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'index.html'), '<div id="root"></div>', 'utf8');
  writeFileSync(path.join(root, 'assets/a-12345678.js'), 'export {};', 'utf8');
  writeFileSync(path.join(root, 'assets/private.txt'), 'not public', 'utf8');
  writeFileSync(path.join(root, '.vite/manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/a-12345678.js', isEntry: true } }), 'utf8');
  const assets = new StaticAssets(root); assert.equal(assets.get('/')?.status, 200); assert.equal(assets.get('/assets/private.txt'), null);
  const outside = path.join(root, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'a-12345678.js'), 'secret', 'utf8');
  rmSync(path.join(root, 'assets'), { recursive: true }); symlinkSync(outside, path.join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(assets.get('/assets/a-12345678.js')?.status, 503);
  assert.equal(new StaticAssets(root).get('/')?.status, 503);
});
