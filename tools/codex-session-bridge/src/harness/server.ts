import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Harness } from './harness.ts';
import { HarnessError } from './model.ts';
import { errorStatus, isControlPath, routeControl, routeGet } from './routes.ts';
import { requestUrl, StaticAssets } from './static-assets.ts';
import type { SessionDto } from './presentation-model.ts';

const equal = (value: string | undefined, secret: string) => {
  const a = Buffer.from(value ?? ''), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};
function dailyServicesUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value), port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number.isInteger(port) && port >= 1 && port <= 65535
      && !url.username && !url.password && url.pathname === '/harness/services' && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
async function reachableDailyServices(value: string | null) {
  if (!value) return null;
  try {
    const response = await fetch(value, { redirect: 'error', signal: AbortSignal.timeout(500) });
    await response.body?.cancel(); return response.status === 200 ? value : null;
  } catch { return null; }
}
export function createHarnessServer(harness: Harness, servicesUrl?: string, options: { uiRoot?: string } = {}) {
  const session = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  const assets = new StaticAssets(options.uiRoot), services = dailyServicesUrl(servicesUrl);
  return http.createServer(async (req, res) => {
    const origin = 'http://127.0.0.1:' + req.socket.localPort;
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (status: number, value: unknown) => res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
    if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin
      || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'] ?? '')) return send(403, { code: 'FORBIDDEN' });
    let url: URL;
    try { url = requestUrl(req.url ?? '/', origin); } catch { return send(400, { code: 'INVALID_URL' }); }
    if (req.method !== 'GET' && req.method !== 'POST' || req.method === 'POST' && !isControlPath(url.pathname)) return send(405, { code: 'METHOD_NOT_ALLOWED' });
    if (req.method === 'GET') {
      const asset = assets.get(url.pathname);
      if (asset) return res.writeHead(asset.status, { ...headers, 'cache-control': asset.cache, 'content-type': asset.type,
        ...(asset.index ? { 'set-cookie': 'yuki_harness=' + session + '; HttpOnly; SameSite=Strict; Path=/' } : {}) }).end(asset.body);
      if (!url.pathname.startsWith('/api/')) return send(404, { code: 'NOT_FOUND' });
    }
    const cookie = /(?:^|;\s*)yuki_harness=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    if (!equal(cookie, session)) return send(403, { code: 'SESSION_REQUIRED' });
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) return send(403, { code: 'FORBIDDEN' });
      const type = req.headers['content-type'] ?? '', json = /^application\/json(?:;|$)/i.test(type);
      const form = /^application\/x-www-form-urlencoded(?:;|$)/i.test(type);
      if (!json && !form) return send(415, { code: 'UNSUPPORTED_MEDIA_TYPE' });
      let body = '', size = 0;
      try {
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk); if (size > 4096) return send(413, { code: 'BODY_TOO_LARGE' }); body += chunk;
        }
        if (json && body) JSON.parse(body);
      } catch { return send(400, { code: 'INVALID_BODY' }); }
      const token = json ? req.headers['x-csrf-token'] : new URLSearchParams(body).get('csrf');
      if (typeof token !== 'string' || !equal(token, csrf)) return send(403, { code: 'FORBIDDEN' });
      try {
        const result = routeControl(harness, url.pathname);
        if (form && result.status < 400) return res.writeHead(303, { ...headers, location: '/tickets/' + result.ticketId }).end();
        return send(result.status, result.value);
      } catch (e) { const code = e instanceof HarnessError ? e.code : 'CONTROL_FAILED'; return send(errorStatus(code), { code }); }
    }
    try {
      if (url.pathname === '/api/session') {
        const value: SessionDto = { csrf, composer: { mode: 'read-only', reason: '当前仅观察已有协作；执行仍由协作编排入口发起。' }, services_url: await reachableDailyServices(services) };
        return send(200, value);
      }
      const value = routeGet(harness, url);
      if (value === null) return send(404, { code: 'NOT_FOUND' });
      const state = 'state' in value ? value.state : null;
      return send(state === 'stale' ? 409 : state === 'unavailable' ? 503 : 200, value);
    } catch (e) { const code = e instanceof HarnessError ? e.code : 'UNAVAILABLE'; return send(errorStatus(code), { code }); }
  });
}
