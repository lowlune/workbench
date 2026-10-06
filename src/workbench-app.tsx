import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowLeft, IconChartBar, IconClipboardText, IconFolder, IconLoader2, IconMenu2, IconMoon, IconPlus, IconSearch, IconSun, IconX } from '@tabler/icons-react';
import { ChatRow } from '@/components/whirl/chat-row';
import { Editor } from '@/components/whirl/editor';
import { HomeGreeting, HomeSuggestions } from '@/components/whirl/home-intro';
import { InteractionCard } from '@/components/whirl/interaction-card';
import { ModelPicker } from '@/components/whirl/model-picker';
import { RunCard } from '@/components/whirl/thread/run-card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { bootstrap, localWrite, mutate, offerings, v2 } from '@/lib/workbench';
import type { Message, Session } from '@/lib/types';
import { formatTokens, messageContext } from '@/lib/format';
import { cn } from '@/lib/utils';

const Library = lazy(() => import('@/components/whirl/pages/context-library'));
const Usage = lazy(() => import('@/components/whirl/pages/usage-view'));
const Thread = lazy(() => import('@/components/whirl/thread/thread-view').then((module) => ({ default: module.ThreadView })));

type Route = { view: 'home' | 'chat' | 'history' | 'clips' | 'usage'; id?: string };
const readRoute = (): Route => {
  const hash = location.hash.slice(1);
  if (hash.startsWith('chat/')) return { view: 'chat', id: decodeURIComponent(hash.slice(5)) };
  return { view: (['history', 'clips', 'usage'].includes(hash) ? hash : 'home') as Route['view'] };
};
const Loading = () => <div className="grid h-32 place-items-center text-muted-foreground"><IconLoader2 className="animate-spin" size={20} /></div>;

function merge(previous: Session | undefined, next: Session): Session {
  if (!previous) return next;
  const messages = new Map((previous.messages || []).map((message) => [message.id, message]));
  for (const message of next.messages || []) messages.set(message.id, message);
  return { ...previous, ...next, hasMoreMessages: previous.hasMoreMessages, messages: [...messages.values()].sort((a, b) => (a.created || 0) - (b.created || 0) || a.id.localeCompare(b.id)) };
}

const WORKING_STATUSES = new Set(['starting', 'running', 'waiting', 'stopping']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'uncertain']);

export default function WorkbenchApp() {
  const client = useQueryClient();
  const [route, setRoute] = useState<Route>(readRoute);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [engine, setEngine] = useState<'opencode' | 'pi'>('opencode');
  const [newModel, setNewModel] = useState<Record<string, string>>({});
  const [mode, setMode] = useState('build');
  const [workspace, setWorkspace] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [connected, setConnected] = useState(true);
  const [theme, setTheme] = useState(() => document.documentElement.classList.contains('dark'));
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [rename, setRename] = useState<Session>();
  const [renameText, setRenameText] = useState('');
  const [menu, setMenu] = useState<Session>();
  const [newProject, setNewProject] = useState(false);
  const [folder, setFolder] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const invalidateTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: bootstrap, staleTime: 30000 });
  const models = useQuery({ queryKey: ['model-offerings'], queryFn: offerings, staleTime: 60000 });
  const sessionQuery = useQuery({
    queryKey: ['conversation', route.id],
    queryFn: async () => {
      const incoming = await v2<{ session: Session }>(`/conversations/${encodeURIComponent(route.id!)}`);
      const cached = client.getQueryData<{ session: Session }>(['conversation', route.id]);
      return { session: merge(cached?.session, incoming.session) };
    },
    enabled: route.view === 'chat' && !!route.id,
    staleTime: 30000,
  });
  const session = sessionQuery.data?.session;
  const projects = boot.data?.projects || [];
  const chosenProject = projects.find((project) => project.id === (route.view === 'chat' ? session?.projectId : projectId));
  const chosenEngine = route.view === 'chat' ? session?.engine || 'opencode' : engine;
  const chosenModel = route.view === 'chat' ? session?.modelPref : newModel[engine] || chosenProject?.defaults?.[engine] || models.data?.defaults?.[engine] || boot.data?.defaults?.[engine];
  const working = session?.resumeStatus === 'working';

  const notify = useCallback((text: string, error?: boolean) => {
    clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(undefined), 6000);
  }, []);
  const navigate = useCallback((next: Route) => {
    history.pushState({}, '', next.view === 'chat' ? `#chat/${next.id}` : `#${next.view}`);
    setRoute(next);
    setMobileNav(false);
  }, []);
  useEffect(() => { const handler = () => setRoute(readRoute()); window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, []);
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 200); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { document.documentElement.classList.toggle('dark', theme); try { localStorage.setItem('workbench-theme', theme ? 'dark' : 'light'); } catch { /* theme still applies */ } }, [theme]);
  useEffect(() => setWorkspace(''), [projectId]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); navigate({ view: 'history' }); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); navigate({ view: 'home' }); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  const initialSeq = useRef<number | null>(null);
  if (initialSeq.current === null && boot.data) initialSeq.current = boot.data.seq;
  const schedule = useCallback((key: string, fn: () => void, ms = 150) => {
    clearTimeout(invalidateTimers.current[key]);
    invalidateTimers.current[key] = setTimeout(fn, ms);
  }, []);
  useEffect(() => {
    if (initialSeq.current === null) return;
    const stream = new EventSource(`/api/v2/events?after=${initialSeq.current}`);
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (event) => {
      const data = JSON.parse(event.data) as { seq: number; type: string; conversationId?: string; message?: Message; commandId?: string; status?: string; error?: string | null };
      initialSeq.current = data.seq;
      const cid = data.conversationId;
      switch (data.type) {
        case 'message.updated':
          if (cid && data.message) client.setQueryData<{ session: Session }>(['conversation', cid], (current) => current ? { session: merge(current.session, { id: cid, messages: [data.message!] }) } : current);
          return;
        case 'run.updated':
          if (cid) {
            client.setQueryData<{ session: Session }>(['conversation', cid], (current) => {
              if (!current) return current;
              const run = current.session.activeRun;
              const nextRun = run && run.id === data.commandId
                ? { ...run, status: data.status!, error: data.error }
                : { id: data.commandId!, status: data.status!, error: data.error, model: current.session.modelPref || '' };
              return { session: { ...current.session, activeRun: nextRun, resumeStatus: WORKING_STATUSES.has(data.status!) ? 'working' : 'idle' } };
            });
          }
          if (TERMINAL_STATUSES.has(data.status || '')) {
            if (cid) schedule(`conversation:${cid}`, () => void client.invalidateQueries({ queryKey: ['conversation', cid] }));
            schedule('bootstrap', () => void client.invalidateQueries({ queryKey: ['bootstrap'] }));
            schedule('usage', () => void client.invalidateQueries({ queryKey: ['usage'] }), 800);
          }
          return;
        case 'command.accepted':
        case 'interaction.created':
        case 'interaction.answered':
          if (cid) schedule(`conversation:${cid}`, () => void client.invalidateQueries({ queryKey: ['conversation', cid] }));
          schedule('bootstrap', () => void client.invalidateQueries({ queryKey: ['bootstrap'] }));
          return;
        case 'conversation.changed':
          schedule('bootstrap', () => void client.invalidateQueries({ queryKey: ['bootstrap'] }));
          schedule('history', () => void client.invalidateQueries({ queryKey: ['history-v2'] }));
          if (cid) schedule(`conversation:${cid}`, () => void client.invalidateQueries({ queryKey: ['conversation', cid] }));
          return;
        case 'projects.changed':
          schedule('bootstrap', () => void client.invalidateQueries({ queryKey: ['bootstrap'] }));
          return;
        case 'models.changed':
          void client.invalidateQueries({ queryKey: ['model-offerings'] });
          void client.invalidateQueries({ queryKey: ['connections'] });
          return;
        case 'clips.changed':
          void client.invalidateQueries({ queryKey: ['context-clips'] });
          return;
        case 'resync':
          void client.invalidateQueries();
          return;
        default:
          if (cid) schedule(`conversation:${cid}`, () => void client.invalidateQueries({ queryKey: ['conversation', cid] }));
      }
    };
    return () => {
      stream.close();
      for (const timer of Object.values(invalidateTimers.current)) clearTimeout(timer);
    };
  }, [!!boot.data, client, schedule]);
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => { void boot.refetch(); if (route.id) void client.invalidateQueries({ queryKey: ['conversation', route.id] }); }, 10000);
    return () => clearInterval(timer);
  }, [connected, route.id, client]);

  const historyQuery = useInfiniteQuery({
    queryKey: ['history-v2', debounced, filterProject],
    initialPageParam: '',
    queryFn: ({ pageParam }) => v2<{ sessions: Session[]; nextCursor: string | null }>(`/conversations?q=${encodeURIComponent(debounced)}&projectId=${filterProject}&cursor=${encodeURIComponent(pageParam)}`),
    getNextPageParam: (last) => last.nextCursor || undefined,
    enabled: route.view === 'history',
  });

  async function patch(target: Session, data: Record<string, unknown>) {
    try {
      await mutate(`/conversations/${target.id}`, { ...data, revision: target.revision }, 'PATCH');
      await client.invalidateQueries({ queryKey: ['conversation', target.id] });
      await client.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (error) { notify((error as Error).message, true); }
  }
  async function setChatModel(target: Session, model: string) {
    await patch(target, { model, reasoning: null });
  }
  async function stop() {
    if (!session) return;
    try { await mutate(`/conversations/${session.id}/stop`, {}); await client.invalidateQueries({ queryKey: ['conversation', session.id] }); } catch (error) { notify((error as Error).message, true); }
  }

  const loadingOlder = useRef(false);
  async function older() {
    if (!session?.hasMoreMessages || !session.messages?.length || loadingOlder.current) return;
    loadingOlder.current = true;
    const height = viewport.current ? viewport.current.scrollHeight - viewport.current.scrollTop : 0;
    try {
      const result = await v2<{ session: Session }>(`/conversations/${encodeURIComponent(session.id)}?before=${encodeURIComponent(session.messages[0].id)}`);
      client.setQueryData<{ session: Session }>(['conversation', session.id], (current) => ({ session: { ...merge(current?.session, result.session), hasMoreMessages: result.session.hasMoreMessages } }));
      requestAnimationFrame(() => { if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight - height; });
    } catch (error) { notify((error as Error).message, true); } finally { loadingOlder.current = false; }
  }

  const contextMessage = [...(session?.messages || [])].reverse().find((message) => message.info.role === 'assistant' && message.info.tokens);
  const context = contextMessage ? messageContext(contextMessage) : null;

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      {mobileNav && <button aria-label="Close navigation" className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setMobileNav(false)} />}
      <aside className={cn('h-full w-[17rem] shrink-0 flex-col gap-2 bg-background px-3 pt-3 pb-2 md:flex', mobileNav ? 'fixed inset-y-0 left-0 z-50 flex' : 'hidden')}>
        <div className="flex h-8 items-center px-2 text-[13px] font-semibold">Workbench<span className="ml-auto text-[10px] font-normal text-muted-foreground">{connected ? 'Connected' : 'Reconnecting…'}</span></div>
        <button onClick={() => navigate({ view: 'home' })} className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] font-medium hover:bg-accent"><IconPlus size={16} />New conversation</button>
        {([['history', 'Search & history', IconSearch], ['clips', 'Context library', IconClipboardText], ['usage', 'Usage & models', IconChartBar]] as const).map(([view, label, Icon]) => (
          <button key={view} onClick={() => navigate({ view })} className={cn('flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] hover:bg-accent', route.view === view && 'bg-accent')}><Icon size={16} />{label}</button>
        ))}
        <div className="my-1 h-px bg-border" />
        <div className="flex items-center px-2 text-[10px] text-muted-foreground">PROJECTS<button aria-label="Add project folder" className="ml-auto p-1" onClick={() => setNewProject(true)}><IconPlus size={13} /></button></div>
        <button className={cn('truncate rounded-lg px-2 py-1 text-left text-xs hover:bg-accent', filterProject === 'general' && 'bg-accent')} onClick={() => { setProjectId(null); setFilterProject('general'); navigate({ view: 'history' }); }}>General</button>
        {projects.map((project) => (
          <button key={project.id} title={project.directory} className={cn('flex items-center gap-2 truncate rounded-lg px-2 py-1 text-left text-xs hover:bg-accent', filterProject === project.id && 'bg-accent')} onClick={() => { setProjectId(project.id); setFilterProject(project.id); navigate({ view: 'history' }); }}>
            <IconFolder size={13} />{project.name}
          </button>
        ))}
        <div className="my-1 h-px bg-border" />
        <div className="px-2 text-[10px] text-muted-foreground">RECENT CONVERSATIONS</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {boot.data?.sessions.map((item) => <ChatRow key={item.id} session={{ ...item, live: item.resumeStatus === 'working' }} active={item.id === route.id} onOpen={(selected) => navigate({ view: 'chat', id: selected.id })} onContextMenu={(event) => { event.preventDefault(); setMenu(item); }} onMenuAt={(_x, _y) => setMenu(item)} />)}
        </div>
        <footer className="mt-auto flex items-center gap-3 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
          <button aria-label="Toggle theme" onClick={() => setTheme(!theme)}>{theme ? <IconSun size={16} /> : <IconMoon size={16} />}</button>
          <a href="/logout">Sign out</a>
          <span className="ml-auto">OpenCode · Pi</span>
        </footer>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 md:py-2 md:pr-2">
        <div className="raised relative flex h-full min-h-0 flex-col overflow-hidden bg-surface md:rounded-lg md:border md:border-border">
          <div className="flex h-11 shrink-0 items-center gap-2 px-3 md:hidden">
            <button aria-label="Open navigation" onClick={() => setMobileNav(true)}><IconMenu2 size={20} /></button>
            <span className="truncate text-sm">{session?.title || 'Workbench'}</span>
          </div>
          {!connected && <div className="bg-well px-4 py-1.5 text-xs text-muted-foreground" role="status">Reconnecting. Drafts are saved on this device; accepted messages continue on the server.</div>}
          {boot.isError && <div role="alert" className="p-4 text-sm text-destructive">{boot.error.message} <button className="underline" onClick={() => void boot.refetch()}>Retry</button></div>}
          <Suspense fallback={<Loading />}>
            {route.view === 'usage' ? <Usage projects={projects} onToast={notify} />
              : route.view === 'clips' ? <Library projects={projects} projectId={projectId} onToast={notify} />
                : route.view === 'history' ? (
                  <div className="wb-scroll h-full overflow-y-auto p-4 md:p-8">
                    <div className="mx-auto max-w-2xl">
                      <h1 className="text-xl font-semibold">Search & history</h1>
                      <div className="mt-5 flex gap-2">
                        <input autoFocus aria-label="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles and recorded messages…" className="min-w-0 flex-1 rounded-xl bg-well p-3 text-sm outline-none" />
                        <select aria-label="History project" value={filterProject} onChange={(event) => setFilterProject(event.target.value)} className="max-w-44 rounded-xl bg-well p-2 text-xs">
                          <option value="">All projects</option><option value="general">General</option>
                          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                        </select>
                      </div>
                      <div className="mt-5 space-y-1">
                        {historyQuery.data?.pages.flatMap((page) => page.sessions).map((item) => <ChatRow key={item.id} session={{ ...item, live: item.resumeStatus === 'working' }} onOpen={(selected) => navigate({ view: 'chat', id: selected.id })} onMenuAt={(_x, _y) => setMenu(item)} />)}
                      </div>
                      {historyQuery.isPending && <Loading />}
                      {historyQuery.isError && <p role="alert">{historyQuery.error.message}</p>}
                      {historyQuery.hasNextPage && <button disabled={historyQuery.isFetchingNextPage} className="mt-5 rounded-full bg-well px-4 py-2 text-xs" onClick={() => void historyQuery.fetchNextPage()}>Load more</button>}
                    </div>
                  </div>
                ) : (
                  <>
                    {route.view === 'chat' && (
                      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 md:px-6">
                        <button aria-label="Back to home" className="p-1 text-muted-foreground" onClick={() => navigate({ view: 'home' })}><IconArrowLeft size={16} /></button>
                        <button className="mr-auto flex min-w-0 max-w-64 items-center gap-1.5 text-xs text-muted-foreground" title={session?.directory} onClick={() => session && setMenu(session)}>
                          <IconFolder size={13} className="shrink-0" />
                          <span className="truncate">{chosenProject?.name || 'General'} · {chosenEngine === 'pi' ? 'Pi' : 'OpenCode'}</span>
                        </button>
                        {working && session?.activeRun?.model && session.activeRun.model !== chosenModel && <span className="text-[10px] text-muted-foreground" title={`Running on ${session.activeRun.model}`}>Applies next turn</span>}
                        <ModelPicker engine={chosenEngine} value={chosenModel} session={session} project={chosenProject} onChange={(model) => session && void setChatModel(session, model)} onToast={notify} />
                        {context && context.limit > 0 && <span title={`${formatTokens(context.used)} / ${formatTokens(context.limit)} context tokens`} className="text-[10px] tabular-nums text-muted-foreground">Context {context.percent}%</span>}
                      </header>
                    )}
                    {route.view === 'chat' ? (
                      <div className="relative min-h-0 flex-1">
                        <Thread messages={session?.messages} isWorking={!!working} hasMore={session?.hasMoreMessages} onLoadOlder={() => void older()} viewportRef={viewport} />
                        {sessionQuery.isError && <p role="alert" className="absolute top-5 left-5 text-sm text-destructive">{sessionQuery.error.message}</p>}
                      </div>
                    ) : (
                      <div className="pt-12 md:pt-20"><HomeGreeting /></div>
                    )}
                    <div className={cn('shrink-0 px-3 pb-3 md:px-6', route.view === 'home' && 'mx-auto w-full max-w-3xl')}>
                      <div className="mx-auto max-w-3xl">
                        {route.view === 'home' && (
                          <div className="mb-3 flex flex-wrap items-center gap-2">
                            <select aria-label="Conversation project" value={projectId || 'general'} onChange={(event) => setProjectId(event.target.value === 'general' ? null : event.target.value)} className="h-8 max-w-48 rounded-full bg-well px-3 text-xs">
                              <option value="general">General</option>
                              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                            </select>
                            <select aria-label="Agent engine" value={engine} onChange={(event) => { setEngine(event.target.value as 'pi' | 'opencode'); }} className="h-8 rounded-full bg-well px-3 text-xs">
                              <option value="opencode">OpenCode</option><option value="pi">Pi</option>
                            </select>
                            <select aria-label="Agent mode" value={mode} onChange={(event) => setMode(event.target.value)} className="h-8 rounded-full bg-well px-3 text-xs">
                              <option value="build">Build</option><option value="plan">Read-only / plan</option>
                            </select>
                            <ModelPicker engine={engine} value={chosenModel} project={chosenProject} onChange={(model) => setNewModel((old) => ({ ...old, [engine]: model }))} onToast={notify} />
                            {(chosenProject?.workspaces?.length || 0) > 1 && (
                              <select aria-label="Project workspace" value={workspace || chosenProject?.directory} onChange={(event) => setWorkspace(event.target.value)} className="h-8 max-w-64 rounded-full bg-well px-3 text-xs">
                                {chosenProject?.workspaces?.map((directory) => <option key={directory} value={directory}>{directory}</option>)}
                              </select>
                            )}
                          </div>
                        )}
                        {route.view === 'chat' && session && <RunCard session={session} onStop={() => void stop()} onToast={notify} />}
                        {session?.interactions?.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} onDone={() => void client.invalidateQueries({ queryKey: ['conversation', session.id] })} onError={(error) => notify(error, true)} />)}
                        {!!session?.queued?.length && (
                          <div className="mb-2 max-h-28 overflow-auto rounded-xl bg-well px-3 py-2 text-xs">
                            <p className="mb-1 text-muted-foreground">{session.paused ? 'Queue paused' : `${session.queued.length} queued on the server`}</p>
                            {session.queued.map((queued) => (
                              <div key={queued.id} className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate">{queued.text || 'Attached files'}</span>
                                <span className="max-w-32 truncate text-[10px] text-muted-foreground">{queued.model.split('/').at(-1)}</span>
                                <button aria-label="Remove queued message" onClick={() => void v2(`/commands/${queued.id}`, { method: 'DELETE' }).then(() => client.invalidateQueries({ queryKey: ['conversation', session.id] })).catch((error) => notify(error.message, true))}><IconX size={13} /></button>
                              </div>
                            ))}
                          </div>
                        )}
                        {chosenEngine === 'opencode' && session && (session.reasoning || models.data?.models.some((model) => model.engine === 'opencode' && model.id === chosenModel && model.reasoning)) && (
                          <label className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                            Reasoning
                            <select aria-label="Reasoning effort" className="rounded bg-well p-1" value={route.view === 'chat' ? session.reasoning || '' : ''} onChange={(event) => { if (route.view === 'chat' && session) void patch(session, { reasoning: event.target.value || null }); }}>
                              <option value="">Default</option>
                              {(models.data?.models.find((model) => model.id === chosenModel && model.engine === chosenEngine)?.variants || ['low', 'medium', 'high']).map((value) => <option key={value}>{value}</option>)}
                            </select>
                          </label>
                        )}
                        <Editor
                          key={route.id || `new:${projectId}:${engine}`}
                          draftKey={route.id || `new:${projectId}:${engine}`}
                          session={route.view === 'chat' ? session : undefined}
                          engine={chosenEngine}
                          model={chosenModel || ''}
                          reasoning={route.view === 'chat' ? session?.reasoning : null}
                          mode={mode}
                          workspace={workspace || undefined}
                          projects={projects}
                          project={chosenProject}
                          projectId={route.view === 'chat' ? session?.projectId : projectId}
                          onNavigate={(id) => navigate({ view: 'chat', id })}
                          onToast={notify}
                          working={!!working}
                          onStop={() => void stop()}
                        />
                      </div>
                    </div>
                    {route.view === 'home' && (
                      <div className="min-h-0 flex-1 overflow-auto px-3">
                        <div className="mx-auto max-w-3xl px-0 md:px-6">
                          <HomeSuggestions onPick={(text) => { void localWrite(`suggestion:new:${projectId}:${engine}`, text); window.dispatchEvent(new CustomEvent('workbench-suggestion', { detail: text })); }} />
                          <h2 className="mt-8 mb-2 text-[11px] text-muted-foreground">Recent conversations</h2>
                          {boot.data?.sessions.slice(0, 5).map((item) => <ChatRow key={item.id} session={{ ...item, live: item.resumeStatus === 'working' }} onOpen={(selected) => navigate({ view: 'chat', id: selected.id })} onMenuAt={(_x, _y) => setMenu(item)} />)}
                        </div>
                      </div>
                    )}
                  </>
                )}
          </Suspense>
        </div>
      </main>

      <Dialog open={!!menu} onOpenChange={(open) => { if (!open) setMenu(undefined); }}>
        <DialogContent>
          <DialogTitle>Conversation settings</DialogTitle>
          <DialogDescription>{menu?.title}</DialogDescription>
          {menu && (
            <div className="space-y-3 text-sm">
              <p className="text-xs break-all text-muted-foreground">Execution folder: {menu.directory}</p>
              <label className="block">
                Organize under project
                <select aria-label="Assign conversation project" value={menu.projectId || 'general'} className="mt-2 w-full rounded-lg bg-well p-2" onChange={(event) => { void patch(menu, { projectId: event.target.value === 'general' ? null : event.target.value }); setMenu(undefined); }}>
                  <option value="general">General</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">Organizing a conversation does not change its execution folder. Use a fork to change engine or workspace.</p>
              <div className="flex flex-wrap gap-2">
                <button className="rounded-full bg-well px-3 py-2" onClick={() => { setRename(menu); setRenameText(menu.title || ''); setMenu(undefined); }}>Rename</button>
                <button className="rounded-full bg-well px-3 py-2" onClick={() => { void mutate(`/conversations/${menu.id}/title`, {}).then(() => { notify('Regenerating title…'); void client.invalidateQueries({ queryKey: ['bootstrap'] }); }).catch((error) => notify(error.message, true)); setMenu(undefined); }}>Regenerate title</button>
                <button className="rounded-full bg-well px-3 py-2" onClick={() => { void patch(menu, { pinned: !menu.pinned }); setMenu(undefined); }}>{menu.pinned ? 'Unpin' : 'Pin'}</button>
                <button className="rounded-full bg-well px-3 py-2" onClick={() => { void patch(menu, { hidden: true }); setMenu(undefined); if (route.id === menu.id) navigate({ view: 'home' }); }}>Archive</button>
                {(['opencode', 'pi'] as const).map((nextEngine) => (
                  <button key={nextEngine} className="rounded-full bg-well px-3 py-2" onClick={() => void mutate<{ session: Session }>(`/conversations/${menu.id}/fork`, { engine: nextEngine }).then((result) => { setMenu(undefined); navigate({ view: 'chat', id: result.session.id }); }).catch((error) => notify(error.message, true))}>Fork with {nextEngine === 'pi' ? 'Pi' : 'OpenCode'}</button>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={!!rename} onOpenChange={(open) => { if (!open) setRename(undefined); }}>
        <DialogContent>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>Synced across your devices.</DialogDescription>
          <input aria-label="Conversation title" value={renameText} onChange={(event) => setRenameText(event.target.value)} className="rounded-lg bg-well p-2" />
          <button className="rounded-full bg-primary px-4 py-2 text-primary-foreground" onClick={() => { if (rename) void patch(rename, { title: renameText }); setRename(undefined); }}>Save</button>
        </DialogContent>
      </Dialog>
      <Dialog open={newProject} onOpenChange={setNewProject}>
        <DialogContent>
          <DialogTitle>Add project folder</DialogTitle>
          <DialogDescription>Choose an existing folder under your configured project roots.</DialogDescription>
          <input aria-label="Project folder path" placeholder="~/projects/my-project" value={folder} onChange={(event) => setFolder(event.target.value)} className="rounded-lg bg-well p-2" />
          <button className="rounded-full bg-primary px-4 py-2 text-primary-foreground" onClick={() => void mutate('/projects', { directory: folder }).then(() => { setNewProject(false); setFolder(''); void client.invalidateQueries({ queryKey: ['bootstrap'] }); }).catch((error) => notify(error.message, true))}>Add project</button>
        </DialogContent>
      </Dialog>

      {toast && <div role={toast.error ? 'alert' : 'status'} className={cn('raised fixed right-4 bottom-4 z-[150] max-w-sm rounded-xl bg-popover p-3 text-sm ring-1 ring-border', toast.error && 'text-destructive')}>{toast.text}</div>}
    </div>
  );
}
