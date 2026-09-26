const REPOSITORY = 'Emilia-tan-Ovo/yuki-link';

export function harnessRoot(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1 && Number(url.port) <= 65535
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function harnessCandidateSource({ url, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const root = harnessRoot(url);
  if (!root) return null;
  const base = new URL(root);
  async function read(path, cookie) {
    const response = await fetchImpl(new URL(path, base).href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: cookie ? { Cookie: cookie } : {} });
    if (response.redirected || response.url && new URL(response.url).origin !== base.origin) throw Error('Harness 候选来源发生跳转。');
    if (!response.ok) throw Error('Harness 候选来源不可读取。');
    return response;
  }
  return { reason: 'Harness 关联', async search(repository, token) {
    if (repository !== REPOSITORY || !/^0?\d{3}$/u.test(token)) return [];
    const page = await read('/');
    const cookie = /^yuki_harness=[A-Za-z0-9]+$/u.exec(page.headers.get('set-cookie')?.split(';', 1)[0] ?? '')?.[0];
    await page.body?.cancel();
    if (!cookie) throw Error('Harness 只读会话不可用。');
    const overview = await (await read('/api/projects', cookie)).json();
    if (!Array.isArray(overview?.projects)) throw Error('Harness 候选内容无效。');
    const result = [];
    for (const project of overview.projects) {
      if (project.key !== 'yuki-link' || !Array.isArray(project.tickets)) continue;
      for (const ticket of project.tickets) {
        if (typeof ticket.key !== 'string' || typeof ticket.title !== 'string' || ![ticket.key,ticket.title].some(value => value.includes(token))) continue;
        let reference = ticket.reference;
        if (!reference && typeof ticket.id === 'string' && /^[0-9a-f-]{36}$/iu.test(ticket.id)) {
          const detail = await (await read(`/api/tickets/${ticket.id}`, cookie)).json();
          reference = detail?.ticket?.reference;
        }
        const match = typeof reference === 'string' && /^https:\/\/github\.com\/Emilia-tan-Ovo\/yuki-link\/issues\/([1-9]\d*)$/u.exec(reference);
        if (!match) continue;
        result.push({ repository, number: Number(match[1]), title: ticket.title, routeKey: ticket.key, url: reference });
      }
    }
    return result;
  } };
}
