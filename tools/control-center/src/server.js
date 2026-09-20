import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/harness/services', ['services.html', 'text/html; charset=utf-8']],
  ['/harness/services.js', ['services.js', 'text/javascript; charset=utf-8']]]);
const equal = (a, b) => {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const operationId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function createServer(supervisor, { codexCheck, startup, deploymentCheck, deploymentUpdate } = {}) {
  const session = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  return http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" };
    const json = (code, value) => res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
    const topLevelNavigation = req.method === 'GET' && !req.headers.origin && req.headers['sec-fetch-mode'] === 'navigate'
      && req.headers['sec-fetch-dest'] === 'document';
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site' || (req.headers['sec-fetch-site'] === 'same-site' && !topLevelNavigation)) return json(403, { code: 'FORBIDDEN' });
    if (req.method === 'GET' && assets.has(req.url)) {
      const [name, type] = assets.get(req.url);
      const page = type.startsWith('text/html');
      res.writeHead(200, { ...headers, 'content-type': type, ...(page ? { 'set-cookie': `yuki_cc=${session}; HttpOnly; SameSite=Strict; Path=/` } : {}) });
      return res.end(readFileSync(new URL(`../public/${name}`, import.meta.url)));
    }
    const cookie = /(?:^|;\s*)yuki_cc=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    if (!equal(cookie, session)) return json(403, { code: 'SESSION_REQUIRED' });
    if (req.method === 'GET' && req.url === '/api/status') return json(200, { ...supervisor.snapshot(), csrf, startup: startup?.snapshot() ?? { state: '未检查' } });
    if (req.method === 'GET' && req.url === '/api/diagnostic') return json(200, supervisor.snapshot());
    if (req.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED' });
    if (req.headers.origin !== origin || !equal(req.headers['x-csrf-token'], csrf) || req.headers['content-type'] !== 'application/json') return json(403, { code: 'CSRF_REJECTED' });
    let body;
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk.toString('utf8'); if (Buffer.byteLength(raw) > 2048) return json(413, { code: 'BODY_TOO_LARGE' }); }
      body = JSON.parse(raw);
      let result;
      if (req.url === '/api/action') {
        if (!operationId(body.operation_id) || Object.keys(body).some(k => !['operation_id', 'id', 'action', 'confirm'].includes(k))
          || !['yca', 'tunnel', 'all'].includes(body.id) || !['start', 'stop', 'restart', 'retry'].includes(body.action)
          || (body.confirm !== undefined && typeof body.confirm !== 'boolean')) return json(400, { code: 'INVALID_ACTION' });
        const operation = { operationId: body.operation_id, action: body.action === 'restart' ? 'restart-current' : body.action, target: body.id };
        result = await supervisor.action(body.id, body.action, body.confirm === true, operation);
      } else if (req.url === '/api/recheck') await supervisor.serial(() => supervisor.observe());
      else if (req.url === '/api/recovery') await supervisor.setRecovery(body.enabled);
      else if (req.url === '/api/confirm-tools') await supervisor.confirmTools();
      else if (req.url === '/api/codex-check') await codexCheck();
      else if (req.url === '/api/deployment') {
        if (!operationId(body.operation_id) || Object.keys(body).some(k => !['operation_id', 'action', 'confirm'].includes(k)) || !['check', 'prepare', 'update-restart'].includes(body.action)
            || (body.confirm !== undefined && typeof body.confirm !== 'boolean')) return json(400, { code: 'INVALID_ACTION' });
        const operation = { operationId: body.operation_id,
          action: body.action === 'check' ? 'check-remote' : body.action === 'update-restart' ? 'update-and-restart' : 'prepare', target: 'yca' };
        if (body.action === 'check') result = await deploymentCheck(operation);
        else result = await deploymentUpdate(body.action === 'update-restart', body.confirm === true, operation);
      }
      else if (req.url === '/api/startup') await startup.change(body.action);
      else return json(404, { code: 'NOT_FOUND' });
      const snapshot = result && typeof result === 'object' ? result : supervisor.snapshot();
      json(200, body.operation_id ? { ok: true, operation_id: body.operation_id, outcome: 'succeeded', completed_at: snapshot.at, snapshot } : { ok: true });
    } catch (e) {
      const code = /^[A-Z_]{2,80}$/.test(e.code ?? '') ? e.code : 'ACTION_FAILED';
      const outcome = e.operationOutcome === 'unknown' ? 'unknown' : 'failed';
      json(409, operationId(body?.operation_id) ? { ok: false, operation_id: body.operation_id, outcome, code } : { code });
    }
  });
}
