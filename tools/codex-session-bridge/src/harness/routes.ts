import type { Harness } from './harness.ts';
import { HarnessError } from './model.ts';
import type { PageQuery } from './conversations.ts';
import { Presentation } from './presentation.ts';
import { protectedCopy } from './content-policy.ts';
import { uuidPath } from './static-assets.ts';

const ticket = '/api/tickets/(' + uuidPath + ')';
const refresh = new RegExp('^' + ticket + '/refresh$');
const runStop = new RegExp('^' + ticket + '/runs/(' + uuidPath + ')/stop$');
const taskStop = new RegExp('^' + ticket + '/tasks/([^/]+)/stop$');
const open = new RegExp('^' + ticket + '/worktree/open$');
export const isControlPath = (path: string) => [refresh, runStop, taskStop, open].some(r => r.test(path));
const paging = (url: URL): PageQuery => {
  const result: PageQuery = {};
  for (const key of ['before', 'after', 'limit'] as const) {
    const values = url.searchParams.getAll(key);
    if (!values.length) continue;
    if (values.length !== 1 || !/^\d+$/.test(values[0]) || !Number.isSafeInteger(Number(values[0]))) throw new HarnessError('INVALID_CURSOR');
    result[key] = Number(values[0]);
  }
  if (result.before !== undefined && result.after !== undefined) throw new HarnessError('INVALID_CURSOR');
  return result;
};
export function routeGet(harness: Harness, url: URL) {
  const p = new Presentation(harness);
  if (url.pathname === '/api/projects') return protectedCopy(harness.overview()).value;
  if (url.pathname === '/api/ui/projects') return p.overview();
  let match = new RegExp('^/api/(ui/)?tickets/(' + uuidPath + ')$').exec(url.pathname);
  if (match) return match[1] ? p.ticket(match[2]) : protectedCopy(harness.detail(match[2], paging(url))).value;
  match = new RegExp('^/api/(ui/)?conversations/(' + uuidPath + ')$').exec(url.pathname);
  if (match) return match[1] ? p.conversation(match[2], paging(url)) : protectedCopy(harness.conversationDetail(match[2], paging(url))).value;
  match = new RegExp('^' + ticket + '/changes/files/([^/]+)/patch$').exec(url.pathname);
  if (match) {
    if (url.searchParams.getAll('revision').length !== 1) throw new HarnessError('INVALID_PATCH_REFERENCE');
    return harness.filePatch(match[1], match[2], url.searchParams.get('revision')!);
  }
  return null;
}
export function routeControl(harness: Harness, pathname: string) {
  let match = refresh.exec(pathname);
  if (match) return { status: 200, value: harness.refreshControls(match[1]), ticketId: match[1] };
  match = runStop.exec(pathname);
  if (match) {
    const value = harness.stopRun(match[1], match[2]);
    return { status: value.outcome === 'requested' ? 202 : value.outcome === 'active_run_changed' ? 409
      : value.outcome === 'request_failed' ? 503 : 200, value, ticketId: match[1] };
  }
  match = taskStop.exec(pathname);
  if (match) {
    const value = harness.stopTask(match[1], match[2]);
    return { status: value.outcome === 'requested' ? 202 : value.outcome === 'request_failed' ? 503 : 200, value, ticketId: match[1] };
  }
  match = open.exec(pathname);
  if (match) {
    const value = harness.openWorktree(match[1]);
    return { status: value.outcome === 'open_requested' ? 202 : 503, value, ticketId: match[1] };
  }
  throw new HarnessError('NOT_FOUND');
}
export function errorStatus(code: string) {
  if (code.endsWith('_NOT_FOUND') || code === 'NOT_FOUND') return 404;
  if (code.startsWith('INVALID_')) return 400;
  if (['TASK_EPOCH_EXPIRED', 'ATTRIBUTION_MISMATCH', 'WORKTREE_MISMATCH'].includes(code)) return 409;
  return 503;
}
