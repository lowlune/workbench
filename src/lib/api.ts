export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const UNAUTHORIZED_EVENT = 'workbench-unauthorized';

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
    ? await response.json() as T & { error?: string }
    : await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      if (location.pathname !== '/login') location.assign('/login');
    }
    const message = typeof payload === 'object' && payload && 'error' in payload
      ? payload.error || `Request failed (${response.status})`
      : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}
