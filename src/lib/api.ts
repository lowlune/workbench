import type { Agent, ApiErrorPayload, Clip, Overview, Session } from '@/lib/types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json() as T & ApiErrorPayload
    : await response.text();
  if (!response.ok) {
    if (response.status === 401 && location.pathname !== '/login') location.assign('/login');
    const message = typeof payload === 'object' && payload && 'error' in payload
      ? payload.error || `Request failed (${response.status})`
      : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export const getOverview = () => api<Overview>('/api/overview');
export const getHistory = (params: URLSearchParams) => api<{ sessions: Session[]; total: number; directories: Overview['directories'] }>(`/api/sessions?${params}`);
export const getSession = (id: string, limit = 30) => api<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}?limit=${limit}`);
export const getSessionUpdates = (id: string, since: string) => api<{ changed: boolean; updated: string; resumeStatus?: Session['resumeStatus']; session?: Session }>(`/api/sessions/${encodeURIComponent(id)}/updates?since=${encodeURIComponent(since)}`);
export const getOlderMessages = (id: string, before: string) => api<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}?before=${encodeURIComponent(before)}`);
export const getClips = () => api<{ clips: Clip[] }>('/api/clips');
export const getAgentOutput = (agent: Agent) => api<{ output: string }>(`/api/agents/${encodeURIComponent(agent.paneId)}/output`);

export async function postJson<T>(url: string, body: unknown) {
  return api<T>(url, { method: 'POST', body: JSON.stringify(body) });
}
