import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  IconBell,
  IconChartBar,
  IconClock,
  IconDots,
  IconHome,
  IconLayoutSidebarRight,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSun,
} from '@tabler/icons-react';
import { ChatRow } from '@/components/whirl/chat-row';
import { InlineTitleEditor } from '@/components/whirl/inline-title-editor';
import { DotsRing } from '@/components/loading-ui/dots-ring';
import type { Agent, Attention, Overview, RunState, Session, SystemSnapshot } from '@/lib/types';
import { attentionOf, isRunningSession, runStateOf, runStatusLabel } from '@/lib/workbench';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

export type AppView = 'home' | 'history' | 'clips' | 'usage' | 'chat';

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
  unreadNotifications,
  archived,
  archivedLoading,
  onNavigate,
  onOpenSession,
  onNewTask,
  onOpenSystem,
  onOpenNotifications,
  onToggleArchived,
  onToggleTheme,
  onContextMenu,
  onMenuAt,
  onSaveTitle,
  onRegenerateTitle,
  onTitleError,
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
  unreadNotifications?: number;
  archived?: Session[];
  archivedLoading?: boolean;
  onNavigate: (view: Exclude<AppView, 'chat'>) => void;
  onOpenSession: (session: Session) => void;
  onOpenAgent: (agent: Agent) => void;
  onNewTask: () => void;
  onOpenSystem: () => void;
  onOpenNotifications: () => void;
  onToggleArchived: (open: boolean) => void;
  onToggleTheme: () => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
  onSaveTitle?: (sessionId: string, title: string, revision?: number) => Promise<void>;
  onRegenerateTitle?: (sessionId: string) => Promise<string>;
  onTitleError?: (message: string) => void;
}) {
  const attentionIds = new Set(attention.map((session) => session.id));
  const runningIds = new Set(running.map((session) => session.id));
  const history = (overview?.sessions || []).filter((session) => !runningIds.has(session.id) && !attentionIds.has(session.id));
  useEffect(() => {
    onToggleArchived(false);
  }, [onToggleArchived]);

  return (
    <aside className="hidden h-full w-[17rem] shrink-0 flex-col gap-1 px-2 pt-2 pb-2 md:flex" aria-label="Workspace navigation">
      <div className="flex h-7 items-center gap-1 px-1">
        <span className="text-[13px] font-semibold tracking-tight">W</span>
        <button
          type="button"
          onClick={onOpenSystem}
          aria-expanded={systemOpen}
          title="System performance"
          className="ml-auto inline-flex cursor-pointer items-center rounded-full px-1.5 py-1 text-[10px] whitespace-nowrap tabular-nums text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
        >
          {system?.cpu ? `CPU ${system.cpu.percent}% · RAM ${system.memoryPercent ?? 0}%` : 'System…'}
        </button>
        <button
          type="button"
          onClick={onOpenNotifications}
          aria-label={unreadNotifications ? `${unreadNotifications} unread notifications` : 'Notifications'}
          title="Notifications"
          className="relative grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
        >
          <IconBell size={15} />
          {Boolean(unreadNotifications) && (
            <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] leading-4 font-semibold text-primary-foreground tabular-nums">
              {unreadNotifications! > 9 ? '9+' : unreadNotifications}
            </span>
          )}
        </button>
      </div>

      <button
        type="button"
        onClick={onNewTask}
        className="flex h-8 w-full cursor-pointer items-center justify-start gap-2 rounded-md px-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-accent"
      >
        <IconPlus size={16} stroke={2.4} />
        New task
      </button>

      <nav className="-mt-1.5 flex flex-col gap-0.5">
        <SidebarRow Icon={IconClock} label="History" active={view === 'history'} onClick={() => onNavigate('history')} />
        <SidebarRow Icon={IconChartBar} label="Usage & models" active={view === 'usage'} onClick={() => onNavigate('usage')} />
      </nav>

      <div role="separator" className="mx-1.5 h-px shrink-0 bg-border" />

      <div className="wb-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 pb-1">
        {archivedLoading ? (
          <ArchivedList
            sessions={archived}
            loading={archivedLoading}
            selectedSessionId={selectedSessionId}
            onOpenSession={onOpenSession}
            onContextMenu={onContextMenu}
            onMenuAt={onMenuAt}
            onSaveTitle={onSaveTitle}
            onRegenerateTitle={onRegenerateTitle}
            onTitleError={onTitleError}
          />
        ) : (
          <>
            {running.filter((session) => !attentionIds.has(session.id)).length > 0 && (
              <section className="flex flex-col gap-0.5">
                <SectionLabel>Running</SectionLabel>
                {running.filter((session) => !attentionIds.has(session.id)).map((session) => (
                  <RunRow key={session.id} session={session} active={session.id === selectedSessionId} attention={attentionOf(session)} onOpen={onOpenSession} onContextMenu={onContextMenu} onMenuAt={onMenuAt} onSaveTitle={onSaveTitle} onRegenerateTitle={onRegenerateTitle} onTitleError={onTitleError} />
                ))}
              </section>
            )}
            {attention.length > 0 && (
              <section className="flex flex-col gap-0.5">
                <SectionLabel>Needs attention</SectionLabel>
                {attention.map((session) => (
                  <RunRow key={session.id} session={session} active={session.id === selectedSessionId} attention={attentionOf(session)} onOpen={onOpenSession} onContextMenu={onContextMenu} onMenuAt={onMenuAt} onSaveTitle={onSaveTitle} onRegenerateTitle={onRegenerateTitle} onTitleError={onTitleError} />
                ))}
              </section>
            )}
            {history.length === 0 && running.length === 0 && attention.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No conversations yet.</p>
            ) : (
              groupSessions(history.slice(0, 40)).map(([label, items]) => (
                <section key={label} className="flex flex-col gap-0.5">
                  <SectionLabel>{label}</SectionLabel>
                  {items.map((session) => (
                    <ChatRow key={session.id} session={session} active={session.id === selectedSessionId} onOpen={onOpenSession} onContextMenu={onContextMenu} onMenuAt={onMenuAt} onSaveTitle={onSaveTitle} onRegenerateTitle={onRegenerateTitle} onTitleError={onTitleError} />
                  ))}
                </section>
              ))
            )}
          </>
        )}
      </div>

      <footer className="mt-auto flex items-center gap-1 border-t border-border px-1 pt-1.5">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
        >
          {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
        <a
          href="/logout"
          aria-label="Sign out"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
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
  onSaveTitle,
  onRegenerateTitle,
  onTitleError,
}: {
  sessions?: Session[];
  loading?: boolean;
  selectedSessionId?: string;
  onOpenSession: (session: Session) => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
  onSaveTitle?: (sessionId: string, title: string, revision?: number) => Promise<void>;
  onRegenerateTitle?: (sessionId: string) => Promise<string>;
  onTitleError?: (message: string) => void;
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
          onSaveTitle={onSaveTitle ? (_session, title) => onSaveTitle(session.id, title, session.revision) : undefined}
          onRegenerateTitle={onRegenerateTitle ? () => onRegenerateTitle(session.id) : undefined}
          onTitleError={onTitleError}
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
        'group/row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-[color,background-color,scale] duration-100 active:scale-[0.98]',
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
  onSaveTitle,
  onRegenerateTitle,
  onTitleError,
}: {
  session: Session;
  active: boolean;
  attention: Attention;
  onOpen: (session: Session) => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
  onSaveTitle?: (sessionId: string, title: string, revision?: number) => Promise<void>;
  onRegenerateTitle?: (sessionId: string) => Promise<string>;
  onTitleError?: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const openTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(openTimerRef.current), []);
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
    <div data-session-row={session.id} className={cn('group/row relative flex w-full min-w-0 items-center rounded-md transition-[color,background-color,scale] duration-100 active:scale-[0.98]', active ? 'bg-accent' : 'hover:bg-accent')}>
      <span className="ml-2 mt-[3px] flex size-3.5 shrink-0 items-center justify-center">
        {working ? <DotsRing className="size-3.5 text-foreground" aria-hidden="true" /> : <span aria-hidden="true" className={cn('size-1.5 rounded-full', needsAttention ? 'bg-amber-500' : 'bg-muted-foreground/50')} />}
      </span>
      {editing && onSaveTitle && onRegenerateTitle ? (
        <div className="min-w-0 flex-1 px-1 py-1">
          <InlineTitleEditor
            initialValue={session.title || ''}
            onSave={async (title) => { await onSaveTitle(session.id, title, session.revision); setEditing(false); }}
            onRegenerate={() => onRegenerateTitle(session.id)}
            onCancel={() => setEditing(false)}
            onError={onTitleError}
          />
          <span className={cn('block truncate text-[11px] tabular-nums', needsAttention ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{meta}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={(event) => {
            if (event.detail > 1) return;
            window.clearTimeout(openTimerRef.current);
            openTimerRef.current = window.setTimeout(() => onOpen(session), 220);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            window.clearTimeout(openTimerRef.current);
            if (!onSaveTitle || !onRegenerateTitle) return;
            onOpen(session);
            setEditing(true);
          }}
          onContextMenu={(event) => onContextMenu?.(event, session)}
          title="Double-click to rename"
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-md py-1.5 pr-7 pl-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]">{session.title || 'Conversation'}</span>
            <span className={cn('block truncate text-[11px] tabular-nums', needsAttention ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{meta}</span>
          </span>
        </button>
      )}
      {!editing && <button
        type="button"
        aria-label={`Actions for ${session.title || 'conversation'}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenuAt?.(Math.max(8, rect.right - 216), rect.bottom + 4, session);
        }}
        className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-foreground-soft opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:bg-accent focus-visible:opacity-100 coarse:opacity-100"
      >
        <IconDots size={15} />
      </button>}
    </div>
  );
}
