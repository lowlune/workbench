import type {
  Agent, Bootstrap, Clip, ModelOption, Offering, Overview, ProcessInfo, Session,
  SystemSample, SystemSnapshot,
} from '@/lib/types';

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
    ? await response.json() as T & { error?: string }
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

export const postJson = <T,>(url: string, body: unknown) => api<T>(url, { method: 'POST', body: JSON.stringify(body) });

/* ---- v2 adapter: the restored UI keeps its original call signatures, the
   implementation talks to the durable control plane. ---- */

const v2 = <T,>(path: string, init?: RequestInit) => api<T>(`/api/v2${path}`, init);

let projectDirectories: { directory: string; id: string }[] = [];

export function projectIdForDirectory(directory?: string | null): string | null {
  if (!directory) return null;
  const match = projectDirectories.find((entry) => directory === entry.directory || directory.startsWith(`${entry.directory}/`));
  return match?.id || null;
}

export async function getOverview(): Promise<Overview> {
  const [boot, system] = await Promise.all([
    v2<Bootstrap>('/bootstrap'),
    v2<SystemSnapshot>('/system'),
  ]);
  projectDirectories = (boot.projects || []).map((project) => ({ directory: project.directory, id: project.id }));
  const sessions = boot.sessions || [];
  const agents: Agent[] = sessions
    .filter((session) => session.resumeStatus === 'working')
    .map((session) => {
      /* Mirror attentionOf(): a pending permission interaction (or a waiting
         run) must surface as `blocked` so ChatView's approval banner shows. */
      const blocked = session.attention === 'permission'
        || session.status === 'blocked'
        || session.activeRun?.status === 'waiting_for_permission'
        || (session.interactions || []).some((item) => item.kind === 'permission');
      return {
        paneId: session.id,
        agent: session.engine || 'opencode',
        status: blocked ? 'blocked' : 'working',
        title: session.title || 'Conversation',
        cwd: session.directory,
        sessionId: session.id,
        sessionTitle: session.title || null,
        updated: session.updated || null,
      };
    });
  const directories = [
    { name: 'Home workspace', directory: '/home' },
    ...(boot.projects || []).map((project) => ({ name: project.name, directory: project.directory })),
  ];
  return { system, agents, sessions, directories };
}

export const getSession = (id: string, _limit = 30) => v2<{ session: Session }>(`/conversations/${encodeURIComponent(id)}`);

export async function getSessionUpdates(id: string, since: string) {
  const { session } = await getSession(id);
  const updated = String(session.updated || 0);
  if (since === updated) return { changed: false, updated, resumeStatus: session.resumeStatus };
  return { changed: true, updated, resumeStatus: session.resumeStatus, session };
}

export const getOlderMessages = (id: string, before: string) =>
  v2<{ session: Session }>(`/conversations/${encodeURIComponent(id)}?before=${encodeURIComponent(before)}`);

export async function getHistory(params: URLSearchParams) {
  const q = params.get('q') || '';
  const directory = params.get('directory') || '';
  const projectId = directory ? projectDirectories.find((entry) => entry.directory === directory)?.id || '' : '';
  const search = new URLSearchParams();
  if (q) search.set('q', q);
  if (projectId) search.set('projectId', projectId);
  const result = await v2<{ sessions: Session[]; nextCursor?: string | null }>(`/conversations?${search.toString()}`);
  const sessions = result.sessions || [];
  return { sessions, total: sessions.length, nextCursor: result.nextCursor || null };
}

export async function getClips() {
  const result = await v2<{ clips: { id: string; projectId: string | null; title: string; text: string; pinned: number; created: number; attachment: { id: string; name: string; mime: string } | null }[] }>('/clips?projectId=all');
  const clips: Clip[] = result.clips.map((clip) => ({
    id: clip.id,
    kind: clip.attachment?.mime?.startsWith('image/') ? 'image' : 'text',
    text: clip.text || undefined,
    filename: clip.attachment?.name,
    mime: clip.attachment?.mime,
    created: clip.created,
    dataUrl: clip.attachment ? `/api/v2/attachments/${clip.attachment.id}` : undefined,
  }));
  return { clips };
}

export async function getModels() {
  const result = await v2<{ models: Offering[] }>('/models');
  const models: ModelOption[] = result.models.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextLimit: model.contextLimit,
    outputLimit: model.outputLimit,
  }));
  return { models };
}

export const getSystem = () => v2<SystemSnapshot>('/system');
export const getSystemHistory = () => v2<{ samples: SystemSample[]; intervalMs: number }>('/system/history');
export const getProcesses = () => v2<{ processes: ProcessInfo[] }>('/processes');
export const killProcess = (pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') =>
  v2<{ killed: boolean }>(`/processes/${pid}/kill`, { method: 'POST', body: JSON.stringify({ signal }) });

export async function regenerateSessionTitle(sessionId: string) {
  const result = await v2<{ session: Session }>(`/conversations/${encodeURIComponent(sessionId)}/title`, { method: 'POST', body: '{}' });
  return { sessionId, title: result.session.title || '', tags: result.session.tags || [] };
}

async function patchConversation(sessionId: string, patch: Record<string, unknown>) {
  const { session } = await getSession(sessionId);
  return v2<{ session: Session }>(`/conversations/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, revision: session.revision }),
  });
}

export async function setSessionMeta(sessionId: string, patch: { title?: string | null; pinned?: boolean; hidden?: boolean; projectId?: string | null; directory?: string | null; workspace?: string | null }) {
  const result = await patchConversation(sessionId, patch);
  return {
    sessionId,
    title: result.session.title || null,
    pinned: Boolean(result.session.pinned),
    hidden: Boolean(result.session.hidden),
  };
}

export async function setSessionModel(sessionId: string, model: string) {
  const result = await patchConversation(sessionId, { model });
  return { sessionId, model: result.session.modelPref || model };
}

export function getAgentOutput(): Promise<{ output: string }> {
  return Promise.reject(new ApiError('Live output is not available in this version.', 410));
}
