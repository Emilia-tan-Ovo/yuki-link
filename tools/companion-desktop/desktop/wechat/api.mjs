// Adapted from phoiex/AAAAGENT windows/code/desktop-pet/wechat/api.ts
// at 2752349bcc7f7137b8b9e4ff9cccf34026d77aad (AAAAGENT noncommercial attribution license).
// Lossless ID parsing follows Tencent/openclaw-weixin 7c04adc (MIT).
import { randomBytes } from 'node:crypto';

export const ILINK_ORIGIN = 'https://ilinkai.weixin.qq.com';
export class WeChatApiError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

export function weixinOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new WeChatApiError('invalid_response'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com')) || !/^https:\/\/[^/:]+\/?$/.test(value)) throw new WeChatApiError('invalid_response');
  return url.origin;
}

// Quote only JSON object uint64 identifier values before JSON.parse rounds them.
export function parseWeixinJson(raw) {
  let output = '', index = 0;
  const ids = new Set(['message_id', 'msg_id', 'svr_id']);
  while (index < raw.length) {
    if (raw[index] !== '"') { output += raw[index++]; continue; }
    const start = index++;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const token = raw.slice(start, index);
    output += token;
    let cursor = index;
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    if (raw[cursor] !== ':') continue;
    let key;
    try { key = JSON.parse(token); } catch { continue; }
    if (!ids.has(key)) continue;
    output += raw.slice(index, ++cursor);
    while (/\s/.test(raw[cursor] ?? '')) output += raw[cursor++];
    const numberStart = cursor;
    while (/\d/.test(raw[cursor] ?? '')) cursor++;
    if (cursor > numberStart && !/[.eE\d]/.test(raw[cursor] ?? '')) { output += JSON.stringify(raw.slice(numberStart, cursor)); index = cursor; }
    else index = numberStart;
  }
  return JSON.parse(output);
}

export class WeChatApi {
  constructor(transport = fetch) { this.transport = transport; }
  async request(base, path, signal, body, token, timeoutMs = 20000) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 9) };
    if (body) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    try {
      const response = await this.transport(new URL(path, weixinOrigin(base)), { method: body ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new WeChatApiError(response.status === 401 || response.status === 403 ? 'expired' : 'network');
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new WeChatApiError('invalid_response');
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw new WeChatApiError('invalid_response');
      const data = parseWeixinJson(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WeChatApiError('invalid_response');
      if (data.ret === -14 || data.errcode === -14) throw new WeChatApiError('expired');
      if (data.ret !== undefined && data.errcode !== undefined && (data.ret === 0) !== (data.errcode === 0)) throw new WeChatApiError('invalid_response');
      if (data.ret !== undefined && data.ret !== 0 || data.errcode !== undefined && data.errcode !== 0) throw new WeChatApiError('rejected');
      return data;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WeChatApiError) throw error;
      throw new WeChatApiError('network');
    }
  }
  qr(signal) { return this.request(ILINK_ORIGIN, '/ilink/bot/get_bot_qrcode?bot_type=3', signal, { local_token_list: [] }); }
  qrStatus(base, qr, signal, code) { return this.request(base, `/ilink/bot/get_qrcode_status?${new URLSearchParams({ qrcode: qr, ...(code ? { verify_code: code } : {}) })}`, signal, undefined, undefined, 35000); }
  updates(auth, cursor, signal, timeoutMs = 35000) { return this.request(auth.baseUrl, '/ilink/bot/getupdates', signal, { get_updates_buf: cursor, base_info: this.baseInfo() }, auth.token, timeoutMs + 5000); }
  send(auth, context, text, clientId, signal) {
    if (!context) throw new WeChatApiError('rejected');
    return this.request(auth.baseUrl, '/ilink/bot/sendmessage', signal, { msg: { from_user_id: '', to_user_id: auth.userId, client_id: clientId, message_type: 2, message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text } }] }, base_info: this.baseInfo() }, auth.token);
  }
  baseInfo() { return { channel_version: '2.4.9-beta.0', bot_agent: 'YukiLink/0.1' }; }
}
