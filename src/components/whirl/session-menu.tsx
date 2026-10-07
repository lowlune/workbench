import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  IconArchive,
  IconArchiveOff,
  IconArrowUpRight,
  IconAdjustmentsHorizontal,
  IconBook,
  IconCopy,
  IconFileDiff,
  IconFolder,
  IconHash,
  IconPencil,
  IconPinFilled,
  IconPlayerStopFilled,
  IconSparklesFilled,
  IconTrash,
} from '@tabler/icons-react';
import type { Session } from '@/lib/types';

/* Conversation row menu — mirrored from Whirl's row actions where Workbench
   has the backend for them: pin, rename, reset title, stop, copy fields,
   archive/unarchive, delete. One instance lives at the app root; every list
   feeds it through the returned handlers (right-click or the hover ⋯). */
export function useSessionMenu({
  onOpen,
  onStop,
  onRename,
  onRegenerate,
  onPin,
  onArchive,
  onUnarchive,
  onDelete,
  onToast,
  onViewChanges,
  onOpenAgentsMd,
  onOpenSettings,
}: {
  onOpen: (session: Session) => void;
  onStop: (session: Session) => void;
  onRename: (session: Session) => void;
  onRegenerate: (session: Session) => void;
  onPin: (session: Session) => void;
  onArchive: (session: Session) => void;
  onUnarchive: (session: Session) => void;
  onDelete: (session: Session) => void;
  onToast: (message: string, isError?: boolean) => void;
  /* Optional Fáza 2 entries (§12/§29/§11); absent on older call sites. */
  onViewChanges?: (session: Session) => void;
  onOpenAgentsMd?: (session: Session) => void;
  onOpenSettings?: (session: Session) => void;
}) {
  const [state, setState] = useState<{ session: Session; x: number; y: number } | null>(null);
  /* The clicked row is lifted above the blurred backdrop so it stays crisp
     while the menu is open. */
  const elevatedRef = useRef<HTMLElement | null>(null);
  const resetElevated = () => {
    const el = elevatedRef.current;
    if (el) { el.style.position = ''; el.style.zIndex = ''; }
    elevatedRef.current = null;
  };
  const elevate = (el: HTMLElement | null) => {
    resetElevated();
    if (!el) return;
    el.style.position = 'relative';
    el.style.zIndex = '130';
    elevatedRef.current = el;
  };
  useEffect(() => () => resetElevated(), []);

  useEffect(() => {
    if (!state) return;
    const close = () => { resetElevated(); setState(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [state]);

  function openSessionMenuAt(x: number, y: number, session: Session, rowEl?: HTMLElement | null) {
    const el = rowEl || (document.elementFromPoint(x, y)?.closest('[data-session-row]') as HTMLElement | null);
    setState({
      session,
      x: Math.max(8, Math.min(x, window.innerWidth - 240)),
      y: Math.max(8, Math.min(y, window.innerHeight - 320)),
    });
    elevate(el || null);
  }

  function openSessionMenu(event: ReactMouseEvent, session: Session) {
    event.preventDefault();
    event.stopPropagation();
    const rowEl = (event.currentTarget as HTMLElement).closest('[data-session-row]') as HTMLElement | null;
    openSessionMenuAt(event.clientX, event.clientY, session, rowEl);
  }

  function run(action: () => void) {
    resetElevated();
    setState(null);
    action();
  }

  function copy(label: string, value?: string | null) {
    if (!value) {
      onToast('Nothing to copy.', true);
      return;
    }
    navigator.clipboard.writeText(value)
      .then(() => onToast(`${label} copied`))
      .catch(() => onToast('Could not copy.', true));
  }

  const session = state?.session;
  const working = Boolean(session && (session.live || session.status === 'working' || session.resumeStatus === 'working'));
  const worktreeId = (session?.activeRun as { worktreeId?: string | null } | null | undefined)?.worktreeId;
  const canViewChanges = Boolean(session?.activeRun?.id || worktreeId);

  const element = state && session ? (
    <>
      <div
        aria-hidden="true"
        onPointerDown={(event) => { event.stopPropagation(); resetElevated(); setState(null); }}
        onContextMenu={(event) => event.preventDefault()}
        className="fixed inset-0 z-[129] bg-background/25 backdrop-blur-sm animate-in fade-in duration-150"
      />
      <div
        role="menu"
        aria-label="Conversation actions"
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        style={{ left: state.x, top: state.y }}
        className="raised fixed z-[131] w-56 rounded-xl bg-popover p-1 text-[13px] ring-1 ring-border animate-in fade-in zoom-in-95 duration-150"
      >
      <MenuItem onClick={() => run(() => onPin(session))} icon={<IconPinFilled size={15} />}>
        {session.pinned ? 'Unpin' : 'Pin'}
      </MenuItem>
      <MenuItem onClick={() => run(() => onRename(session))} icon={<IconPencil size={15} />}>Rename…</MenuItem>
      <MenuItem onClick={() => run(() => onRegenerate(session))} icon={<IconSparklesFilled size={15} />}>
        Regenerate title
      </MenuItem>
      <Divider />
      <MenuItem onClick={() => run(() => onOpen(session))} icon={<IconArrowUpRight size={15} />}>Open</MenuItem>
      {working && (
        <MenuItem onClick={() => run(() => onStop(session))} icon={<IconPlayerStopFilled size={14} />} danger>Stop</MenuItem>
      )}
      {onViewChanges && canViewChanges && (
        <MenuItem onClick={() => run(() => onViewChanges(session))} icon={<IconFileDiff size={15} />}>View changes</MenuItem>
      )}
      {onOpenAgentsMd && (
        <MenuItem onClick={() => run(() => onOpenAgentsMd(session))} icon={<IconBook size={15} />}>AGENTS.md…</MenuItem>
      )}
      {onOpenSettings && (
        <MenuItem onClick={() => run(() => onOpenSettings(session))} icon={<IconAdjustmentsHorizontal size={15} />}>Concurrency & queue…</MenuItem>
      )}
      <Divider />
      <MenuItem onClick={() => copy('Title', session.title)} icon={<IconCopy size={15} />}>Copy title</MenuItem>
      <MenuItem onClick={() => copy('Session ID', session.id)} icon={<IconHash size={15} />}>Copy session ID</MenuItem>
      <MenuItem onClick={() => copy('Path', session.directory)} icon={<IconFolder size={15} />}>Copy project path</MenuItem>
      <Divider />
      {session.hidden ? (
        <MenuItem onClick={() => run(() => onUnarchive(session))} icon={<IconArchiveOff size={15} />}>Unarchive</MenuItem>
      ) : (
        <MenuItem onClick={() => run(() => onArchive(session))} icon={<IconArchive size={15} />}>Archive</MenuItem>
      )}
      <MenuItem onClick={() => run(() => onDelete(session))} icon={<IconTrash size={15} />} danger>Delete…</MenuItem>
      </div>
    </>
  ) : null;

  return { openSessionMenu, openSessionMenuAt, sessionMenuElement: element };
}

function Divider() {
  return <div className="mx-2 my-1 h-px bg-border" />;
}

function MenuItem({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-75 hover:bg-accent ${danger ? 'text-destructive hover:bg-destructive/10' : ''}`}
    >
      <span className={danger ? '' : 'text-muted-foreground'}>{icon}</span>
      {children}
    </button>
  );
}
