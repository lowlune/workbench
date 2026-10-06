import type { MouseEvent as ReactMouseEvent } from 'react';
import { IconDots, IconPinFilled } from '@tabler/icons-react';
import type { Session } from '@/lib/types';
import { cn, timeAgo } from '@/lib/utils';

/* Whirl's sidebar row: a fixed-height line with the title, the age, a pin
   glyph, and a hover ⋯ that opens the same menu as a right-click. */
export function ChatRow({
  session,
  active,
  onOpen,
  onContextMenu,
  onMenuAt,
}: {
  session: Session;
  active?: boolean;
  onOpen: (session: Session) => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
}) {
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={() => onOpen(session)}
        onContextMenu={(event) => onContextMenu?.(event, session)}
        className={cn(
          'flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg pr-8 pl-2.5 text-left text-[13.5px]/4 font-medium transition-colors duration-100',
          active ? 'bg-accent text-foreground' : 'text-foreground-soft hover:bg-accent hover:text-foreground',
        )}
      >
        {session.pinned && <IconPinFilled size={11} className="shrink-0 rotate-45 text-muted-foreground" aria-label="Pinned" />}
        <span className="min-w-0 flex-1 truncate">{session.title || 'Untitled session'}</span>
        <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{session.updated ? timeAgo(session.updated) : ''}</span>
        {session.live && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-foreground/60" />}
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
