import type { ConversationPage, OverviewDto, PatchDto, SessionDto, TicketDto } from '../src/harness/presentation-model';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === 'object' && 'code' in value ? String(value.code) : 'HTTP_' + response.status;
    throw new Error(code === 'SESSION_REQUIRED' ? '会话已失效，请重新载入页面。' : code);
  }
  return response.json() as Promise<T>;
}
export const api = {
  session: () => request<SessionDto>('/api/session'),
  overview: (signal?: AbortSignal) => request<OverviewDto>('/api/ui/projects', { signal }),
  ticket: (id: string, signal?: AbortSignal) => request<TicketDto>('/api/ui/tickets/' + id, { signal }),
  conversation: (id: string, query = '', signal?: AbortSignal) => request<ConversationPage>('/api/ui/conversations/' + id + query, { signal }),
  patch: async (ticketId: string, fileId: string, revision: string, signal: AbortSignal): Promise<PatchDto> => {
    const response = await fetch(`/api/tickets/${ticketId}/changes/files/${fileId}/patch?revision=${revision}`, { signal, cache: 'no-store', credentials: 'same-origin' });
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('file_id' in value) || !('state' in value)) throw new Error('无法读取文件变更');
    return value as PatchDto;
  },
  control: (ticketId: string, action: string, csrf: string) => request<{ outcome: string }>(`/api/tickets/${ticketId}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
  }),
};
