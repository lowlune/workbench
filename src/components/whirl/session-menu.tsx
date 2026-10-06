import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  IconArrowUpRight,
  IconCopy,
  IconEyeOff,
  IconFolder,
  IconHash,
  IconPencil,
  IconPinFilled,
  IconPlayerStopFilled,
  IconSparklesFilled,
} from '@tabler/icons-react';
import type { Session } from '@/lib/types';

/* Conversation row menu — mirrored from Whirl's row actions where Workbench
   has the backend for them: pin, rename, reset title, stop, copy fields,
   hide. One instance lives at the app root; every list feeds it through the
   returned handlers (right-click or the hover ⋯). */
export function useSessionMenu({
  onOpen,
  onStop,
  onRename,
  onRegenerate,
  onPin,
  onHide,
  onToast,
}: {
  onOpen: (session: Session) => void;
  onStop: (session: Session) => void;
  onRename: (session: Session) => void;
  onRegenerate: (session: Session) => void;
  onPin: (session: Session) => void;
  onHide: (session: Session) => void;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const [state, setState] = useState<{ session: Session; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!state) return;
    const close = () => setState(null);
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

  function openSessionMenuAt(x: number, y: number, session: Session) {
    setState({
      session,
      x: Math.max(8, Math.min(x, window.innerWidth - 240)),
      y: Math.max(8, Math.min(y, window.innerHeight - 320)),
    });
  }

  function openSessionMenu(event: ReactMouseEvent, session: Session) {
    event.preventDefault();
    event.stopPropagation();
    openSessionMenuAt(event.clientX, event.clientY, session);
  }

  function run(action: () => void) {
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

  const element = state && session ? (
    <div
      role="menu"
      aria-label="Conversation actions"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: state.x, top: state.y }}
      className="raised fixed z-[130] w-56 rounded-xl bg-popover p-1 text-[13px] ring-1 ring-border"
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
      <Divider />
      <MenuItem onClick={() => copy('Title', session.title)} icon={<IconCopy size={15} />}>Copy title</MenuItem>
      <MenuItem onClick={() => copy('Session ID', session.id)} icon={<IconHash size={15} />}>Copy session ID</MenuItem>
      <MenuItem onClick={() => copy('Path', session.directory)} icon={<IconFolder size={15} />}>Copy project path</MenuItem>
      <Divider />
      <MenuItem onClick={() => run(() => onHide(session))} icon={<IconEyeOff size={15} />}>Hide chat</MenuItem>
    </div>
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
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-75 hover:bg-accent ${danger ? 'text-destructive hover:bg-destructive/10' : ''}`}
    >
      <span className={danger ? '' : 'text-muted-foreground'}>{icon}</span>
      {children}
    </button>
  );
}
