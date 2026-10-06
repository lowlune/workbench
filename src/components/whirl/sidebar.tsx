import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  IconChartBar,
  IconClipboardText,
  IconClock,
  IconHome,
  IconLayoutSidebarRight,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSun,
} from '@tabler/icons-react';
import { ChatRow } from '@/components/whirl/chat-row';
import type { Agent, Overview, Session, SystemSnapshot } from '@/lib/types';
import { cn, shortDirectory } from '@/lib/utils';

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
  shortcutLabel,
  onNavigate,
  onOpenSession,
  onOpenAgent,
  onNewTask,
  onSearch,
  onOpenSystem,
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
  shortcutLabel: string;
  onNavigate: (view: Exclude<AppView, 'chat'>) => void;
  onOpenSession: (session: Session) => void;
  onOpenAgent: (agent: Agent) => void;
  onNewTask: () => void;
  onSearch: () => void;
  onOpenSystem: () => void;
  onToggleTheme: () => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
}) {
  const agents = (overview?.agents || []).filter((agent) => agent.status !== 'unknown');
  const sessions = overview?.sessions || [];

  return (
    <aside className="hidden h-full w-[17rem] shrink-0 flex-col gap-2 px-3 pt-3 pb-2 md:flex" aria-label="Workspace navigation">
      <div className="flex h-7 items-center px-1.5">
        <span className="text-[13px] font-semibold tracking-tight">Workbench</span>
        <button
          type="button"
          onClick={onOpenSystem}
          aria-expanded={systemOpen}
          title="System performance"
          className="ml-auto inline-flex cursor-pointer items-center rounded-full px-1.5 py-1 text-[10px] whitespace-nowrap tabular-nums text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          {system?.cpu
            ? `CPU ${system.cpu.percent}% · RAM ${system.memoryPercent ?? 0}% · DISK ${system.disk?.percent ?? 0}%`
            : 'System…'}
        </button>
      </div>

      <button
        type="button"
        onClick={onNewTask}
        className="flex h-8 w-full cursor-pointer items-center justify-start gap-2 rounded-lg px-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-accent"
      >
        <IconPlus size={16} stroke={2.4} />
        New task
        <kbd className="ml-auto hidden text-[10px] font-normal text-muted-foreground lg:inline">{shortcutLabel}</kbd>
      </button>

      <nav className="-mt-1.5 flex flex-col gap-0.5">
        <SidebarRow Icon={IconHome} label="Home" active={view === 'home'} onClick={() => onNavigate('home')} />
        <SidebarRow Icon={IconSearch} label="Search" hint="⌘K" onClick={onSearch} />
        <SidebarRow Icon={IconClock} label="History" active={view === 'history'} onClick={() => onNavigate('history')} />
        <SidebarRow Icon={IconClipboardText} label="Clipboard" active={view === 'clips'} onClick={() => onNavigate('clips')} />
        <SidebarRow Icon={IconChartBar} label="Usage & models" active={view === 'usage'} onClick={() => onNavigate('usage')} />
      </nav>

      <div role="separator" className="mx-1.5 h-px shrink-0 bg-border" />

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {agents.length > 0 && (
          <section className="flex flex-col gap-0.5">
            <SectionLabel>Live</SectionLabel>
            {agents.map((agent) => (
              <AgentRow
                key={agent.paneId}
                agent={agent}
                active={Boolean(agent.sessionId && agent.sessionId === selectedSessionId)}
                onOpenAgent={onOpenAgent}
              />
            ))}
          </section>
        )}
        {sessions.length === 0 ? (
          <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No conversations yet.</p>
        ) : (
          groupSessions(sessions.slice(0, 40)).map(([label, items]) => (
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
        )}
      </div>

      <footer className="mt-auto flex items-center gap-1 border-t border-border px-1 pt-2">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="grid size-7 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
        <a
          href="/logout"
          aria-label="Sign out"
          className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <IconLogout size={15} />
        </a>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <IconLayoutSidebarRight size={12} />
          {agents.length} live
        </span>
      </footer>
    </aside>
  );
}

/* Whirl's date markers: quiet labels above each run of rows. */
function SectionLabel({ children }: { children: string }) {
  return <div className="flex h-5 items-center px-2.5 text-[10.5px]/4 font-medium text-muted-foreground/55">{children}</div>;
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
        'group/row flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] transition-colors duration-100',
        active ? 'bg-accent font-medium text-foreground' : 'text-foreground-soft hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="truncate">{label}</span>
      {hint && <kbd className="ml-auto text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100">{hint}</kbd>}
    </button>
  );
}

function AgentRow({ agent, active, onOpenAgent }: { agent: Agent; active: boolean; onOpenAgent: (agent: Agent) => void }) {
  const working = agent.status === 'working';
  const blocked = agent.status === 'blocked';
  return (
    <div className={cn(
      'relative flex w-full min-w-0 items-center rounded-lg transition-colors duration-100',
      active ? 'bg-accent' : 'hover:bg-accent',
    )}>
      <button
        type="button"
        onClick={() => onOpenAgent(agent)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg py-1.5 pr-2 pl-2 text-left"
      >
        <span aria-hidden="true" className={cn(
          'size-1.5 shrink-0 rounded-full',
          working ? 'animate-pulse bg-foreground' : blocked ? 'bg-destructive' : 'bg-muted-foreground/50',
        )} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{agent.sessionTitle || agent.title || agent.agent}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {agent.agent}
            {agent.cwd ? ` · ${shortDirectory(agent.cwd)}` : ''}
          </span>
        </span>
      </button>
    </div>
  );
}
