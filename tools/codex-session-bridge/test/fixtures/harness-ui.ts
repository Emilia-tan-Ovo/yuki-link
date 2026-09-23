import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Harness } from '../../src/harness/harness.ts';

export function createFixtureUi(root: string) {
  const uiRoot = path.join(root, 'ui');
  mkdirSync(path.join(uiRoot, '.vite'), { recursive: true });
  mkdirSync(path.join(uiRoot, 'assets'));
  writeFileSync(path.join(uiRoot, 'index.html'), '<!doctype html><html><body><script src="/assets/fixture-12345678.js"></script></body></html>', 'utf8');
  writeFileSync(path.join(uiRoot, 'assets', 'fixture-12345678.js'), 'export {};', 'utf8');
  writeFileSync(path.join(uiRoot, '.vite', 'manifest.json'),
    JSON.stringify({ 'index.html': { file: 'assets/fixture-12345678.js', isEntry: true } }), 'utf8');
  return uiRoot;
}

export function fixtureCookie(home: Response) {
  assert.equal(home.status, 200, `fixture UI home returned ${home.status}; check test UI resources`);
  const header = home.headers.get('set-cookie');
  assert.ok(header, 'fixture UI home did not set yuki_harness cookie');
  assert.match(header, /^yuki_harness=[0-9a-f]+; HttpOnly; SameSite=Strict; Path=\/$/);
  return header.split(';')[0];
}

export function listenFixtureServer(server: http.Server, port = 0) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    server.once('listening', onListening);
    server.once('error', onError);
    try { server.listen(port, '127.0.0.1'); }
    catch (error) { cleanup(); reject(error); }
  });
}

export async function closeFixtureResources(client: Client | undefined, mcp: http.Server | undefined,
  ui: http.Server | undefined, harness: Harness | undefined) {
  try { await client?.close(); }
  finally {
    try { await closeFixtureServer(mcp); }
    finally {
      try { await closeFixtureServer(ui); }
      finally { harness?.close(); }
    }
  }
}

export async function closeFixtureServer(server: http.Server | undefined) {
  if (!server?.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
