import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { IconLoader2, IconSearch } from '@tabler/icons-react';
import { ChatRow } from '@/components/whirl/chat-row';
import { projectIdForDirectory } from '@/lib/api';
import type { Overview, Session } from '@/lib/types';
import { cn, shortDirectory } from '@/lib/utils';
import { v2 } from '@/lib/workbench';

/* The v2 API pages conversations with an opaque cursor; the adapter's
   getHistory only returns the first page. Cursor pages call v2 directly with
   the same directory → projectId mapping the adapter uses. */
async function fetchHistoryPage(query: string, directory: string, cursor?: string) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const projectId = projectIdForDirectory(directory);
  if (projectId) params.set('projectId', projectId);
  if (cursor) params.set('cursor', cursor);
  return v2<{ sessions: Session[]; nextCursor?: string | null }>(`/conversations?${params.toString()}`);
}

export function HistoryView({
  overview,
  projectFilter,
  onProjectFilter,
  onOpenSession,
  onContextMenu,
  onMenuAt,
}: {
  overview: Overview;
  projectFilter: string | null;
  onProjectFilter: (directory: string | null) => void;
  onOpenSession: (session: Session) => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const directory = projectFilter || '';

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const historyQuery = useInfiniteQuery({
    queryKey: ['history', debounced, directory],
    queryFn: ({ pageParam }) => fetchHistoryPage(debounced, directory, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });

  const sessions = (historyQuery.data?.pages || [])
    .flatMap((page) => page.sessions)
    .filter((session, index, all) => all.findIndex((item) => item.id === session.id) === index);

  return (
    <div className="wb-scroll h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-3 pt-[max(2.5rem,env(safe-area-inset-top))] pb-16 md:px-6">
        <h1 className="px-1 text-[20px] font-semibold tracking-tight">History</h1>
        <p className="mt-1 px-1 text-[13px] text-muted-foreground">Every saved conversation across your projects.</p>

        <div className="relative mt-5">
          <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-10 w-full rounded-xl bg-well pr-4 pl-9 text-[13px] ring-1 ring-[var(--well-outline)] transition-shadow outline-none placeholder:text-muted-foreground focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--foreground)_6%,transparent)]"
          />
        </div>

        {overview.directories.length > 0 && (
          <div className="wb-scroll mt-3 flex gap-1.5 overflow-x-auto pb-1">
            <FilterChip active={!directory} label="All projects" onClick={() => onProjectFilter(null)} />
            {overview.directories.map((item) => (
              <FilterChip
                key={item.directory}
                active={directory === item.directory}
                label={item.name || shortDirectory(item.directory)}
                onClick={() => onProjectFilter(directory === item.directory ? null : item.directory)}
              />
            ))}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-1">
          {historyQuery.isPending && !historyQuery.data ? (
            <div className="grid place-items-center py-16 text-muted-foreground"><IconLoader2 size={20} className="animate-spin" /></div>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-12 text-center text-[13px] text-muted-foreground">No conversations match.</p>
          ) : (
            sessions.map((session) => (
              <ChatRow
                key={session.id}
                session={session}
                onOpen={onOpenSession}
                onContextMenu={onContextMenu}
                onMenuAt={onMenuAt}
              />
            ))
          )}
        </div>

        {sessions.length > 0 && historyQuery.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              disabled={historyQuery.isFetchingNextPage}
              onClick={() => void historyQuery.fetchNextPage()}
              className="cursor-pointer rounded-full bg-well px-4 py-2 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--well-outline)] transition-colors duration-150 hover:bg-accent disabled:opacity-50"
            >
              {historyQuery.isFetchingNextPage ? 'Loading…' : `Load more (${sessions.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 cursor-pointer rounded-full px-3 py-1.5 text-[12px] transition-colors duration-100',
        active
          ? 'bg-primary font-medium text-primary-foreground'
          : 'bg-well text-foreground-soft shadow-[inset_0_0_0_1px_var(--well-outline)] hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
