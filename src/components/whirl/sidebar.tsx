import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  IconBell,
  IconBolt,
  IconChartBar,
  IconClipboardText,
  IconClock,
  IconDots,
  IconHome,
  IconLayoutSidebarRight,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSun,
} from '@tabler/icons-react';
import { ChatRow } from '@/components/whirl/chat-row';
import { DotsRing } from '@/components/loading-ui/dots-ring';
import type { Agent, Attention, Overview, RunState, Session, SystemSnapshot } from '@/lib/types';
import { attentionOf, isRunningSession, runStateOf, runStatusLabel } from '@/lib/workbench';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

export type AppView = 'home' | 'history' | 'clips' | 'usage' | 'chat';

type SessionFilter = 'all' | 'running' | 'archived';

export interface CurrentModelChip {
  id: string;
  name: string;
  provider?: string;
}

export interface UsageStatusChip {
  label: string;
  percent?: number;
  tone: 'ok' | 'warn' | 'over';
}

/* Whirl's rail: chrome on the grey background, one hover tone for every
   row, section rules instead of boxes. */
export function Sidebar({
  view,
  overview,
  selectedSessionId,
  system,
  systemOpen,
  theme,
  running,
  attention,
  currentModel,
  usageStatus,
  unreadNotifications,
  archived,
  archivedLoading,
  onNavigate,
  onOpenSession,
  onNewTask,
  onSearch,
  onOpenSystem,
  onOpenUsage,
  onOpenNotifications,
  onToggleArchived,
  onToggleTheme,
  onContextMenu,
  onMenuAt,
}: {
  view: AppView;
  overview?: Overview;
  selectedSessionId?: string;
  system?: SystemSnapshot;
  systemOpen: boolean;
  theme: 'light' | 'dark';
  shortcutLabel?: string;
  running: Session[];
  attention: Session[];
  currentModel?: CurrentModelChip | null;
  usageStatus?: UsageStatusChip | null;
  unreadNotifications?: number;
  archived?: Session[];
  archivedLoading?: boolean;
  onNavigate: (view: Exclude<AppView, 'chat'>) => void;
  onOpenSession: (session: Session) => void;
  onOpenAgent: (agent: Agent) => void;
  onNewTask: () => void;
  onSearch: () => void;
  onOpenSystem: () => void;
  onOpenUsage: () => void;
  onOpenNotifications: () => void;
  onToggleArchived: (open: boolean) => void;
  onToggleTheme: () => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
}) {
  const [filter, setFilter] = useState<SessionFilter>('all');  const attentionIds = new Set(attention.map((session) => session.id));
  const runningIds = new Set(running.map((session) => session.id));
  const history = (overview?.sessions || []).filter((session) => !runningIds.has(session.id) && !attentionIds.has(session.id));
  const runningView = filter === 'running'
    ? [...running, ...attention.filter((session) => !runningIds.has(session.id))]
    : running;

  useEffect(() => {
    onToggleArchived(filter === 'archived');
  }, [filter, onToggleArchived]);

  return (
    <aside className="hidden h-full w-[17rem] shrink-0 flex-col gap-1 px-2 pt-2 pb-2 md:flex" aria-label="Workspace navigation">
      <div className="flex h-7 items-center gap-1 px-1">
        <span className="text-[13px] font-semibold tracking-tight">Workbench</span>
        <button
          type="button"
          onClick={onOpenNotifications}
          aria-label={unreadNotifications ? `${unreadNotifications} unread notifications` : 'Notifications'}
          title="Notifications"
          className="relative ml-auto grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <IconBell size={15} />
          {Boolean(unreadNotifications) && (
            <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] leading-4 font-semibold text-primary-foreground tabular-nums">
              {unreadNotifications! > 9 ? '9+' : unreadNotifications}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onOpenSystem}
          aria-expanded={systemOpen}
          title="System performance"
          className="inline-flex cursor-pointer items-center rounded-full px-1.5 py-1 text-[10px] whitespace-nowrap tabular-nums text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          {system?.cpu ? `CPU ${system.cpu.percent}% · RAM ${system.memoryPercent ?? 0}%` : 'System…'}
        </button>
      </div>

      <button
        type="button"
        onClick={onOpenUsage}
        title="Current provider, model and usage"
        className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] transition-colors duration-150 hover:bg-accent"
      >
        <IconBolt size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">
          {currentModel
            ? <>{currentModel.provider && <span className="text-muted-foreground">{currentModel.provider} · </span>}{currentModel.name}</>
            : <span className="text-muted-foreground">No model selected</span>}
        </span>
        {usageStatus && (
          <span className={cn(
            'shrink-0 text-[10px] tabular-nums',
            usageStatus.tone === 'over' ? 'text-destructive' : usageStatus.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}>
            {usageStatus.label}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={onNewTask}
        className="flex h-8 w-full cursor-pointer items-center justify-start gap-2 rounded-md px-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-accent"
      >
        <IconPlus size={16} stroke={2.4} />
        New task
      </button>

      <nav className="-mt-1.5 flex flex-col gap-0.5">
        <SidebarRow Icon={IconHome} label="Home" active={view === 'home'} onClick={() => onNavigate('home')} />
        <SidebarRow Icon={IconSearch} label="Search" hint="⌘K" onClick={onSearch} />
        <SidebarRow Icon={IconClock} label="History" active={view === 'history'} onClick={() => onNavigate('history')} />
        <SidebarRow Icon={IconClipboardText} label="Clipboard" active={view === 'clips'} onClick={() => onNavigate('clips')} />
        <SidebarRow Icon={IconChartBar} label="Usage & models" active={view === 'usage'} onClick={() => onNavigate('usage')} />
      </nav>

      <div role="separator" className="mx-1.5 h-px shrink-0 bg-border" />

      <div className="flex items-center gap-0.5 px-1">
        {(['all', 'running', 'archived'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={cn(
              'flex-1 cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors duration-100',
              filter === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="wb-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 pb-1">
        {filter === 'archived' ? (
          <ArchivedList
            sessions={archived}
            loading={archivedLoading}
            selectedSessionId={selectedSessionId}
            onOpenSession={onOpenSession}
            onContextMenu={onContextMenu}
            onMenuAt={onMenuAt}
          />
        ) : (
          <>
            {runningView.length > 0 && (
              <section className="flex flex-col gap-0.5">
                <SectionLabel>Running</SectionLabel>
                {runningView.map((session) => (
                  <RunRow
                    key={session.id}
                    session={session}
                    active={session.id === selectedSessionId}
                    attention={attentionOf(session)}
                    onOpen={onOpenSession}
                    onContextMenu={onContextMenu}
                    onMenuAt={onMenuAt}
                  />
                ))}
              </section>
            )}

            {filter === 'running' && runningView.length === 0 && (
              <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No runs in progress.</p>
            )}

            {filter === 'all' && attention.length > 0 && (
              <section className="flex flex-col gap-0.5">
                <SectionLabel>Needs attention</SectionLabel>
                {attention.map((session) => (
                  <RunRow
                    key={session.id}
                    session={session}
                    active={session.id === selectedSessionId}
                    attention={attentionOf(session)}
                    onOpen={onOpenSession}
                    onContextMenu={onContextMenu}
                    onMenuAt={onMenuAt}
                  />
                ))}
              </section>
            )}

            {filter === 'all' && (
              history.length === 0 && running.length === 0 && attention.length === 0 ? (
                <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No conversations yet.</p>
              ) : (
                groupSessions(history.slice(0, 40)).map(([label, items]) => (
                  <section key={label} className="flex flex-col gap-0.5">
                    <SectionLabel>{label}</SectionLabel>
                    {items.map((session) => (
                      <ChatRow
                        key={session.id}
                        session={session}
                        active={session.id === selectedSessionId}
                        onOpen={onOpenSession}
                        onContextMenu={onContextMenu}
                        onMenuAt={onMenuAt}
                      />
                    ))}
                  </section>
                ))
              )
            )}
          </>
        )}
      </div>

      <footer className="mt-auto flex items-center gap-1 border-t border-border px-1 pt-1.5">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
        <a
          href="/logout"
          aria-label="Sign out"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <IconLogout size={15} />
        </a>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <IconLayoutSidebarRight size={12} />
          {running.length} running
        </span>
      </footer>
    </aside>
  );
}

/* Whirl's date markers: quiet labels above each run of rows. */
function SectionLabel({ children }: { children: string }) {
  return <div className="flex h-4 items-center px-2.5 text-[10.5px]/4 font-medium text-muted-foreground/55">{children}</div>;
}

function ArchivedList({
  sessions,
  loading,
  selectedSessionId,
  onOpenSession,
  onContextMenu,
  onMenuAt,
}: {
  sessions?: Session[];
  loading?: boolean;
  selectedSessionId?: string;
  onOpenSession: (session: Session) => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
}) {
  if (loading) return <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Loading archived…</p>;
  if (!sessions?.length) return <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No archived conversations.</p>;
  return (
    <section className="flex flex-col gap-0.5">
      <SectionLabel>Archived</SectionLabel>
      {sessions.map((session) => (
        <ChatRow
          key={session.id}
          session={session}
          active={session.id === selectedSessionId}
          onOpen={onOpenSession}
          onContextMenu={onContextMenu}
          onMenuAt={onMenuAt}
        />
      ))}
      <p className="px-2.5 py-1 text-[10.5px] text-muted-foreground/70">Right-click a row to restore.</p>
    </section>
  );
}

/* Pinned first, then Whirl's day buckets. Recency order is preserved by the
   server; this only labels the runs. */
function groupSessions(sessions: Session[]): Array<[string, Session[]]> {
  const groups: Array<[string, Session[]]> = [];
  const dayStart = (value?: number) => {
    const date = new Date(value || 0);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const today = dayStart(Date.now());
  for (const session of sessions) {
    let label = 'Older';
    if (session.pinned) {
      label = 'Pinned';
    } else {
      const diff = Math.floor((today - dayStart(session.updated)) / 86_400_000);
      if (diff <= 0) label = 'Today';
      else if (diff === 1) label = 'Yesterday';
      else if (diff <= 7) label = 'Previous 7 days';
      else if (diff <= 30) label = 'Previous 30 days';
    }
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(session);
    else groups.push([label, [session]]);
  }
  return groups;
}

function SidebarRow({
  Icon,
  label,
  hint,
  active,
  onClick,
}: {
  Icon: typeof IconHome;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group/row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-100',
        active ? 'bg-accent font-medium text-foreground' : 'text-foreground-soft hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="truncate">{label}</span>
      {hint && <kbd className="ml-auto text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100">{hint}</kbd>}
    </button>
  );
}

function attentionLabel(attention: Attention): string {
  return attention === 'permission' ? 'Permission required' : 'Waiting for input';
}

/* A compact running/attention row: state, elapsed, and the same ⋯ actions as
   a normal chat row. */
function RunRow({
  session,
  active,
  attention,
  onOpen,
  onContextMenu,
  onMenuAt,
}: {
  session: Session;
  active: boolean;
  attention: Attention;
  onOpen: (session: Session) => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
}) {
  const state: RunState | null = runStateOf(session);
  const started = session.activeRun?.started;
  const elapsed = started ? formatDuration((Date.now() - started) / 1000) : '';
  const needsAttention = attention !== 'none';
  const label = needsAttention ? attentionLabel(attention) : runStatusLabel(state);
  const working = !needsAttention && isRunningSession(session);
  const todos = session.activeRun?.todos || [];
  const done = todos.filter((todo) => ['done', 'completed', 'succeeded'].includes(String(todo.status || '').toLowerCase())).length;
  const meta = [label, todos.length ? `${done}/${todos.length}` : '', elapsed].filter(Boolean).join(' · ');

  return (
    <div data-session-row={session.id} className={cn('group/row relative flex w-full min-w-0 items-center rounded-md transition-colors duration-100', active ? 'bg-accent' : 'hover:bg-accent')}>
      <button
        type="button"
        onClick={() => onOpen(session)}
        onContextMenu={(event) => onContextMenu?.(event, session)}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-md py-1.5 pr-7 pl-2 text-left"
      >
        <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center">
          {working ? (
            <DotsRing className="size-3.5 text-foreground" aria-hidden="true" />
          ) : (
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', needsAttention ? 'bg-amber-500' : 'bg-muted-foreground/50')} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{session.title || 'Conversation'}</span>
          <span className={cn('block truncate text-[11px] tabular-nums', needsAttention ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
            {meta}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Actions for ${session.title || 'conversation'}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenuAt?.(Math.max(8, rect.right - 216), rect.bottom + 4, session);
        }}
        className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-foreground-soft opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:bg-accent focus-visible:opacity-100 coarse:opacity-100"
      >
        <IconDots size={15} />
      </button>
    </div>
  );
}
