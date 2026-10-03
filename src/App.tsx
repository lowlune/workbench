import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChatCenteredText,
  ClipboardText,
  ClockCounterClockwise,
  House,
  List,
} from '@phosphor-icons/react';
import { AppSidebar, type AppView } from '@/components/app-sidebar';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { Attachment } from '@/features/chat/chat-view';
import { getOverview, getSession, getSessionUpdates, postJson } from '@/lib/api';
import type { Agent, Message, Overview, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

const ChatView = lazy(() => import('@/features/chat/chat-view').then((module) => ({ default: module.ChatView })));
const ClipsView = lazy(() => import('@/features/clips/clips-view').then((module) => ({ default: module.ClipsView })));
const HistoryView = lazy(() => import('@/features/history/history-view').then((module) => ({ default: module.HistoryView })));
const HomeView = lazy(() => import('@/features/home/home-view').then((module) => ({ default: module.HomeView })));
const NewTaskDialog = lazy(() => import('@/components/task-dialogs').then((module) => ({ default: module.NewTaskDialog })));
const OutputDialog = lazy(() => import('@/components/task-dialogs').then((module) => ({ default: module.OutputDialog })));
const CommandMenu = lazy(() => import('@/components/command-menu').then((module) => ({ default: module.CommandMenu })));

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
  return { view: 'home' };
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('workbench-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Use the system preference when storage is unavailable. */ }
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

function ErrorPanel({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="mx-auto mt-12 w-[calc(100%-2rem)] max-w-xl rounded-2xl border border-destructive/25 bg-panel p-6 text-center" role="alert">
      <h2 className="font-semibold">Could not reach your workspace</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
      <Button variant="outline" className="mt-4" onClick={retry}>Try again</Button>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [route, setRoute] = useState<Route>(readRoute);
  const [previousView, setPreviousView] = useState<Exclude<AppView, 'chat'>>('home');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [outputAgent, setOutputAgent] = useState<Agent>();
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [sendingSessionId, setSendingSessionId] = useState<string>();
  const [chatConnectionError, setChatConnectionError] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const overviewQuery = useQuery({
    queryKey: ['overview'],
    queryFn: getOverview,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    staleTime: 2_000,
    retry: 1,
  });
  const overview = overviewQuery.data;

  const sessionQuery = useQuery({
    queryKey: ['session', route.sessionId],
    queryFn: () => getSession(route.sessionId!, 30),
    enabled: route.view === 'chat' && Boolean(route.sessionId),
    staleTime: Infinity,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const session = sessionQuery.data?.session;
  const agent = overview?.agents.find((item) => item.sessionId === route.sessionId);
  const draftKey = route.sessionId || 'new-task';
  const draft = drafts[draftKey] || { text: '', attachments: [] };

  const showToast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, text, error }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  const navigate = useCallback((view: Exclude<AppView, 'chat'>, directory?: string | null, replace = false) => {
    if (route.view !== 'chat') setPreviousView(route.view);
    setProjectFilter(directory ?? null);
    const next: Route = { view };
    history[replace ? 'replaceState' : 'pushState']({}, '', hashFor(next));
    setRoute(next);
    setMobileSidebarOpen(false);
  }, [route.view]);

  const openSession = useCallback((selected: Session) => {
    if (route.view !== 'chat') setPreviousView(route.view);
    const sessionId = selected.id;
    history.pushState({}, '', hashFor({ view: 'chat', sessionId }));
    setRoute({ view: 'chat', sessionId });
    setMobileSidebarOpen(false);
    if (selected.messages) queryClient.setQueryData(['session', sessionId], { session: selected });
  }, [queryClient, route.view]);

  useEffect(() => {
    const onPopState = () => {
      const next = readRoute();
      if (next.view !== 'chat') setPreviousView(next.view);
      setRoute(next);
      setMobileSidebarOpen(false);
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
        setCommandOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setNewTaskOpen(true);
      }
      if (event.key === 'Escape') setMobileSidebarOpen(false);
    }
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    if (route.view !== 'chat' || !route.sessionId || !session) {
      setChatConnectionError(false);
      return;
    }
    let disposed = false;
    let inFlight = false;
    const sessionId = route.sessionId;
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
    const timer = window.setInterval(() => void poll(), 3500);
    document.addEventListener('visibilitychange', poll);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [route.view, route.sessionId, Boolean(session), queryClient]);

  function updateDraft(patch: Partial<DraftState>) {
    setDrafts((current) => ({
      ...current,
      [draftKey]: { ...(current[draftKey] || { text: '', attachments: [] }), ...patch },
    }));
  }

  async function sendPrompt() {
    if (!route.sessionId || sendingSessionId) return;
    const currentDraft = drafts[draftKey] || { text: '', attachments: [] };
    if (!currentDraft.text.trim() && !currentDraft.attachments.length) return;
    const sessionId = route.sessionId;
    const useLivePane = Boolean(agent && agent.status !== 'unknown');
    if (!useLivePane && !session?.canResume) {
      showToast('This saved task cannot be resumed because its project folder is unavailable.', true);
      return;
    }
    setSendingSessionId(sessionId);
    try {
      const body = {
        text: currentDraft.text,
        images: currentDraft.attachments.map((attachment) => ({ name: attachment.name, dataUrl: attachment.dataUrl })),
      };
      if (useLivePane && agent) {
        await postJson(`/api/agents/${encodeURIComponent(agent.paneId)}/prompt`, body);
      } else {
        await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, body);
        queryClient.setQueryData<{ session: Session }>(['session', sessionId], (cached) => cached ? ({
          session: { ...cached.session, resumeStatus: 'working' },
        }) : cached);
      }
      setDrafts((current) => ({ ...current, [sessionId]: { text: '', attachments: [] } }));
      showToast(useLivePane ? 'Message sent. Your agent is on it.' : 'Message sent. The saved conversation is continuing.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not send your message.', true);
    } finally { setSendingSessionId(undefined); }
  }

  async function stopAgent(selectedAgent: Agent) {
    try {
      await postJson(`/api/agents/${encodeURIComponent(selectedAgent.paneId)}/interrupt`, {});
      showToast('Stop requested.');
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not stop the agent.', true); }
  }

  async function stopSavedSession(sessionId: string) {
    try {
      await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {});
      showToast('Stop requested.');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not stop this continuation.', true); }
  }

  function replaceSession(incoming: Session, mode: 'merge' | 'prepend') {
    if (!route.sessionId) return;
    queryClient.setQueryData<{ session: Session }>(['session', route.sessionId], (current) => ({
      session: mergeSession(current?.session, incoming, mode),
    }));
  }

  const currentTitle = useMemo(() => ({ home: 'Home', history: 'History', clips: 'Clip tray', chat: session?.title || 'Conversation' })[route.view], [route.view, session?.title]);
  const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const taskShortcut = `${modifier} ⇧ N`;

  function toggleTheme() {
    setTheme((current) => current === 'dark' ? 'light' : 'dark');
  }

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
      <aside className="hidden h-full w-[264px] shrink-0 border-r border-border md:block" aria-label="Workspace navigation">
        <AppSidebar view={route.view} overview={overview} selectedSessionId={route.sessionId} projectFilter={projectFilter} onNavigate={navigate} onOpenSession={openSession} onNewTask={() => setNewTaskOpen(true)} theme={theme} shortcutLabel={taskShortcut} onToggleTheme={toggleTheme} />
      </aside>

      <Dialog open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <DialogContent className="mobile-sidebar-dialog left-0 top-0 h-dvh max-h-none w-[min(320px,88vw)] max-w-none translate-x-0 translate-y-0 rounded-none p-0 sm:left-0 sm:max-w-none">
          <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
          <DialogDescription className="sr-only">Navigate between your workspace, history, and clip tray.</DialogDescription>
          <AppSidebar view={route.view} overview={overview} selectedSessionId={route.sessionId} projectFilter={projectFilter} onNavigate={navigate} onOpenSession={openSession} onNewTask={() => setNewTaskOpen(true)} onClose={() => setMobileSidebarOpen(false)} theme={theme} shortcutLabel={taskShortcut} onToggleTheme={toggleTheme} />
        </DialogContent>
      </Dialog>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {route.view !== 'chat' && (
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-panel/80 px-3 backdrop-blur sm:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileSidebarOpen(true)} aria-label="Open navigation"><List aria-hidden="true" size={19} /></Button>
              <div className="min-w-0">
                <p className="hidden text-[11px] font-medium text-muted-foreground sm:block">WORKBENCH</p>
                <h1 className="truncate text-sm font-semibold sm:mt-0.5">{currentTitle}</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span role="status" aria-live="polite" className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                <span className={cn('size-1.5 rounded-full', overviewQuery.isError ? 'bg-warning' : 'bg-success')} aria-hidden="true" />
                {overviewQuery.isError ? 'Reconnecting' : 'Connected'}
              </span>
              <Button size="sm" title={`Start a task (${taskShortcut})`} onClick={() => setNewTaskOpen(true)}><ChatCenteredText aria-hidden="true" /> <span className="hidden sm:inline">New task</span><span className="sm:hidden">New</span></Button>
            </div>
          </header>
        )}

        <main id="main-content" className={cn('min-h-0 min-w-0 flex-1', route.view === 'chat' ? 'overflow-hidden' : 'overflow-y-auto pb-16 md:pb-0')}>
          {overviewQuery.isPending && !overview ? (
            <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-7" aria-label="Loading workspace">
              <div className="h-24 animate-pulse rounded-2xl bg-muted" />
              <div className="h-40 animate-pulse rounded-2xl bg-muted" />
              <div className="h-56 animate-pulse rounded-2xl bg-muted" />
            </div>
          ) : overviewQuery.isError && !overview ? (
            <ErrorPanel message={overviewQuery.error.message} retry={() => void overviewQuery.refetch()} />
          ) : route.view === 'chat' ? (
            <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground" role="status"><span className="flex items-center gap-2"><span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />Opening conversation…</span></div>}>
            <ChatView
              key={route.sessionId}
              session={session}
              agent={agent}
              loading={sessionQuery.isPending}
              sessionId={route.sessionId}
              draft={draft.text}
              attachments={draft.attachments}
              sending={sendingSessionId === route.sessionId}
              connectionError={chatConnectionError}
              resumeMemoryAvailable={Number(overview?.system?.memoryFree || 0) >= 1024 ** 3}
              memoryFree={overview?.system?.memoryFree}
              onDraftChange={(text) => updateDraft({ text })}
              onAttachmentsChange={(attachments) => updateDraft({ attachments })}
              onSend={sendPrompt}
              onBack={() => navigate(previousView)}
              onOpenNavigation={() => setMobileSidebarOpen(true)}
              onStop={stopAgent}
              onStopSession={stopSavedSession}
              onOutput={setOutputAgent}
              onNewTask={() => setNewTaskOpen(true)}
              onToast={showToast}
              onReplaceSession={replaceSession}
            />
            </Suspense>
          ) : route.view === 'history' ? (
            <Suspense fallback={<div className="p-8 text-sm text-muted-foreground" role="status">Opening history…</div>}><HistoryView overview={overview || emptyOverview} projectFilter={projectFilter} onProjectFilter={setProjectFilter} onOpenSession={openSession} /></Suspense>
          ) : route.view === 'clips' ? (
            <Suspense fallback={<div className="p-8 text-sm text-muted-foreground" role="status">Opening clip tray…</div>}><ClipsView onToast={showToast} /></Suspense>
          ) : (
            <Suspense fallback={<div className="p-8 text-sm text-muted-foreground" role="status">Opening your workspace…</div>}><HomeView overview={overview || emptyOverview} onNewTask={() => setNewTaskOpen(true)} onOpenSession={openSession} onOutput={setOutputAgent} onHistory={() => navigate('history')} /></Suspense>
          )}
        </main>

        {route.view !== 'chat' && (
          <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-panel/95 px-2 pb-[max(4px,env(safe-area-inset-bottom))] pt-1 backdrop-blur md:hidden" aria-label="Mobile navigation">
            {([
              ['home', 'Home', House],
              ['history', 'History', ClockCounterClockwise],
              ['clips', 'Clips', ClipboardText],
            ] as const).map(([view, label, Icon]) => (
              <button key={view} type="button" onClick={() => navigate(view)} aria-current={route.view === view ? 'page' : undefined} className={cn('grid min-h-12 justify-items-center content-center gap-0.5 rounded-lg text-[11px] text-muted-foreground', route.view === view && 'text-foreground')}>
                <Icon aria-hidden="true" size={19} weight={route.view === view ? 'fill' : 'regular'} />{label}
              </button>
            ))}
          </nav>
        )}
      </div>

      <Suspense fallback={null}>
        <NewTaskDialog open={newTaskOpen} overview={overview} onOpenChange={setNewTaskOpen} onStarted={showToast} onComplete={() => void queryClient.invalidateQueries({ queryKey: ['overview'] })} />
        <OutputDialog agent={outputAgent} onOpenChange={(open) => { if (!open) setOutputAgent(undefined); }} onToast={showToast} />
        <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} onNavigate={(view) => navigate(view)} onNewTask={() => setNewTaskOpen(true)} shortcutLabel={`${modifier} K`} />
      </Suspense>

      <div className="pointer-events-none fixed right-3 top-3 z-[100] grid w-[min(380px,calc(100vw-1.5rem))] gap-2 sm:right-5 sm:top-5" aria-live="polite" aria-relevant="additions text">
        {toasts.map((toast) => <div key={toast.id} role={toast.error ? 'alert' : 'status'} className={cn('pointer-events-auto rounded-xl border border-border bg-panel px-4 py-3 text-sm shadow-lg', toast.error && 'border-destructive/25 text-destructive')}>{toast.text}</div>)}
      </div>
    </div>
  );
}

const emptyOverview: Overview = { agents: [], sessions: [], directories: [], system: {} };
