import { createHash } from 'node:crypto';
const REPOSITORY = 'Emilia-tan-Ovo/yuki-link';
const API = 'https://api.github.com';
export const GITHUB_ISSUE_TIMEOUT_MS = 15_000;
const canonical = (repository, item) => item && !item.pull_request && Number.isSafeInteger(item.number) && item.number > 0 && typeof item.title === 'string' && item.title.trim() && item.html_url === `https://github.com/${repository}/issues/${item.number}`
  ? { repository, number: item.number, id: Number.isSafeInteger(item.id) ? item.id : null, title: item.title, url: item.html_url,
    state: item.state ?? null, marker: item.title.match(/\b[A-Z][A-Z0-9]+-\d{3}\b/u)?.[0] ?? null,
    scope: typeof item.body === 'string' && Number.isSafeInteger(item.id) ? { digest: createHash('sha256').update(JSON.stringify({ repository, id: item.id, number: item.number, title: item.title, body: item.body })).digest('hex'), observedAt: new Date().toISOString() } : null } : null;

export function githubIssueSource({ fetchImpl = fetch, timeoutMs = GITHUB_ISSUE_TIMEOUT_MS } = {}) {
  async function read(url) {
    const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (response.status === 404) return null;
    if (!response.ok) throw Error('GitHub 只读来源不可用。');
    return response.json();
  }
  function check(repository) { if (repository !== REPOSITORY) throw Error('未配置此 canonical 仓库。'); }
  return {
    async lookup(repository, number) {
      check(repository);
      if (!Number.isSafeInteger(number) || number < 1) throw Error('Issue 编号无效。');
      const item = await read(`${API}/repos/${repository}/issues/${number}`);
      return canonical(repository, item);
    },
    async details(repository, number) {
      check(repository);
      if (!Number.isSafeInteger(number) || number < 1) throw Error('Issue 编号无效。');
      const item = await read(`${API}/repos/${repository}/issues/${number}`);
      const ticket = canonical(repository,item);
      return ticket ? { ...ticket, body: item.body } : null;
    },
    async search(repository, token) {
      check(repository);
      if (!/^0?\d{3}$/u.test(token)) throw Error('Ticket 简称无效。');
      const query = new URLSearchParams({ q: `repo:${repository} is:issue in:title ${token}`, per_page: '100' });
      const result = await read(`${API}/search/issues?${query}`);
      if (!result || !Array.isArray(result.items) || result.incomplete_results || result.total_count > result.items.length) throw Error('GitHub 候选读取不完整。');
      return result.items.filter(item => item.repository_url === `${API}/repos/${repository}`).map(item => canonical(repository,item)).filter(Boolean);
    }
  };
}
