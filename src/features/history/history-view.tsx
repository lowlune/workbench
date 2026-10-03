import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ClockCounterClockwise, MagnifyingGlass, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Agent, Overview, Session } from '@/lib/types';
import { getHistory } from '@/lib/api';
import { cn, plainPreview, shortDirectory, timeAgo } from '@/lib/utils';

interface HistoryViewProps {
  overview: Overview;
  projectFilter: string | null;
  onProjectFilter: (directory: string | null) => void;
  onOpenSession: (session: Session, agent?: Agent) => void;
}

export function HistoryView({ overview, projectFilter, onProjectFilter, onOpenSession }: HistoryViewProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const historyQuery = useInfiniteQuery({
    queryKey: ['history', debouncedSearch, projectFilter],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '40', offset: String(pageParam) });
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (projectFilter) params.set('directory', projectFilter);
      return getHistory(params);
    },
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.sessions.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const sessions = historyQuery.data?.pages.flatMap((page) => page.sessions) || [];
  const liveBySession = new Map(overview.agents.filter((agent) => agent.sessionId).map((agent) => [agent.sessionId!, agent]));
  const selectedProject = overview.directories.find((directory) => directory.directory === projectFilter);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-7 sm:px-7 sm:py-9">
      <header>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">Workspace</p>
        <h1 className="text-2xl font-semibold tracking-tight">{selectedProject?.name || 'Conversation history'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Search by task, project, or the latest message.</p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <MagnifyingGlass aria-hidden="true" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <span className="sr-only">Search conversations</span>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations…" className="pl-10 pr-10" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><X aria-hidden="true" size={15} /></button>}
        </label>
        <label className="sr-only" htmlFor="history-project">Filter by project</label>
        <select
          id="history-project"
          value={projectFilter || ''}
          onChange={(event) => onProjectFilter(event.target.value || null)}
          className="h-10 min-w-48 rounded-lg border border-input bg-panel px-3 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value="">All projects</option>
          {overview.directories.map((directory) => <option key={directory.directory} value={directory.directory}>{directory.name}</option>)}
        </select>
      </div>

      {historyQuery.isPending ? (
        <div className="grid gap-2" aria-label="Loading conversations">
          {Array.from({ length: 5 }, (_, index) => <div key={index} className="h-[76px] animate-pulse rounded-xl border border-border bg-panel" />)}
        </div>
      ) : historyQuery.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5" role="alert">
          <p className="font-medium text-destructive">Could not load history.</p>
          <p className="mt-1 text-sm text-muted-foreground">{historyQuery.error.message}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void historyQuery.refetch()}>Try again</Button>
        </div>
      ) : sessions.length ? (
        <section aria-label="Conversations">
          <div className="mb-2 text-xs text-muted-foreground" aria-live="polite">{historyQuery.data?.pages[0]?.total || 0} conversations</div>
          <div className="overflow-hidden rounded-2xl border border-border bg-panel">
            {sessions.map((session, index) => {
              const agent = liveBySession.get(session.id);
              return (
                <button key={session.id} type="button" onClick={() => onOpenSession(session, agent)} className={cn('flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent sm:px-5', index > 0 && 'border-t border-border')}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><ClockCounterClockwise aria-hidden="true" size={18} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{session.title || 'Untitled conversation'}</span>
                      {agent && <span className={cn('size-2 shrink-0 rounded-full', agent.status === 'working' ? 'bg-success' : agent.status === 'blocked' ? 'bg-warning' : 'bg-muted-foreground/50')} aria-label={agent.status === 'working' ? 'Agent working' : agent.status === 'blocked' ? 'Agent needs you' : 'Agent online'} />}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{plainPreview(session.preview) || session.agent || 'No message preview'}</span>
                  </span>
                  <span className="hidden max-w-40 shrink-0 truncate text-xs text-muted-foreground md:block">{shortDirectory(session.directory)}</span>
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(Number(session.updated || session.created || 0)).toISOString()}>{timeAgo(session.updated || session.created)}</time>
                </button>
              );
            })}
          </div>
          {historyQuery.hasNextPage && <div className="mt-4 flex justify-center"><Button variant="outline" onClick={() => void historyQuery.fetchNextPage()} disabled={historyQuery.isFetchingNextPage}>{historyQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}</Button></div>}
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-panel p-9 text-center">
          <ClockCounterClockwise aria-hidden="true" size={28} className="mx-auto text-muted-foreground" />
          <h2 className="mt-3 text-sm font-semibold">No conversations found</h2>
          <p className="mt-1 text-sm text-muted-foreground">Try another search or clear the project filter.</p>
        </div>
      )}
    </div>
  );
}
