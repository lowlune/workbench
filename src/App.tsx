import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconClipboardText, IconClock, IconHome, IconLoader2 } from '@tabler/icons-react';
import { AgentsMdDialog } from '@/components/whirl/agents-md-dialog';
import type { ChangesTarget } from '@/components/whirl/changes-panel';
import { ChatView } from '@/components/whirl/chat-view';
import { ClipsView } from '@/components/whirl/pages/clips-view';
import { HistoryView } from '@/components/whirl/pages/history-view';
import { HomeView } from '@/components/whirl/pages/home-view';
import { NotificationsCenter } from '@/components/whirl/pages/notifications-center';
import { RenameDialog } from '@/components/whirl/rename-dialog';
import { SearchPalette } from '@/components/whirl/search-palette';
import { useSessionMenu } from '@/components/whirl/session-menu';
import { HorizontalTabs } from '@/components/whirl/tabs/horizontal-tabs';
import { useTabsShortcuts } from '@/components/whirl/tabs/use-tabs-shortcuts';
import { Sidebar, type AppView, type CurrentModelChip, type UsageStatusChip } from '@/components/whirl/sidebar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { ApiError, getSession, projectIdForDirectory, regenerateSessionTitle, setSessionMeta, setSessionModel } from '@/lib/api';
import { useConsoleQueries } from '@/lib/use-console-queries';
import { useSessionRepair } from '@/lib/use-session-repair';
import type { Attachment } from '@/lib/attachments';
import type { Agent, Attention, Message, MessagePart, Overview, QueuedMessage, Session, UsagePacing, UsageResponse, WorkbenchEvent } from '@/lib/types';
import {
  ACTIVE_RUN_STATES, agentInstructionFiles, attentionOf,
  isRunningSession, isTerminalRunState, mutate,
  runStateOf, saveSettings,
} from '@/lib/workbench';
import {
  adoptServerTabs, closeAllTabs, closeOtherTabs, closeTab, forgetTabScroll, MAX_TABS, openTab,
  reconcileTabs, reorderTabs, setTabsServerSync, togglePin, useTabs, type TabView,
} from '@/lib/tabs';
import { notifyForEvent } from '@/lib/notifications';
import { cn } from '@/lib/utils';

const UsageView = lazy(() => import('@/components/whirl/pages/usage-view'));
const ChangesPanel = lazy(() => import('@/components/whirl/changes-panel').then(module => ({ default: module.ChangesPanel })));
const SystemPanel = lazy(() => import('@/components/whirl/system-panel').then(module => ({ default: module.SystemPanel })));

interface Route {
  view: AppView;
  sessionId?: string;
}

interface DraftState {
  text: string;
  attachments: Attachment[];
}

interface ToastMessage {
  id: number;
  text: string;
  error: boolean;
}

function readRoute(): Route {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('chat/')) {
    try { return { view: 'chat', sessionId: decodeURIComponent(hash.slice(5)) }; }
    catch { return { view: 'home' }; }
  }
  if (hash === 'history') return { view: 'history' };
  if (hash === 'clips') return { view: 'clips' };
  if (hash === 'usage') return { view: 'usage' };
  return { view: 'home' };
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('workbench-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Fall through to the system preference. */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function hashFor(route: Route) {
  if (route.view === 'chat' && route.sessionId) return `#chat/${encodeURIComponent(route.sessionId)}`;
  return route.view === 'home' ? '#now' : `#${route.view}`;
}

function mergeSession(previous: Session | undefined, incoming: Session, mode: 'merge' | 'prepend' = 'merge'): Session {
  if (!previous) return incoming;
  const previousMessages = previous.messages || [];
  const incomingMessages = incoming.messages || [];
  const byId = new Map<string, Message>();
  for (const message of (mode === 'prepend' ? [...incomingMessages, ...previousMessages] : [...previousMessages, ...incomingMessages])) {
    byId.set(message.id, message);
  }
  const messages = [...byId.values()].sort((a, b) => Number(a.created || 0) - Number(b.created || 0));
  return {
    ...previous,
    ...incoming,
    messages,
    messageTotal: incoming.messageTotal ?? previous.messageTotal,
    hasMoreMessages: incoming.hasMoreMessages ?? previous.hasMoreMessages,
  };
}

/* Streaming text arrives as deltas: patch the one message instead of
   refetching the whole transcript (§34). */
function appendDelta(session: Session, messageId: string, delta: string): Session {
  if (!session.messages) return session;
  let changed = false;
  const messages = session.messages.map((message) => {
    if (message.id !== messageId) return message;
    changed = true;
    const parts = message.parts?.length ? [...message.parts] : [];
    let textIndex = -1;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index].type === 'text') { textIndex = index; break; }
    }
    if (textIndex === -1) parts.push({ id: `text_${messageId}`, type: 'text', text: delta });
    else parts[textIndex] = { ...parts[textIndex], text: (parts[textIndex].text || '') + delta };
    return { ...message, parts };
  });
  return changed ? { ...session, messages } : session;
}

function patchToolPart(session: Session, toolCallId: string, patch: Partial<NonNullable<MessagePart['state']>>): Session {
  if (!session.messages) return session;
  let changed = false;
  const messages = session.messages.map((message) => {
    if (!(message.parts || []).some((part) => part.callID === toolCallId)) return message;
    changed = true;
    return {
      ...message,
      parts: (message.parts || []).map((part) => part.callID === toolCallId
        ? { ...part, state: { ...(part.state || {}), ...patch } }
        : part),
    };
  });
  return changed ? { ...session, messages } : session;
}

function computeUsageStatus(pacing?: UsagePacing, weekly?: UsageResponse): UsageStatusChip | null {
  if (pacing) {
    const metric = pacing.tokens?.limit != null ? pacing.tokens
      : pacing.cost?.limit != null ? pacing.cost
        : pacing.requests?.limit != null ? pacing.requests
          : undefined;
    if (metric) {
      const percent = metric.percent ?? (metric.limit ? (Number(metric.used || 0) / metric.limit) * 100 : undefined);
      const period = pacing.period === 'monthly' ? 'Monthly' : pacing.period === 'weekly' ? 'Weekly' : (pacing.period || 'Budget');
      const suffix = pacing.source === 'manual' ? ' · manual' : pacing.source === 'estimated' ? ' · est.' : '';
      const label = percent != null ? `${period} ${Math.round(percent)}%${suffix}` : `${period} budget`;
      return { label, percent: percent ?? undefined, tone: percent == null ? 'ok' : percent >= 100 ? 'over' : percent >= 80 ? 'warn' : 'ok' };
    }
  }
  if (weekly?.totals) return { label: `${weekly.totals.requests} req · 7d`, tone: 'ok' };
  return null;
}

const emptyOverview: Overview = { agents: [], sessions: [], directories: [], system: {} };

export default function App() {
  const queryClient = useQueryClient();
  const [route, setRoute] = useState<Route>(readRoute);
  const [previousView, setPreviousView] = useState<Exclude<AppView, 'chat'>>('home');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [taskFocusSignal, setTaskFocusSignal] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [modelSelections, setModelSelections] = useState<Record<string, string>>({});
  const [renameTarget, setRenameTarget] = useState<Session>();
  const [deleteTarget, setDeleteTarget] = useState<Session>();
  const [changesTarget, setChangesTarget] = useState<ChangesTarget | null>(null);
  const [agentsTarget, setAgentsTarget] = useState<Session | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maxRunsDraft, setMaxRunsDraft] = useState('2');
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [sendingSessionId, setSendingSessionId] = useState<string>();
  const streamConnected = useRef(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const notifiedRef = useRef<Map<string, number>>(new Map());
  const archivedOpenRef = useRef(archivedOpen);

  const { overviewQuery, systemQuery, bootQuery, modelsQuery, pacingQuery, weeklyUsageQuery,
    notificationsQuery, archivedQuery, healthQuery } = useConsoleQueries({ settingsOpen, archivedOpen });
  const overview = overviewQuery.data;

  const agent = overview?.agents.find((item) => item.sessionId === route.sessionId);
  const liveSessionId = route.sessionId;

  const sessionQuery = useQuery({
    queryKey: ['session', liveSessionId],
    queryFn: () => getSession(liveSessionId!, 30),
    enabled: route.view === 'chat' && Boolean(liveSessionId),
    staleTime: Infinity,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const session = sessionQuery.data?.session;
  const chatConnectionError = useSessionRepair(route.view === 'chat' ? liveSessionId : undefined, Boolean(session), streamConnected, mergeSession);
  const draftKey = liveSessionId || 'new-task';
  const draft = drafts[draftKey] || { text: '', attachments: [] };

  const sessions = overview?.sessions || [];
  const attentionSessions = useMemo(() => sessions.filter((item) => attentionOf(item) !== 'none'), [sessions]);
  const runningSessions = useMemo(
    () => sessions.filter((item) => isRunningSession(item) && attentionOf(item) === 'none'),
    [sessions],
  );

  const activeSession = session || sessions.find((item) => item.id === route.sessionId);

  /* Tabs: the store holds the working set, while the
     active tab stays the route (`#chat/:id`). Each tab is a light, derived view
     over overview/SSE — no second transcript is mounted. */
  const tabs = useTabs();
  const [extraSessions, setExtraSessions] = useState<Record<string, Session>>({});
  const sessionById = useMemo(() => {
    const map = new Map<string, Session>();
    for (const item of Object.values(extraSessions)) map.set(item.id, item);
    for (const item of sessions) map.set(item.id, item);
    if (session) map.set(session.id, session);
    return map;
  }, [extraSessions, sessions, session]);
  const tabViews = useMemo<TabView[]>(() => tabs.order.map((id) => {
    const item = sessionById.get(id);
    return {
      id,
      title: item?.title || 'Conversation',
      status: item ? runStateOf(item) : null,
      attention: item ? attentionOf(item) : 'none',
      running: item ? isRunningSession(item) : false,
      pinned: tabs.pinned.includes(id),
      projectId: item?.projectId,
      updated: item?.updated,
      started: item?.activeRun?.started ?? null,
    };
  }), [tabs.order, tabs.pinned, sessionById]);
  /* A subtle "AGENTS.md active" hint for the open chat (§29); shares its query
     cache with the dialog. */
  const agentsIndicatorQuery = useQuery({
    queryKey: ['agents-md', activeSession?.projectId ?? null, activeSession?.directory ?? ''],
    queryFn: () => agentInstructionFiles(activeSession?.projectId ?? null, activeSession?.directory ?? null),
    enabled: route.view === 'chat' && Boolean(activeSession),
    staleTime: 60_000,
    retry: 0,
  });
  const agentsMdActive = Boolean(agentsIndicatorQuery.data?.files?.some((file) => file.exists && String(file.content || '').trim()));
  const maxRuns = healthQuery.data?.maxRuns ?? bootQuery.data?.maxRuns ?? 1;
  const activeRuns = healthQuery.data?.active ?? 0;
  const queuedRuns = healthQuery.data?.queued ?? 0;
  const currentModelId = (liveSessionId ? modelSelections[liveSessionId] : undefined)
    || activeSession?.modelPref
    || bootQuery.data?.defaults?.[activeSession?.engine || 'pi']
    || bootQuery.data?.defaults?.opencode
    || null;
  const currentOffering = modelsQuery.data?.models.find((model) => model.id === currentModelId);
  const currentModel: CurrentModelChip | null = currentModelId
    ? { id: currentModelId, name: currentOffering?.name || currentModelId.split('/').pop() || currentModelId, provider: currentOffering?.provider }
    : null;
  const usageStatus = useMemo(
    () => computeUsageStatus(pacingQuery.data, weeklyUsageQuery.data),
    [pacingQuery.data, weeklyUsageQuery.data],
  );
  const unreadNotifications = notificationsQuery.data?.unread || 0;

  const showToast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, text, error }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  useEffect(() => { archivedOpenRef.current = archivedOpen; }, [archivedOpen]);

  /* One SSE stream drives every cache update: targeted message/run/tool/todo
     patches, with debounced invalidations only for aggregates (§4, §34). */
  useEffect(() => {
    const seq = bootQuery.data?.seq;
    if (seq === undefined) return;
    const stream = new EventSource(`/api/v2/events?after=${seq}`);
    stream.onopen = () => { streamConnected.current = true; };
    stream.onerror = () => { streamConnected.current = false; };
    const timers: Record<string, number> = {};
    const schedule = (key: string, fn: () => void, ms = 150) => {
      window.clearTimeout(timers[key]);
      timers[key] = window.setTimeout(fn, ms);
    };
    const patchSession = (id: string, updater: (session: Session) => Session) => {
      queryClient.setQueryData<{ session: Session }>(['session', id], (current) =>
        current ? { session: updater(current.session) } : current);
    };
    const touchSession = (id?: string | null, ms = 250) => {
      if (!id) return;
      schedule(`session:${id}`, () => void queryClient.invalidateQueries({ queryKey: ['session', id] }), ms);
    };
    const invalidateOverview = () => schedule('overview', () => void queryClient.invalidateQueries({ queryKey: ['overview'] }));
    const invalidateUsage = (ms = 800) => {
      schedule('usage', () => void queryClient.invalidateQueries({ queryKey: ['usage'] }), ms);
      schedule('usage-pacing', () => void queryClient.invalidateQueries({ queryKey: ['usage-pacing'] }), ms);
    };
    const notifyOnce = (key: string, text: string, error = false) => {
      const now = Date.now();
      if (now - (notifiedRef.current.get(key) || 0) < 30_000) return;
      notifiedRef.current.set(key, now);
      if (notifiedRef.current.size > 200) notifiedRef.current.delete(notifiedRef.current.keys().next().value!);
      showToast(text, error);
    };
    const numberOr = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

    stream.onmessage = (event) => {
      let data: WorkbenchEvent;
      try { data = JSON.parse(event.data) as WorkbenchEvent; }
      catch { return; }
      const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined;
      const status = typeof data.status === 'string' ? data.status : undefined;

      switch (data.type) {
        case 'text.delta': {
          const messageId = typeof data.messageId === 'string' ? data.messageId : undefined;
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (conversationId && messageId && delta) {
            let patched = false;
            queryClient.setQueryData<{ session: Session }>(['session', conversationId], (current) => {
              if (!current) return current;
              const next = appendDelta(current.session, messageId, delta);
              patched = next !== current.session;
              return patched ? { session: next } : current;
            });
            if (!patched) touchSession(conversationId, 250);
          }
          return;
        }
        case 'message.updated': {
          const message = data.message as Message | undefined;
          if (conversationId && message) {
            queryClient.setQueryData<{ session: Session }>(['session', conversationId], (current) =>
              current ? { session: mergeSession(current.session, { id: conversationId, messages: [message] }) } : current);
          } else if (conversationId) touchSession(conversationId);
          return;
        }
        case 'tool.started':
        case 'tool.completed': {
          const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
          if (conversationId && toolCallId) {
            const patch: Partial<NonNullable<MessagePart['state']>> = data.type === 'tool.started'
              ? { status: 'running', title: typeof data.title === 'string' ? data.title : undefined, input: data.input }
              : {
                status: typeof data.status === 'string' ? data.status : 'completed',
                output: typeof data.summary === 'string' ? data.summary : undefined,
                error: typeof data.error === 'string' ? data.error : undefined,
              };
            let patched = false;
            queryClient.setQueryData<{ session: Session }>(['session', conversationId], (current) => {
              if (!current) return current;
              const next = patchToolPart(current.session, toolCallId, patch);
              patched = next !== current.session;
              return patched ? { session: next } : current;
            });
            if (!patched) touchSession(conversationId, 300);
          }
          return;
        }
        case 'todo.updated': {
          const todos = Array.isArray(data.todos) ? data.todos : undefined;
          if (conversationId && todos) {
            patchSession(conversationId, (current) => {
              const run = current.activeRun;
              return {
                ...current,
                todos: todos as Session['todos'],
                /* Consumers prefer `activeRun.todos` for the live run, so keep
                   both in sync or the task list shows stale todos. */
                activeRun: run ? { ...run, todos: todos as Session['todos'] } : run,
              };
            });
          }
          return;
        }
        case 'run.state':
        case 'run.updated': {
          invalidateOverview();
          schedule('health', () => void queryClient.invalidateQueries({ queryKey: ['health'] }));
          const runId = typeof data.runId === 'string' ? data.runId
            : typeof data.commandId === 'string' ? data.commandId : undefined;
          const nextStatus = status || 'running';
          const attention: Attention = nextStatus === 'waiting_for_permission' ? 'permission'
            : (nextStatus === 'waiting' || nextStatus === 'waiting_for_user') ? 'waiting' : 'none';
          if (conversationId) {
            patchSession(conversationId, (current) => {
              const run = current.activeRun;
              const nextRun = {
                id: runId || run?.id || '',
                status: nextStatus,
                error: (data.error as string | null | undefined) ?? run?.error ?? null,
                model: (typeof data.model === 'string' && data.model) || run?.model || current.modelPref || '',
                started: (typeof data.started === 'number' ? data.started : run?.started) ?? null,
                ended: (typeof data.ended === 'number' ? data.ended : run?.ended) ?? null,
                usage: run?.usage ?? null,
              };
              return {
                ...current,
                activeRun: nextRun,
                runStatus: nextStatus,
                attention,
                resumeStatus: ACTIVE_RUN_STATES.has(nextStatus) ? 'working' : 'idle',
              };
            });
            if (attention !== 'none') {
              notifyOnce(`attention:${conversationId}`, attention === 'permission' ? 'A run needs your permission.' : 'A run is waiting for your input.');
            }
          }
          if (isTerminalRunState(nextStatus)) {
            touchSession(conversationId, 150);
            invalidateOverview();
            invalidateUsage();
          }
          return;
        }
        case 'run.completed': {
          if (conversationId) {
            patchSession(conversationId, (current) => {
              const run = current.activeRun;
              const nextStatus = status || 'completed';
              return {
                ...current,
                attention: 'none',
                runStatus: nextStatus,
                resumeStatus: 'idle',
                activeRun: run ? { ...run, status: nextStatus, ended: Date.now() } : run,
              };
            });
            touchSession(conversationId, 150);
          }
          invalidateOverview();
          invalidateUsage();
          return;
        }
        case 'attention.changed': {
          const attention = (typeof data.attention === 'string' ? data.attention : 'none') as Attention;
          if (conversationId) {
            patchSession(conversationId, (current) => ({ ...current, attention }));
            if (attention !== 'none') {
              notifyOnce(`attention:${conversationId}`, attention === 'permission' ? 'A run needs your permission.' : 'A run is waiting for your input.');
            }
          }
          invalidateOverview();
          return;
        }
        case 'usage.updated': {
          if (conversationId) {
            const usage = {
              input: numberOr(data.input),
              output: numberOr(data.output),
              cacheRead: numberOr(data.cacheRead),
              cacheWrite: numberOr(data.cacheWrite),
              cost: typeof data.cost === 'number' ? data.cost : null,
            };
            patchSession(conversationId, (current) => {
              const run = current.activeRun;
              return run ? { ...current, activeRun: { ...run, usage } } : current;
            });
          }
          invalidateUsage(1_000);
          return;
        }
        case 'notification.created': {
          void queryClient.invalidateQueries({ queryKey: ['notifications'] });
          const title = typeof data.title === 'string' ? data.title : 'Workbench';
          const body = typeof data.body === 'string' ? data.body : undefined;
          const kind = typeof data.kind === 'string' ? data.kind : '';
          notifyForEvent({ kind, title, body });
          return;
        }
        case 'model.changed': {
          if (conversationId) touchSession(conversationId, 200);
          schedule('bootstrap', () => void queryClient.invalidateQueries({ queryKey: ['bootstrap'] }));
          schedule('model-offerings', () => void queryClient.invalidateQueries({ queryKey: ['model-offerings'] }));
          return;
        }
        case 'file.changed':
        case 'file.read':
        case 'command.started':
        case 'command.completed':
        case 'test.completed':
        case 'git.diff.updated':
          touchSession(conversationId, 300);
          return;
        case 'conversation.changed':
          invalidateOverview();
          schedule('history', () => void queryClient.invalidateQueries({ queryKey: ['history'] }));
          touchSession(conversationId, 150);
          if (archivedOpenRef.current) schedule('archived', () => void queryClient.invalidateQueries({ queryKey: ['archived'] }));          return;
        case 'command.accepted':
        case 'interaction.created':
        case 'interaction.answered':
          touchSession(conversationId, 150);
          invalidateOverview();
          return;
        case 'projects.changed':
          invalidateOverview();
          schedule('bootstrap', () => void queryClient.invalidateQueries({ queryKey: ['bootstrap'] }));
          return;
        case 'clips.changed':
          void queryClient.invalidateQueries({ queryKey: ['clips'] });
          return;
        case 'models.changed':
          void queryClient.invalidateQueries({ queryKey: ['models'] });
          void queryClient.invalidateQueries({ queryKey: ['model-offerings'] });
          return;
        case 'resync':
          void queryClient.invalidateQueries();
          return;
        default:
          return;
      }
    };
    return () => {
      stream.close();
      streamConnected.current = false;
      for (const timer of Object.values(timers)) window.clearTimeout(timer);
    };
  }, [bootQuery.isSuccess, queryClient, showToast]);

  const navigate = useCallback((view: Exclude<AppView, 'chat'>, directory?: string | null, replace = false) => {
    if (route.view !== 'chat') setPreviousView(route.view);
    setProjectFilter(directory ?? null);
    const next: Route = { view };
    history[replace ? 'replaceState' : 'pushState']({}, '', hashFor(next));
    setRoute(next);
  }, [route.view]);

  const openSession = useCallback((selected: Session) => {
    if (route.view !== 'chat') setPreviousView(route.view);
    const sessionId = selected.id;
    history.pushState({}, '', hashFor({ view: 'chat', sessionId }));
    setRoute({ view: 'chat', sessionId });
    if (selected.messages) queryClient.setQueryData(['session', sessionId], { session: selected });
  }, [queryClient, route.view]);

  const openAgentChat = useCallback((selected: Agent) => {
    if (selected.sessionId) openSession({ id: selected.sessionId, title: selected.sessionTitle || selected.title, directory: selected.cwd, live: true, status: selected.status });
  }, [openSession]);

  const openConversationById = useCallback((conversationId: string) => {
    const known = overview?.sessions.find((item) => item.id === conversationId);
    openSession(known || { id: conversationId, title: 'Conversation', live: true });
  }, [overview, openSession]);

  const openNewTask = useCallback(() => {
    setDrafts((current) => ({ ...current, 'new-task': { text: '', attachments: [] } }));
    navigate('home');
    setTaskFocusSignal((signal) => signal + 1);
  }, [navigate]);

  async function archiveSession(target: Session, archived: boolean) {
    try {
      await setSessionMeta(target.id, { hidden: archived });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      if (archivedOpen) await queryClient.invalidateQueries({ queryKey: ['archived'] });
      if (archived) closeTabById(target.id);
      showToast(archived ? 'Conversation archived.' : 'Conversation restored.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not archive the conversation.', true);
    }
  }

  async function deleteSession(target: Session) {
    try {
      await mutate(`/conversations/${encodeURIComponent(target.id)}`, undefined, 'DELETE');
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      if (archivedOpen) await queryClient.invalidateQueries({ queryKey: ['archived'] });
      closeTabById(target.id);
      showToast('Conversation deleted.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not delete the conversation.', true);
    }
  }

  const { openSessionMenu, openSessionMenuAt, sessionMenuElement } = useSessionMenu({
    onOpen: openSession,
    onStop: handleSessionStop,
    onRename: (selected) => setRenameTarget(selected),
    onRegenerate: (selected) => void regenerateTitle(selected),
    onPin: (selected) => void updateSessionMeta(selected, { pinned: !selected.pinned }),
    onArchive: (selected) => void archiveSession(selected, true),
    onUnarchive: (selected) => void archiveSession(selected, false),
    onDelete: (selected) => setDeleteTarget(selected),
    onToast: showToast,
    onViewChanges: openChangesForSession,
    onOpenAgentsMd: (selected) => setAgentsTarget(selected),
    onOpenSettings: () => openSettingsForSession(),
  });

  /* ---- Tabs ------------------------------------------------------------ */

  /* Multi-device sync (P2, §6): persist the working set through settings. */
  useEffect(() => {
    setTabsServerSync((next) => {
      void saveSettings({ openTabs: { order: next.order, pinned: next.pinned, activeId: next.activeId } }).catch(() => {});
    });
    return () => setTabsServerSync(undefined);
  }, []);

  /* Adopt another device's tabs only when this one has none of its own. */
  const adoptedTabsRef = useRef(false);
  useEffect(() => {
    if (adoptedTabsRef.current || !bootQuery.isFetched) return;
    adoptedTabsRef.current = true;
    adoptServerTabs(bootQuery.data?.openTabs);
  }, [bootQuery.isFetched, bootQuery.data?.openTabs]);

  /* The route stays the source of truth for the active tab. */
  useEffect(() => {
    if (route.view !== 'chat' || !route.sessionId) return;
    const evicted = openTab(route.sessionId);
    if (evicted.length) showToast(`Closed ${evicted.length} idle tab${evicted.length === 1 ? '' : 's'} — ${MAX_TABS} open at most.`);
  }, [route.view, route.sessionId, showToast]);

  /* Reconcile with reality: a deleted or archived chat closes its tab (§4.2).
     Ids beyond the overview page are verified through getSession on every pass —
     never trusted permanently — so a conversation archived elsewhere still closes. */
  const verifiedTabsRef = useRef<Set<string>>(new Set());
  const tabOrderKey = tabs.order.join('|');
  useEffect(() => {
    if (!overview) return;
    const known = new Set<string>();
    for (const item of overview.sessions) known.add(item.id);
    if (route.sessionId) known.add(route.sessionId);
    const order = tabOrderKey ? tabOrderKey.split('|') : [];
    /* Forget verification for tabs that are no longer open. */
    for (const id of [...verifiedTabsRef.current]) if (!order.includes(id)) verifiedTabsRef.current.delete(id);
    const candidates = order.filter((id) => !known.has(id));
    if (!candidates.length) return;
    let cancelled = false;
    void Promise.all(candidates.map(async (id): Promise<Session | null> => {
      try {
        const loaded = await getSession(id);
        if (loaded.session.hidden) { verifiedTabsRef.current.delete(id); return null; }
        verifiedTabsRef.current.add(id);
        return loaded.session;
      } catch (error) {
        /* A definitive 404/410 means it is really gone; any other failure is
           transient, so a previously verified tab stays open. */
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) verifiedTabsRef.current.delete(id);
        return null;
      }
    })).then((loaded) => {
      if (cancelled) return;
      const valid = new Set(known);
      const extras: Record<string, Session> = {};
      for (const item of loaded) if (item) { valid.add(item.id); extras[item.id] = item; }
      for (const id of candidates) if (!valid.has(id) && verifiedTabsRef.current.has(id)) valid.add(id);
      if (Object.keys(extras).length) setExtraSessions((current) => ({ ...current, ...extras }));
      for (const id of reconcileTabs(valid)) forgetTabScroll(id);
    });
    return () => { cancelled = true; };
  }, [overview, tabOrderKey, route.sessionId]);

  const activeTabId = route.view === 'chat' ? route.sessionId : undefined;

  const activateTab = useCallback((id: string) => {
    if (route.view === 'chat' && route.sessionId === id) return;
    openConversationById(id);
  }, [route.view, route.sessionId, openConversationById]);

  const closeTabById = useCallback((id: string) => {
    const order = tabOrderKey ? tabOrderKey.split('|') : [];
    const index = order.indexOf(id);
    const neighbor = order[index + 1] ?? order[index - 1] ?? null;
    const wasActive = route.sessionId === id;
    closeTab(id);
    forgetTabScroll(id);
    if (wasActive) {
      if (neighbor) openConversationById(neighbor);
      else navigate('home');
    }
  }, [tabOrderKey, route.sessionId, navigate, openConversationById]);

  const handleTabsReorder = useCallback((orderedIds: string[]) => reorderTabs(orderedIds), []);
  const handleToggleTabPin = useCallback((id: string) => togglePin(id), []);
  const handleCloseOthers = useCallback((id: string) => {
    closeOtherTabs(id);
    if (route.sessionId !== id) openConversationById(id);
  }, [route.sessionId, openConversationById]);
  const handleCloseAll = useCallback(() => {
    const survivor = tabs.order.find((id) => tabs.pinned.includes(id)) || null;
    closeAllTabs();
    if (survivor) openConversationById(survivor);
    else navigate('home');
  }, [tabs.order, tabs.pinned, navigate, openConversationById]);
  const handleTabContextMenu = useCallback((event: ReactMouseEvent, id: string) => {
    const target = sessionById.get(id);
    if (target) openSessionMenu(event, target);
  }, [sessionById, openSessionMenu]);

  useTabsShortcuts({
    tabs: tabViews,
    activeId: activeTabId,
    onActivate: activateTab,
    onClose: closeTabById,
    onNew: openNewTask,
  });

  useEffect(() => {
    const onPopState = () => {
      const next = readRoute();
      if (next.view !== 'chat') setPreviousView(next.view);
      setRoute(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try { localStorage.setItem('workbench-theme', theme); } catch { /* Theme still applies for this tab. */ }
  }, [theme]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        openNewTask();
      }
    }
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [openNewTask]);

  function updateDraft(patch: Partial<DraftState>, key = draftKey) {
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] || { text: '', attachments: [] }), ...patch },
    }));
  }

  function attachmentIds(list: Attachment[]) {
    return list.map((attachment) => attachment.id).filter((id): id is string => Boolean(id));
  }

  async function sendPrompt() {
    if (!route.sessionId || sendingSessionId) return;
    const currentDraft = drafts[draftKey] || { text: '', attachments: [] };
    if (!currentDraft.text.trim() && !currentDraft.attachments.length) return;
    const sessionId = route.sessionId;
    setSendingSessionId(sessionId);
    try {
      await mutate(`/conversations/${encodeURIComponent(sessionId)}/commands`, {
        clientCommandId: crypto.randomUUID(),
        text: currentDraft.text,
        attachmentIds: attachmentIds(currentDraft.attachments),
        model: modelSelections[sessionId] || session?.modelPref || undefined,
      });
      queryClient.setQueryData<{ session: Session }>(['session', sessionId], (cached) => cached ? ({
        session: { ...cached.session, resumeStatus: 'working' },
      }) : cached);
      updateDraft({ text: '', attachments: [] }, sessionId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not send your message.', true);
    } finally { setSendingSessionId(undefined); }
  }

  async function startTask({ directory, kind }: { directory: string; kind: 'opencode' | 'pi' }) {
    const currentDraft = drafts['new-task'] || { text: '', attachments: [] };
    const text = currentDraft.text.trim();
    if (!directory) {
      showToast('Choose a project for the task first.', true);
      return;
    }
    if (!text) {
      showToast('Describe the task so your agent has something to start with.', true);
      return;
    }
    setSendingSessionId('new-task');
    try {
      const projectId = projectIdForDirectory(directory);
      const id = `chat_${crypto.randomUUID()}`;
      /* No model from the client: the control plane resolves the harness's
         current default, so a just-changed default always wins over a stale
         bootstrap copy. */
      const created = await mutate<{ session: Session }>('/conversations', {
        id,
        title: text.slice(0, 80),
        engine: kind,
        projectId,
        mode: 'build',
      });
      await mutate(`/conversations/${id}/commands`, {
        clientCommandId: crypto.randomUUID(),
        text,
        attachmentIds: attachmentIds(currentDraft.attachments),
      });
      try { localStorage.setItem('workbench-last-directory', directory); } catch { /* Preference is optional. */ }
      setDrafts((current) => ({ ...current, 'new-task': { text: '', attachments: [] } }));
      queryClient.setQueryData(['session', id], { session: { ...created.session, messages: [] } });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      showToast('Task started.');
      openSession({ ...created.session, messages: [] });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start the task.', true);
    } finally { setSendingSessionId(undefined); }
  }

  async function stopAgent(selectedAgent?: Agent) {
    const sessionId = selectedAgent?.sessionId || route.sessionId;
    if (!sessionId) return;
    try {
      await mutate(`/conversations/${encodeURIComponent(sessionId)}/stop`, {});
      showToast('Stop requested.');
      await queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not stop the agent.', true); }
  }

  async function resumeSession() {
    if (!route.sessionId) return;
    try {
      await mutate(`/conversations/${encodeURIComponent(route.sessionId)}/resume`, {});
      await queryClient.invalidateQueries({ queryKey: ['session', route.sessionId] });
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not resume the queue.', true); }
  }

  async function removeQueuedMessage(id: string) {
    if (!route.sessionId) return;
    try {
      await mutate(`/commands/${encodeURIComponent(id)}`, undefined, 'DELETE');
      await queryClient.invalidateQueries({ queryKey: ['session', route.sessionId] });
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not remove the queued message.', true); }
  }

  function handleSessionStop(selected: Session) {
    if (selected.paused) void resumeSession();
    else void stopAgent(overview?.agents.find((item) => item.sessionId === selected.id));
  }

  async function regenerateTitle(target: Session) {
    showToast('Regenerating title…');
    try {
      const result = await regenerateSessionTitle(target.id);
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      if (route.sessionId === target.id) {
        await queryClient.invalidateQueries({ queryKey: ['session', target.id] });
      }
      showToast(`Title updated to “${result.title}”.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not regenerate the title.', true);
    }
  }

  async function updateSessionMeta(target: Session, patch: { title?: string | null; pinned?: boolean; hidden?: boolean }) {
    try {
      await setSessionMeta(target.id, patch);
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      if (route.sessionId === target.id) {
        await queryClient.invalidateQueries({ queryKey: ['session', target.id] });
      }
      if (patch.hidden && route.sessionId === target.id) navigate('home');
      if ('pinned' in patch) showToast(patch.pinned ? 'Pinned.' : 'Unpinned.');
      if ('title' in patch) showToast(patch.title ? 'Renamed.' : 'Title reset.');
      if (patch.hidden) showToast('Hidden — it stays saved, just not in the list.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update the conversation.', true);
    }
  }

  /* Rebind the conversation's workspace: project → isolated worktree, General →
     private scratch. Takes effect on the next run. */
  async function changeWorkspace(projectId: string | null) {
    const sessionId = route.sessionId;
    if (!sessionId) return;
    try {
      await setSessionMeta(sessionId, { projectId });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      await queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      showToast(projectId ? 'Workspace set to project — the next run is isolated in its worktree.' : 'Workspace set to General — the next run uses a private scratch.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not change the workspace.', true);
    }
  }

  async function changeModel(model: string) {
    const sessionId = route.sessionId;
    if (!sessionId) return;
    try {
      await setSessionModel(sessionId, model);
      setModelSelections((current) => ({ ...current, [sessionId]: model }));
      await queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      showToast(session?.resumeStatus === 'working'
        ? 'Model saved — it applies from the next turn.'
        : 'Model saved — it applies to your next message.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save the model.', true);
    }
  }

  function replaceSession(incoming: Session, mode: 'merge' | 'prepend') {
    if (!route.sessionId) return;
    queryClient.setQueryData<{ session: Session }>(['session', route.sessionId], (current) => ({
      session: mergeSession(current?.session, incoming, mode),
    }));
  }

  function isSessionRunActive(target: Session) {
    const state = target.activeRun?.status || target.runStatus;
    return Boolean(state && ACTIVE_RUN_STATES.has(String(state)));
  }

  function openChangesForSession(target: Session) {
    setChangesTarget({
      runId: target.activeRun?.id,
      conversationId: target.id,
      runActive: isSessionRunActive(target),
      title: target.title || 'Run changes',
    });
  }

  function openChangesForRun(runId: string, active: boolean) {
    setChangesTarget({
      runId,
      conversationId: liveSessionId,
      runActive: active,
      title: session?.title || activeSession?.title || 'Run changes',
    });
  }

  function openSettingsForSession() {
    setMaxRunsDraft(String(maxRuns));
    setSettingsOpen(true);
  }

  async function applyMaxRuns() {
    const value = Math.max(1, Math.min(16, Math.round(Number(maxRunsDraft) || 1)));
    try {
      await saveSettings({ maxRuns: value });
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
      await queryClient.invalidateQueries({ queryKey: ['health'] });
      showToast(`Concurrency limit set to ${value}.`);
      setSettingsOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save the concurrency limit.', true);
    }
  }

  const toggleArchived = useCallback((open: boolean) => setArchivedOpen(open), []);

  const queued: QueuedMessage[] = (session?.queued || []).map((item) => ({
    id: item.id,
    text: item.text,
    attachments: [],
    model: item.model,
  }));

  const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const taskShortcut = `${modifier} ⇧ N`;
  const projects = bootQuery.data?.projects || [];

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        view={route.view}
        overview={overview}
        selectedSessionId={liveSessionId}
        system={systemQuery.data}
        systemOpen={systemOpen}
        theme={theme}
        shortcutLabel={taskShortcut}
        running={runningSessions}
        attention={attentionSessions}
        currentModel={currentModel}
        usageStatus={usageStatus}
        unreadNotifications={unreadNotifications}
        archived={archivedQuery.data?.sessions}
        archivedLoading={archivedQuery.isPending && archivedOpen}
        onNavigate={(view) => navigate(view)}
        onOpenSession={openSession}
        onOpenAgent={openAgentChat}
        onNewTask={openNewTask}
        onSearch={() => setSearchOpen(true)}
        onOpenSystem={() => setSystemOpen(true)}
        onOpenUsage={() => navigate('usage')}
        onOpenNotifications={() => setNotificationsOpen(true)}
        onToggleArchived={toggleArchived}
        onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        onContextMenu={openSessionMenu}
        onMenuAt={openSessionMenuAt}
      />

      <div className="min-h-0 min-w-0 flex-1 md:p-2">
        <div className="raised relative flex h-full min-h-0 flex-col overflow-hidden bg-surface md:rounded-xl md:border md:border-border">
          {tabViews.length > 0 && (
            <HorizontalTabs
              tabs={tabViews}
              activeId={activeTabId}
              onActivate={activateTab}
              onClose={closeTabById}
              onReorder={handleTabsReorder}
              onTogglePin={handleToggleTabPin}
              onNew={openNewTask}
              onCloseOthers={handleCloseOthers}
              onCloseAll={handleCloseAll}
              onContextMenu={handleTabContextMenu}
            />
          )}
          <div
            id={route.view === 'chat' ? 'workbench-chat-panel' : undefined}
            role={route.view === 'chat' ? 'tabpanel' : undefined}
            aria-label={route.view === 'chat' ? 'Conversation' : undefined}
            className="relative min-h-0 flex-1"
          >
          {overviewQuery.isPending && !overview ? (
            <div className="grid h-full place-items-center text-muted-foreground" role="status">
              <IconLoader2 size={22} className="animate-spin" />
            </div>
          ) : overviewQuery.isError && !overview ? (
            <div className="grid h-full place-items-center px-6">
              <div className="max-w-md text-center">
                <h2 className="text-[15px] font-semibold">Could not reach your workspace</h2>
                <p className="mt-2 text-[13px]/5 text-muted-foreground">{overviewQuery.error.message}</p>
                <button
                  type="button"
                  onClick={() => void overviewQuery.refetch()}
                  className="mt-4 cursor-pointer rounded-full bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96]"
                >
                  Try again
                </button>
              </div>
            </div>
          ) : route.view === 'chat' ? (
            <ChatView
              key={liveSessionId || 'none'}
              session={session}
              agent={agent}
              loading={Boolean(liveSessionId) && sessionQuery.isPending}
              sessionId={liveSessionId}
              draft={draft.text}
              attachments={draft.attachments}
              sending={sendingSessionId === draftKey}
              queued={queued}
              onRemoveQueued={(id) => void removeQueuedMessage(id)}
              connectionError={chatConnectionError}
              resumeMemoryAvailable={Number(overview?.system?.memoryFree || 0) >= 1024 ** 3}
              memoryFree={overview?.system?.memoryFree}
              selectedModel={liveSessionId ? modelSelections[liveSessionId] || session?.modelPref || undefined : undefined}
              onSelectModel={(model) => void changeModel(model)}
              onDraftChange={(text) => updateDraft({ text })}
              onAttachmentsChange={(attachments) => updateDraft({ attachments })}
              onSend={sendPrompt}
              onBack={() => navigate(previousView)}
              onStop={(selected) => void stopAgent(selected)}
              onStopSession={() => void handleSessionStop(session || { id: liveSessionId! })}
              onNewTask={openNewTask}
              onToast={showToast}
              onReplaceSession={replaceSession}
              onViewChanges={openChangesForRun}
              onOpenAgentsMd={() => { if (activeSession) setAgentsTarget(activeSession); }}
              agentsMdActive={agentsMdActive}
              projects={projects}
              onSelectWorkspace={(id) => void changeWorkspace(id)}
            />
          ) : route.view === 'history' ? (
            <HistoryView
              overview={overview || emptyOverview}
              projectFilter={projectFilter}
              onProjectFilter={setProjectFilter}
              onOpenSession={openSession}
              onContextMenu={openSessionMenu}
              onMenuAt={openSessionMenuAt}
            />
          ) : route.view === 'clips' ? (
            <ClipsView onToast={showToast} />
          ) : route.view === 'usage' ? (
            <Suspense fallback={<div className="grid h-full place-items-center text-muted-foreground"><IconLoader2 size={20} className="animate-spin" /></div>}>
              <UsageView projects={projects} onToast={showToast} />
            </Suspense>
          ) : (
            <HomeView
              overview={overview || emptyOverview}
              draft={draft.text}
              attachments={draft.attachments}
              sending={Boolean(sendingSessionId)}
              onDraftChange={(text) => updateDraft({ text })}
              onAttachmentsChange={(attachments) => updateDraft({ attachments })}
              onStart={startTask}
              defaultEngine={bootQuery.data?.defaultEngine || 'pi'}
              defaults={bootQuery.data?.defaults}
              onDefaultEngine={(engine) => { void mutate('/settings', { defaultEngine: engine }).then(() => queryClient.invalidateQueries({ queryKey: ['bootstrap'] })); }}
              focusSignal={taskFocusSignal}
              onNewTask={openNewTask}
              onOpenSession={openSession}
              onOpenAgent={openAgentChat}
              onHistory={() => navigate('history')}
              onToast={showToast}
              onContextMenu={openSessionMenu}
              onMenuAt={openSessionMenuAt}
            />
          )}

          {route.view !== 'chat' && (
            <nav
              className="absolute inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-(--popover-translucent) px-2 pt-1 pb-[max(4px,env(safe-area-inset-bottom))] backdrop-blur-xl md:hidden"
              aria-label="Mobile navigation"
            >
              {([
                ['home', 'Home', IconHome],
                ['history', 'History', IconClock],
                ['clips', 'Clips', IconClipboardText],
              ] as const).map(([view, label, Icon]) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => navigate(view)}
                  aria-current={route.view === view ? 'page' : undefined}
                  className={cn(
                    'grid min-h-12 justify-items-center content-center gap-0.5 rounded-md text-[11px]',
                    route.view === view ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <Icon size={19} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </nav>
          )}
          </div>
        </div>
      </div>

      {systemOpen && <Suspense fallback={null}><SystemPanel
        open={systemOpen}
        onOpenChange={setSystemOpen}
        system={systemQuery.data}
        agents={overview?.agents || []}
        onStopAgent={(selected) => void stopAgent(selected)}
        onToast={showToast}
      /></Suspense>}
      <NotificationsCenter
        open={notificationsOpen}
        onOpenChange={setNotificationsOpen}
        onOpenConversation={openConversationById}
        onToast={showToast}
      />
      {sessionMenuElement}
      {changesTarget && (
        <Suspense fallback={null}><ChangesPanel
          open
          onOpenChange={(open) => { if (!open) setChangesTarget(null); }}
          target={changesTarget}
          onToast={showToast}
          onChanged={() => {
            if (changesTarget.conversationId) void queryClient.invalidateQueries({ queryKey: ['session', changesTarget.conversationId] });
            void queryClient.invalidateQueries({ queryKey: ['overview'] });
          }}
        /></Suspense>
      )}
      {agentsTarget && (
        <AgentsMdDialog
          open
          onOpenChange={(open) => { if (!open) setAgentsTarget(null); }}
          projectId={agentsTarget.projectId}
          projectName={projects.find((project) => project.id === agentsTarget.projectId)?.name}
          path={agentsTarget.directory}
          onToast={showToast}
        />
      )}
      {settingsOpen && (
        <Dialog open onOpenChange={(open) => { if (!open) setSettingsOpen(false); }}>
          <DialogContent className="top-[24vh] max-w-sm rounded-xl">
            <DialogTitle>Concurrency & queue</DialogTitle>
            <DialogDescription>
              How many Runs may execute at once. Extra Runs wait in the queue. Currently {activeRuns} running · {queuedRuns} queued.
            </DialogDescription>
            <div className="mt-4">
              <label htmlFor="wb-max-runs" className="text-[12px] font-medium text-muted-foreground">Maximum concurrent Runs</label>
              <input
                id="wb-max-runs"
                type="number"
                min={1}
                max={16}
                value={maxRunsDraft}
                onChange={(event) => setMaxRunsDraft(event.target.value)}
                className="mt-1.5 w-full rounded-md bg-well px-3 py-2 text-[13px] tabular-nums shadow-[inset_0_0_0_1px_var(--well-outline)] outline-none"
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">Default 2. Higher values need more memory on this machine.</p>
            </div>
            <DialogFooter>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="cursor-pointer rounded-full px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void applyMaxRuns()}
                className="cursor-pointer rounded-full bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96]"
              >
                Save
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {renameTarget && (
        <RenameDialog
          open
          initialValue={renameTarget.title || ''}
          onOpenChange={(open) => { if (!open) setRenameTarget(undefined); }}
          onSubmit={(title) => {
            const target = renameTarget;
            setRenameTarget(undefined);
            if (target) void updateSessionMeta(target, { title });
          }}
        />
      )}
      {deleteTarget && (
        <Dialog open onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }}>
          <DialogContent className="top-[24vh] max-w-sm rounded-xl">
            <DialogTitle>Delete conversation?</DialogTitle>
            <DialogDescription>
              “{deleteTarget.title || 'Untitled'}” and its transcript will be removed. This cannot be undone.
            </DialogDescription>
            <DialogFooter>
              <button
                type="button"
                onClick={() => setDeleteTarget(undefined)}
                className="cursor-pointer rounded-full px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = deleteTarget;
                  setDeleteTarget(undefined);
                  if (target) void deleteSession(target);
                }}
                className="cursor-pointer rounded-full bg-destructive px-3.5 py-2 text-[13px] font-medium text-white transition-[background-color,scale] duration-150 hover:opacity-90 active:scale-[0.96]"
              >
                Delete
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <SearchPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        overview={overview}
        onNavigate={(view) => navigate(view)}
        onNewTask={() => { setSearchOpen(false); openNewTask(); }}
        onOpenSession={(selected) => { setSearchOpen(false); openSession(selected); }}
      />

      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2" aria-live="polite" aria-relevant="additions text">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.error ? 'alert' : 'status'}
            className={cn(
              'raised pointer-events-auto w-full truncate rounded-xl bg-popover py-2 pr-3 pl-3 text-sm ring-1 ring-border',
              toast.error ? 'text-destructive' : 'text-popover-foreground',
            )}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
