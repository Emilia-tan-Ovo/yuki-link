import { validateHeaderValue } from 'node:http';

export function normalizeCredential(raw) {
  if (typeof raw !== 'string') throw Error('凭据文件格式不正确');
  const value = raw.trim();
  if (!value || value.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(value)) throw Error('凭据文件格式不正确');
  try { validateHeaderValue('Authorization', `Bearer ${value}`); }
  catch { throw Error('凭据文件格式不正确'); }
  return value;
}
