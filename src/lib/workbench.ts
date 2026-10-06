import { api } from './api';
import type { Bootstrap, Connection, Engine, Offering, Session, UsageResponse } from './types';

export const v2 = <T,>(path: string, init?: RequestInit) => api<T>(`/api/v2${path}`, init);
export const mutate = <T,>(path: string, body: unknown, method = 'POST') => v2<T>(path, { method, body: JSON.stringify(body) });

export const bootstrap = () => v2<Bootstrap>('/bootstrap');
export const conversation = (id: string, before?: string) => v2<{ session: Session }>(`/conversations/${encodeURIComponent(id)}${before ? `?before=${encodeURIComponent(before)}` : ''}`);
export const offerings = () => v2<{ models: Offering[]; favorites: string[]; defaults: Partial<Record<Engine, string | null>>; refreshing: boolean; error?: string | null; fetchedAt: number | null; connections: Connection[] }>('/models');
export const connections = () => v2<{ connections: Connection[] }>('/connections');
export const usageReport = (days: number, projectId?: string) => v2<UsageResponse>(`/usage?days=${days}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`);

let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('workbench-local-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
export async function localRead<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => { const request = database.transaction('state').objectStore('state').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function localWrite(key: string, value: unknown) {
  const database = await db();
  return new Promise<void>((resolve, reject) => { const transaction = database.transaction('state', 'readwrite'); if (value === undefined) transaction.objectStore('state').delete(key); else transaction.objectStore('state').put(value, key); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
}

export function recentModels(engine: Engine): string[] {
  try {
    const all = JSON.parse(localStorage.getItem('workbench-recent-models') || '{}');
    return Array.isArray(all[engine]) ? all[engine] : [];
  } catch { return []; }
}
export function rememberModel(engine: Engine, id: string) {
  try {
    const all = JSON.parse(localStorage.getItem('workbench-recent-models') || '{}');
    all[engine] = [id, ...(Array.isArray(all[engine]) ? all[engine] : []).filter((value: string) => value !== id)].slice(0, 6);
    localStorage.setItem('workbench-recent-models', JSON.stringify(all));
  } catch { /* Recents are a convenience; ignore storage failures. */ }
}
