import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconClipboardText, IconClock, IconHome, IconLoader2 } from '@tabler/icons-react';
import { AssistantPanel } from '@/components/whirl/assistant-panel';
import { ChatView } from '@/components/whirl/chat-view';
import { ClipsView } from '@/components/whirl/pages/clips-view';
import { HistoryView } from '@/components/whirl/pages/history-view';
import { HomeView } from '@/components/whirl/pages/home-view';
import { RenameDialog } from '@/components/whirl/rename-dialog';
import { SearchPalette } from '@/components/whirl/search-palette';
import { useSessionMenu } from '@/components/whirl/session-menu';
import { Sidebar, type AppView } from '@/components/whirl/sidebar';
import { SystemPanel } from '@/components/whirl/system-panel';
import { getModels, getOverview, getSession, getSessionUpdates, getSystem, projectIdForDirectory, regenerateSessionTitle, setSessionMeta, setSessionModel } from '@/lib/api';
import type { Attachment } from '@/lib/attachments';
import type { Agent, Message, Overview, QueuedMessage, Session } from '@/lib/types';
import { bootstrap, mutate } from '@/lib/workbench';
import { cn } from '@/lib/utils';

const UsageView = lazy(() => import('@/components/whirl/pages/usage-view'));

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

const emptyOverview: Overview = { agents: [], sessions: [], directories: [], system: {} };
const WORKING = new Set(['starting', 'running', 'waiting', 'stopping']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'uncertain']);

export default function App() {
  const queryClient = useQueryClient();
  const [route, setRoute] = useState<Route>(readRoute);
  const [previousView, setPreviousView] = useState<Exclude<AppView, 'chat'>>('home');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [taskFocusSignal, setTaskFocusSignal] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [modelSelections, setModelSelections] = useState<Record<string, string>>({});
  const [renameTarget, setRenameTarget] = useState<Session>();
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [sendingSessionId, setSendingSessionId] = useState<string>();
  const [chatConnectionError, setChatConnectionError] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const overviewQuery = useQuery({
    queryKey: ['overview'],
    queryFn: getOverview,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 2_000,
    retry: 1,
  });
  const overview = overviewQuery.data;
  const systemQuery = useQuery({
    queryKey: ['system'],
    queryFn: getSystem,
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: 1,
  });
  const bootQuery = useQuery({ queryKey: ['bootstrap'], queryFn: bootstrap, staleTime: 30_000 });

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
  const draftKey = liveSessionId || 'new-task';
  const draft = drafts[draftKey] || { text: '', attachments: [] };

  const showToast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, text, error }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  /* One SSE stream drives every cache update: targeted message/run patches
     with debounced invalidations for the aggregates. */
  useEffect(() => {
    const seq = bootQuery.data?.seq;
    if (seq === undefined) return;
    const stream = new EventSource(`/api/v2/events?after=${seq}`);
    const timers: Record<string, number> = {};
    const schedule = (key: string, fn: () => void, ms = 150) => {
      window.clearTimeout(timers[key]);
      timers[key] = window.setTimeout(fn, ms);
    };
    stream.onmessage = (event) => {
      const data = JSON.parse(event.data) as { seq: number; type: string; conversationId?: string; message?: Message; commandId?: string; status?: string; error?: string | null };
      switch (data.type) {
        case 'message.updated':
          if (data.conversationId && data.message) {
            queryClient.setQueryData<{ session: Session }>(['session', data.conversationId], (current) =>
              current ? { session: mergeSession(current.session, { id: data.conversationId!, messages: [data.message!] }) } : current);
          }
          return;
        case 'run.updated':
          if (data.conversationId) {
            queryClient.setQueryData<{ session: Session }>(['session', data.conversationId], (current) => {
              if (!current) return current;
              const run = current.session.activeRun;
              const nextRun = run && run.id === data.commandId
                ? { ...run, status: data.status!, error: data.error }
                : { id: data.commandId!, status: data.status!, error: data.error, model: current.session.modelPref || '' };
              return { session: { ...current.session, activeRun: nextRun, resumeStatus: WORKING.has(data.status!) ? 'working' : 'idle' } };
            });
          }
          if (TERMINAL.has(data.status || '')) {
            if (data.conversationId) schedule(`session:${data.conversationId}`, () => void queryClient.invalidateQueries({ queryKey: ['session', data.conversationId] }));
            schedule('overview', () => void queryClient.invalidateQueries({ queryKey: ['overview'] }));
            schedule('usage', () => void queryClient.invalidateQueries({ queryKey: ['usage'] }), 800);
          }
          return;
        case 'command.accepted':
        case 'interaction.created':
        case 'interaction.answered':
          if (data.conversationId) schedule(`session:${data.conversationId}`, () => void queryClient.invalidateQueries({ queryKey: ['session', data.conversationId] }));
          schedule('overview', () => void queryClient.invalidateQueries({ queryKey: ['overview'] }));
          return;
        case 'conversation.changed':
          schedule('overview', () => void queryClient.invalidateQueries({ queryKey: ['overview'] }));
          schedule('history', () => void queryClient.invalidateQueries({ queryKey: ['history'] }));
          if (data.conversationId) schedule(`session:${data.conversationId}`, () => void queryClient.invalidateQueries({ queryKey: ['session', data.conversationId] }));
          return;
        case 'projects.changed':
          schedule('overview', () => void queryClient.invalidateQueries({ queryKey: ['overview'] }));
          schedule('bootstrap', () => void queryClient.invalidateQueries({ queryKey: ['bootstrap'] }));
          return;
        case 'clips.changed':
          void queryClient.invalidateQueries({ queryKey: ['clips'] });
          return;
        case 'models.changed':
          void queryClient.invalidateQueries({ queryKey: ['models'] });
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
      for (const timer of Object.values(timers)) window.clearTimeout(timer);
    };
  }, [bootQuery.data?.seq, queryClient]);

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

  const openNewTask = useCallback(() => {
    setDrafts((current) => ({ ...current, 'new-task': { text: '', attachments: [] } }));
    navigate('home');
    setTaskFocusSignal((signal) => signal + 1);
  }, [navigate]);

  const { openSessionMenu, openSessionMenuAt, sessionMenuElement } = useSessionMenu({
    onOpen: openSession,
    onStop: handleSessionStop,
    onRename: (session) => setRenameTarget(session),
    onRegenerate: (session) => void regenerateTitle(session),
    onPin: (session) => void updateSessionMeta(session, { pinned: !session.pinned }),
    onHide: (session) => void updateSessionMeta(session, { hidden: true }),
    onToast: showToast,
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

  /* A slow poll remains as a repair path if the event stream is interrupted. */
  useEffect(() => {
    if (route.view !== 'chat' || !liveSessionId || !session) {
      setChatConnectionError(false);
      return;
    }
    let disposed = false;
    let inFlight = false;
    const sessionId = liveSessionId;
    const poll = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      const current = queryClient.getQueryData<{ session: Session }>(['session', sessionId])?.session;
      if (!current) return;
      inFlight = true;
      try {
        const update = await getSessionUpdates(sessionId, String(current.updated || 0));
        if (disposed) return;
        setChatConnectionError(false);
        if (update.changed && update.session) {
          queryClient.setQueryData<{ session: Session }>(['session', sessionId], (cached) => ({
            session: mergeSession(cached?.session, update.session!),
          }));
        } else if (update.resumeStatus && update.resumeStatus !== current.resumeStatus) {
          queryClient.setQueryData<{ session: Session }>(['session', sessionId], (cached) => cached ? ({
            session: { ...cached.session, resumeStatus: update.resumeStatus },
          }) : cached);
        }
      } catch {
        if (!disposed) setChatConnectionError(true);
      } finally { inFlight = false; }
    };
    const timer = window.setInterval(() => void poll(), 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [route.view, liveSessionId, Boolean(session), queryClient]);

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
      showToast('Message sent.');
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
      const boot = bootQuery.data;
      const projectId = projectIdForDirectory(directory);
      let model = boot?.projects.find((project) => project.id === projectId)?.defaults?.[kind] || boot?.defaults?.[kind] || null;
      if (!model) {
        const models = await getModels();
        model = models.models[0]?.id || null;
      }
      if (!model) throw new Error('No connected model. Add one in Usage & models.');
      const id = `chat_${crypto.randomUUID()}`;
      const created = await mutate<{ session: Session }>('/conversations', {
        id,
        title: text.slice(0, 80),
        engine: kind,
        projectId,
        model,
        mode: 'build',
      });
      await mutate(`/conversations/${id}/commands`, {
        clientCommandId: crypto.randomUUID(),
        text,
        attachmentIds: attachmentIds(currentDraft.attachments),
        model,
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
        onNavigate={(view) => navigate(view)}
        onOpenSession={openSession}
        onOpenAgent={openAgentChat}
        onNewTask={openNewTask}
        onSearch={() => setSearchOpen(true)}
        onOpenSystem={() => setSystemOpen(true)}
        onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        onContextMenu={openSessionMenu}
        onMenuAt={openSessionMenuAt}
      />

      <div className="min-h-0 min-w-0 flex-1 md:py-2 md:pr-2">
        <div className="raised relative h-full overflow-hidden bg-surface md:rounded-lg md:border md:border-border">
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
              onAsk={() => setAssistantOpen(true)}
              onDraftChange={(text) => updateDraft({ text })}
              onAttachmentsChange={(attachments) => updateDraft({ attachments })}
              onSend={sendPrompt}
              onBack={() => navigate(previousView)}
              onStop={(selected) => void stopAgent(selected)}
              onStopSession={() => void handleSessionStop(session || { id: liveSessionId! })}
              onNewTask={openNewTask}
              onToast={showToast}
              onReplaceSession={replaceSession}
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
                    'grid min-h-12 justify-items-center content-center gap-0.5 rounded-lg text-[11px]',
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

      <SystemPanel
        open={systemOpen}
        onOpenChange={setSystemOpen}
        system={systemQuery.data}
        agents={overview?.agents || []}
        onStopAgent={(selected) => void stopAgent(selected)}
        onToast={showToast}
      />
      <AssistantPanel
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        sessionId={route.sessionId}
        sessionTitle={session?.title || undefined}
        onToast={showToast}
      />
      {sessionMenuElement}
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
