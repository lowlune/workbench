import { api, ApiError } from './api';
import type {
  Attention, Bootstrap, Connection, Engine, NotificationItem, Offering, RunState,
  Session, UsageLimit, UsagePacing, UsageResponse,
} from './types';

export const v2 = <T,>(path: string, init?: RequestInit) => api<T>(`/api/v2${path}`, init);
export const mutate = <T,>(path: string, body: unknown, method = 'POST') => v2<T>(path, { method, body: JSON.stringify(body) });

/* Some endpoints (usage limits/pacing, notifications) may not exist yet on an
   older control plane. A 404 becomes an empty result instead of a crash. */
export async function v2Optional<T>(path: string, init?: RequestInit): Promise<T | undefined> {
  try { return await v2<T>(path, init); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

export const bootstrap = () => v2<Bootstrap>('/bootstrap');
export const conversation = (id: string, before?: string) => v2<{ session: Session }>(`/conversations/${encodeURIComponent(id)}${before ? `?before=${encodeURIComponent(before)}` : ''}`);
export const conversationPrompts = (id: string) => v2<{ prompts: { id: string; preview: string; created: number }[] }>(`/conversations/${encodeURIComponent(id)}/prompts`);
export const steerConversation = (id: string, body: { text: string; model?: string }) => mutate<{ steered: boolean; queued?: boolean; commandId?: string }>(`/conversations/${encodeURIComponent(id)}/steer`, body);
export const offerings = () => v2<{ models: Offering[]; favorites: string[]; defaults: Partial<Record<Engine, string | null>>; refreshing: boolean; error?: string | null; fetchedAt: number | null; connections: Connection[] }>('/models');
export const connections = () => v2<{ connections: Connection[] }>('/connections');
export const usageReport = (days: number, projectId?: string) => v2<UsageResponse>(`/usage?days=${days}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`);

export const archivedConversations = () => v2<{ sessions: Session[]; nextCursor?: string | null }>('/conversations?hidden=true');

/* ---- Usage limits and pacing (§30–32) ---- */

export const usageLimits = () => v2Optional<{ limits?: UsageLimit[]; usageLimits?: UsageLimit[] }>('/usage/limits');
export const usagePacing = () => v2Optional<UsagePacing & { pacing?: UsagePacing }>('/usage/pacing');
export const saveUsageLimit = (limit: Partial<UsageLimit>) => mutate<{ limit?: UsageLimit; ok?: boolean }>('/usage/limits', limit);
export const deleteUsageLimit = (id: string) => mutate(`/usage/limits/${encodeURIComponent(id)}`, {}, 'DELETE');

/* ---- Notifications (§33) ---- */

export async function notifications() {
  const result = await v2Optional<{ notifications?: NotificationItem[]; items?: NotificationItem[]; unread?: number }>('/notifications');
  const list = result?.notifications || result?.items || [];
  return { notifications: list, unread: result?.unread ?? list.filter((item) => !item.read).length };
}
export const markNotificationRead = (id: string) => mutate(`/notifications/${encodeURIComponent(id)}`, { read: true }, 'PATCH');
export const markAllNotificationsRead = () => mutate('/notifications/read-all', {});

/* ---- Run/attention selectors (§17/§18) ---- */

export const ACTIVE_RUN_STATES = new Set<string>([
  'queued', 'starting', 'running', 'waiting', 'waiting_for_user',
  'waiting_for_permission', 'stopping', 'interrupting',
]);

export function runStateOf(session: Session): RunState | null {
  if (session.activeRun?.status) return session.activeRun.status;
  if (session.runStatus) return session.runStatus;
  if (session.status && session.status !== 'idle') return session.status;
  return null;
}

export function isRunningSession(session: Session): boolean {
  const state = runStateOf(session);
  if (state && ACTIVE_RUN_STATES.has(state)) return true;
  return session.resumeStatus === 'working' || session.status === 'working';
}

export function attentionOf(session: Session): Attention {
  if (session.attention === 'waiting' || session.attention === 'permission') return session.attention;
  const state = runStateOf(session);
  if (state === 'waiting_for_permission') return 'permission';
  if (state === 'waiting' || state === 'waiting_for_user') return 'waiting';
  if ((session.interactions || []).some((item) => item.kind === 'permission')) return 'permission';
  if ((session.interactions || []).some((item) => item.kind === 'question')) return 'waiting';
  if (session.status === 'blocked') return 'permission';
  return 'none';
}

export function runStatusLabel(state?: RunState | null): string {
  switch (state) {
    case 'queued': return 'Queued';
    case 'starting': return 'Starting';
    case 'working':
    case 'running': return 'Working';
    case 'waiting':
    case 'waiting_for_user': return 'Waiting for input';
    case 'waiting_for_permission': return 'Permission required';
    case 'stopping':
    case 'interrupting': return 'Stopping';
    case 'interrupted':
    case 'interrupted_by_restart': return 'Interrupted';
    case 'completed':
    case 'succeeded': return 'Completed';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return state ? String(state) : 'Idle';
  }
}

export function isTerminalRunState(state?: RunState | null): boolean {
  return Boolean(state && ['interrupted', 'interrupted_by_restart', 'completed', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(state));
}

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

/* ---- Git worktree changes and apply/discard (§12, §46) ---- */

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface RunChanges {
  status: 'none' | 'active' | 'applied' | 'discarded' | 'conflict' | 'missing' | string;
  files: ChangedFile[];
  additions?: number;
  deletions?: number;
  patch?: string;
  worktreeId?: string;
  branch?: string;
  baseCommit?: string;
  error?: string | null;
}

export const runChanges = (runId: string, patch = false) =>
  v2<RunChanges>(`/runs/${encodeURIComponent(runId)}/changes${patch ? '?patch=1' : ''}`);
export const conversationChanges = (conversationId: string, patch = false) =>
  v2<RunChanges>(`/conversations/${encodeURIComponent(conversationId)}/changes${patch ? '?patch=1' : ''}`);
export const applyRun = (runId: string) => mutate<RunChanges>(`/runs/${encodeURIComponent(runId)}/apply`, {});
export const discardRun = (runId: string) => mutate<RunChanges>(`/runs/${encodeURIComponent(runId)}/discard`, {});

/* ---- AGENTS.md instructions (§29) ---- */

export interface AgentInstructionFile {
  scope: 'global' | 'project' | 'nested' | string;
  path: string;
  label: string;
  exists: boolean;
  content: string;
}

export interface AgentInstructionResponse {
  files: AgentInstructionFile[];
  global?: string;
  project?: string;
}

export function agentInstructionFiles(projectId?: string | null, path?: string | null) {
  const search = new URLSearchParams();
  if (projectId && projectId !== 'general') search.set('projectId', projectId);
  if (path) search.set('path', path);
  const query = search.toString();
  return v2<AgentInstructionResponse>(`/agents-md${query ? `?${query}` : ''}`);
}

export function saveAgentInstruction({ scope, projectId, path, content }: { scope: string; projectId?: string | null; path?: string | null; content: string }) {
  return mutate<{ saved: boolean; path: string; scope: string }>('/agents-md', { scope, projectId, path, content });
}

/* ---- Control-plane settings and live run capacity (§11) ---- */

export const saveSettings = (patch: Record<string, unknown>) => mutate<{ ok?: boolean }>('/settings', patch);

export interface Health {
  ok?: boolean;
  version?: number;
  maxRuns?: number;
  active?: number;
  queued?: number;
  runs?: { conversationId: string; commandId: string; phase: string; waiting?: boolean; worktreeId?: string | null }[];
  worktrees?: string;
}

export const health = () => v2<Health>('/health');
