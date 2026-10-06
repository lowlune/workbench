import { useEffect, useMemo, useRef, useState } from 'react';
import { IconClipboardText, IconClock, IconHome, IconPlus, IconSearch } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { AppView } from '@/components/whirl/sidebar';
import type { Overview, Session } from '@/lib/types';
import { cn, shortDirectory } from '@/lib/utils';

type Item =
  | { kind: 'action'; id: string; label: string; hint?: string; Icon: typeof IconHome; run: () => void }
  | { kind: 'session'; session: Session };

export function SearchPalette({
  open,
  onOpenChange,
  overview,
  onNavigate,
  onNewTask,
  onOpenSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overview?: Overview;
  onNavigate: (view: Exclude<AppView, 'chat'>) => void;
  onNewTask: () => void;
  onOpenSession: (session: Session) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const needle = query.trim().toLowerCase();
    const actions = ([
      { kind: 'action', id: 'home', label: 'Go home', Icon: IconHome, run: () => onNavigate('home') },
      { kind: 'action', id: 'history', label: 'Open history', Icon: IconClock, run: () => onNavigate('history') },
      { kind: 'action', id: 'clips', label: 'Open clipboard', Icon: IconClipboardText, run: () => onNavigate('clips') },
      { kind: 'action', id: 'new', label: 'Start a new task', hint: '⌘⇧N', Icon: IconPlus, run: onNewTask },
    ] satisfies Item[]).filter((item) => !needle || item.label.toLowerCase().includes(needle));
    const sessions: Item[] = (overview?.sessions || [])
      .filter((session) => !needle
        || (session.title || '').toLowerCase().includes(needle)
        || (session.directory || '').toLowerCase().includes(needle)
        || (session.tags || []).some((tag) => tag.toLowerCase().includes(needle)))
      .slice(0, 8)
      .map((session) => ({ kind: 'session' as const, session }));
    return [...actions, ...sessions];
  }, [query, overview, onNavigate, onNewTask]);

  useEffect(() => { setActive(0); }, [query]);

  function choose(item: Item) {
    onOpenChange(false);
    if (item.kind === 'action') item.run();
    else onOpenSession(item.session);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] max-w-lg gap-0 rounded-2xl p-0" backdropClassName="backdrop-blur-xs">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search conversations and jump between views.</DialogDescription>
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <IconSearch size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => Math.min(items.length - 1, current + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => Math.max(0, current - 1));
              } else if (event.key === 'Enter' && items[active]) {
                event.preventDefault();
                choose(items[active]);
              }
            }}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="wb-scroll max-h-[50vh] overflow-y-auto p-1.5">
          {items.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">Nothing matches.</p>}
          {items.map((item, index) => {
            const key = item.kind === 'action' ? `action-${item.id}` : `session-${item.session.id}`;
            const isActive = index === active;
            return (
              <button
                key={key}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item)}
                className={cn(
                  'flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-75',
                  isActive ? 'bg-accent' : 'hover:bg-accent',
                )}
              >
                {item.kind === 'action'
                  ? <item.Icon size={15} className="shrink-0 text-muted-foreground" />
                  : <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">
                    {item.kind === 'action' ? item.label : (item.session.title || 'Untitled session')}
                  </span>
                  {item.kind === 'session' && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {[shortDirectory(item.session.directory), ...(item.session.tags || []).slice(0, 3)].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                {item.kind === 'action' && item.hint && <kbd className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</kbd>}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
