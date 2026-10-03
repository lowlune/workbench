import {
  ChatCenteredText,
  ClockCounterClockwise,
  ClipboardText,
  Cpu,
  FolderSimple,
  House,
  Moon,
  Plus,
  SignOut,
  Sun,
} from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import type { Agent, Overview, Session } from '@/lib/types';
import { cn, isHomeDirectory, plainPreview, shortDirectory, timeAgo } from '@/lib/utils';

export type AppView = 'home' | 'history' | 'clips' | 'chat';

interface AppSidebarProps {
  view: AppView;
  overview?: Overview;
  selectedSessionId?: string;
  projectFilter?: string | null;
  onNavigate: (view: Exclude<AppView, 'chat'>, directory?: string) => void;
  onOpenSession: (session: Session, agent?: Agent) => void;
  onNewTask: () => void;
  onClose?: () => void;
  theme: 'light' | 'dark';
  shortcutLabel: string;
  onToggleTheme: () => void;
}

const navigation = [
  { id: 'home', label: 'Home', Icon: House },
  { id: 'history', label: 'History', Icon: ClockCounterClockwise },
  { id: 'clips', label: 'Clipboard', Icon: ClipboardText },
] as const;

export function AppSidebar({
  view,
  overview,
  selectedSessionId,
  projectFilter,
  onNavigate,
  onOpenSession,
  onNewTask,
  onClose,
  theme,
  shortcutLabel,
  onToggleTheme,
}: AppSidebarProps) {
  const liveBySession = new Map((overview?.agents || []).filter((agent) => agent.sessionId).map((agent) => [agent.sessionId!, agent]));
  const recent = overview?.sessions?.slice(0, 12) || [];
  const directories = (overview?.directories || []).filter((directory) => !isHomeDirectory(directory.directory));

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar px-3 py-4 text-foreground">
      <div className="flex h-10 items-center px-1">
        <button type="button" className="flex items-center gap-2.5 rounded-md text-left" onClick={() => { onNavigate('home'); onClose?.(); }} aria-label="Workbench home">
          <span aria-hidden="true" className="grid size-8 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">W</span>
          <span className="text-sm font-semibold tracking-tight">Workbench</span>
        </button>
      </div>

      <Button onClick={() => { onNewTask(); onClose?.(); }} className="mt-5 w-full justify-start shadow-sm">
        <Plus aria-hidden="true" weight="bold" />
        New task
        <span className="ml-auto hidden text-[10px] font-normal text-primary-foreground/65 sm:inline">{shortcutLabel}</span>
      </Button>

      <nav className="mt-5 grid gap-1" aria-label="Main navigation">
        {navigation.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => { onNavigate(id); onClose?.(); }}
            aria-current={view === id ? 'page' : undefined}
            className={cn('flex h-10 items-center gap-3 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', view === id && 'bg-accent font-medium text-foreground')}
          >
            <Icon aria-hidden="true" size={18} weight={view === id ? 'fill' : 'regular'} />
            {label}
            {id === 'home' && Boolean(overview?.agents?.some((agent) => ['working', 'blocked'].includes(agent.status))) && (
              <span className="ml-auto size-2 rounded-full bg-success" aria-label="Agents active" />
            )}
          </button>
        ))}
      </nav>

      {directories.length > 0 && (
        <section className="mt-7" aria-labelledby="projects-heading">
          <h2 id="projects-heading" className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[.11em] text-muted-foreground">Projects</h2>
          <div className="grid gap-0.5">
            {directories.slice(0, 8).map((directory) => (
              <button
                key={directory.directory}
                type="button"
                onClick={() => { onNavigate('history', directory.directory); onClose?.(); }}
                aria-current={projectFilter === directory.directory ? 'true' : undefined}
                className={cn('flex h-8 min-w-0 items-center gap-2.5 rounded-md px-3 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground', projectFilter === directory.directory && 'bg-accent text-foreground')}
              >
                <FolderSimple aria-hidden="true" size={15} />
                <span className="truncate">{directory.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mt-7 flex min-h-0 flex-1 flex-col" aria-labelledby="recent-heading">
        <div className="mb-2 flex items-center justify-between px-3">
          <h2 id="recent-heading" className="text-[11px] font-semibold uppercase tracking-[.11em] text-muted-foreground">Recent chats</h2>
          <span className="text-[11px] tabular-nums text-muted-foreground" aria-label={`${recent.length} recent chats`}>{recent.length || ''}</span>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
          {recent.map((session) => {
            const agent = liveBySession.get(session.id);
            return (
              <button
                key={session.id}
                type="button"
                data-session-id={session.id}
                onClick={() => { onOpenSession(session, agent); onClose?.(); }}
                aria-current={selectedSessionId === session.id ? 'page' : undefined}
                className={cn('group flex w-full min-w-0 items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent', selectedSessionId === session.id && 'bg-accent')}
              >
                <ChatCenteredText aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{session.title || 'Untitled task'}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    {agent && <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', agent.status === 'working' ? 'bg-success' : agent.status === 'blocked' ? 'bg-warning' : 'bg-muted-foreground/60')} />}
                    <span className="truncate">{plainPreview(session.preview) || shortDirectory(session.directory)}</span>
                    <span className="ml-auto shrink-0">{timeAgo(session.updated)}</span>
                  </span>
                </span>
              </button>
            );
          })}
          {!recent.length && <p className="px-3 py-2 text-xs text-muted-foreground">Your conversations will show up here.</p>}
        </div>
      </section>

      <div className="mt-3 flex items-center justify-between gap-1 border-t border-border px-1 pt-3 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate" role="status" aria-live="polite">
          <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
          <span className="truncate">{overview ? 'VPS connected' : 'Connecting…'}</span>
          <Cpu aria-hidden="true" size={14} className="shrink-0" />
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? <Sun aria-hidden="true" size={16} /> : <Moon aria-hidden="true" size={16} />}
        </Button>
        <a className="rounded-md p-1.5 hover:bg-accent hover:text-foreground" href="/logout" aria-label="Sign out" title="Sign out">
          <SignOut aria-hidden="true" size={16} />
        </a>
      </div>
    </div>
  );
}
