import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { IconDots, IconPinFilled, IconPlus, IconX } from '@tabler/icons-react';
import { DotsRing } from '@/components/loading-ui/dots-ring';
import { formatDuration } from '@/lib/format';
import { InlineTitleEditor } from '@/components/whirl/inline-title-editor';
import type { TabView } from '@/lib/tabs';
import { cn } from '@/lib/utils';

/* Classic horizontal tab strip across the top of the chat card: quiet pills,
   one line, title + status, close on hover, drag to reorder. */
export function HorizontalTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onReorder,
  onTogglePin,
  onNew,
  onCloseOthers,
  onCloseAll,
  onContextMenu,
  onSaveTitle,
  onRegenerateTitle,
  onTitleError,
}: {
  tabs: TabView[];
  activeId?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onTogglePin: (id: string) => void;
  onNew: () => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onContextMenu?: (event: ReactMouseEvent, id: string) => void;
  onSaveTitle?: (id: string, title: string, revision?: number) => Promise<void>;
  onRegenerateTitle?: (id: string) => Promise<string>;
  onTitleError?: (message: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const activateTimerRef = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((tab) => tab.id === activeId);

  useEffect(() => () => window.clearTimeout(activateTimerRef.current), []);

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(`workbench-tab-${activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!tabs.length) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const focusTab = (target: number) => {
      const next = tabs[(target + tabs.length) % tabs.length];
      if (!next) return;
      event.preventDefault();
      document.getElementById(`workbench-tab-${next.id}`)?.focus();
      onActivate(next.id);
    };
    if (event.key === 'ArrowRight') focusTab(index + 1);
    else if (event.key === 'ArrowLeft') focusTab(index - 1);
    else if (event.key === 'Home') focusTab(0);
    else if (event.key === 'End') focusTab(tabs.length - 1);
    else if ((event.key === 'Delete' || event.key === 'Backspace') && activeId) {
      event.preventDefault();
      onClose(activeId);
    }
  }

  function dragStart(event: ReactDragEvent<HTMLDivElement>, id: string) {
    setDragId(id);
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', id); } catch { /* Safari needs data; ignore failures. */ }
  }

  function dragOver(event: ReactDragEvent<HTMLDivElement>, id: string) {
    if (!dragId || dragId === id) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setDrop({ id, position: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after' });
  }

  function dropTab(event: ReactDragEvent<HTMLDivElement>, id: string) {
    event.preventDefault();
    const from = dragId;
    const position = drop?.position || 'before';
    setDragId(null);
    setDrop(null);
    if (!from || from === id) return;
    const ids = tabs.map((tab) => tab.id);
    const without = ids.filter((candidate) => candidate !== from);
    let insertAt = ids.indexOf(id) + (position === 'after' ? 1 : 0);
    if (ids.indexOf(from) < ids.indexOf(id)) insertAt -= 1;
    insertAt = Math.max(0, Math.min(without.length, insertAt));
    without.splice(insertAt, 0, from);
    onReorder(without);
  }

  function openMenuAt(x: number, y: number) {
    const left = Math.max(8, Math.min(x, window.innerWidth - 200));
    const top = Math.max(8, Math.min(y, window.innerHeight - 160));
    setMenu({ x: left, y: top, originX: x - left, originY: y - top });
  }

  return (
    <div className="relative flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-surface px-1.5">
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Open chats"
        onKeyDown={onKeyDown}
        onContextMenu={(event) => { event.preventDefault(); openMenuAt(event.clientX, event.clientY); }}
        className="wb-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const failed = tab.status === 'failed' || tab.status === 'uncertain' || tab.status === 'cancelled';
          const needsAttention = tab.attention !== 'none';
          const working = tab.running && !needsAttention && !failed;
          const label = tab.title || 'Conversation';
          const elapsed = tab.started ? formatDuration((Date.now() - tab.started) / 1000) : '';
          const hint = [
            label,
            tab.projectId && tab.projectId !== 'general' ? tab.projectId : null,
            needsAttention ? (tab.attention === 'permission' ? 'Permission required' : 'Waiting for input') : tab.running ? 'Working' : null,
            elapsed,
          ].filter(Boolean).join(' · ');
          return (
            <div
              key={tab.id}
              data-session-row={tab.id}
              draggable={editingId !== tab.id}
              onDragStart={(event) => dragStart(event, tab.id)}
              onDragOver={(event) => dragOver(event, tab.id)}
              onDrop={(event) => dropTab(event, tab.id)}
              onDragEnd={() => { setDragId(null); setDrop(null); }}
              onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, tab.id); }}
              className={cn(
                'group/tab relative flex shrink-0 items-center rounded-md transition-[color,background-color,scale] duration-100 active:scale-[0.98]',
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                dragId === tab.id && 'opacity-40',
                drop?.id === tab.id && (drop.position === 'before' ? 'shadow-[inset_2px_0_0_0_var(--primary)]' : 'shadow-[inset_-2px_0_0_0_var(--primary)]'),
              )}
            >
              {editingId === tab.id && onSaveTitle && onRegenerateTitle ? (
                <InlineTitleEditor
                  initialValue={label}
                  onSave={async (title) => { await onSaveTitle(tab.id, title, tab.revision); setEditingId(null); }}
                  onRegenerate={() => onRegenerateTitle(tab.id)}
                  onCancel={() => setEditingId(null)}
                  onError={onTitleError}
                  className="h-8 w-64 px-1"
                />
              ) : (
                <>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls="workbench-chat-panel"
                    tabIndex={active ? 0 : -1}
                    id={`workbench-tab-${tab.id}`}
                    title={`${hint}\nDouble-click to rename`}
                    onClick={(event) => {
                      if (event.detail > 1) return;
                      window.clearTimeout(activateTimerRef.current);
                      activateTimerRef.current = window.setTimeout(() => onActivate(tab.id), 220);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      window.clearTimeout(activateTimerRef.current);
                      if (!onSaveTitle || !onRegenerateTitle) return;
                      onActivate(tab.id);
                      setEditingId(tab.id);
                    }}
                    onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
                    className="flex max-w-[13rem] min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-6 pl-2.5 text-left"
                  >
                    <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center">
                      {working ? (
                        <DotsRing className="size-3 text-foreground" />
                      ) : (
                        <span className={cn('size-1.5 rounded-full', failed ? 'bg-destructive' : needsAttention ? 'bg-amber-500' : 'bg-muted-foreground/40')} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
                    {tab.pinned && <IconPinFilled size={10} className="shrink-0 rotate-45 text-muted-foreground" aria-label="Pinned" />}
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Close ${label}`}
                    onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
                    onPointerDown={(event) => event.stopPropagation()}
                    className="absolute top-1/2 right-0.5 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/tab:opacity-100 hover:bg-background/70 hover:text-foreground focus-visible:opacity-100 coarse:opacity-100"
                  >
                    <IconX size={11} stroke={2.4} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onNew}
        aria-label="New chat"
        title="New chat"
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
      >
        <IconPlus size={15} stroke={2.4} />
      </button>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openMenuAt(rect.right - 192, rect.bottom + 4);
        }}
        aria-label="Tab options"
        title="Tab options"
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
      >
        <IconDots size={15} />
      </button>

      {menu && (
        <>
          <div aria-hidden="true" className="fixed inset-0 z-[128]" onPointerDown={() => setMenu(null)} onContextMenu={(event) => event.preventDefault()} />
          <div
            role="menu"
            aria-label="Tab options"
            className="raised fixed z-[131] w-48 rounded-xl bg-popover p-1 text-[13px] ring-1 ring-border animate-in fade-in zoom-in-95 ease-out duration-150"
            style={{ left: menu.x, top: menu.y, transformOrigin: `${menu.originX}px ${menu.originY}px` }}
          >
            <TabMenuItem icon={<IconPlus size={15} />} onClick={() => { setMenu(null); onNew(); }}>New chat</TabMenuItem>
            {activeId && (
              <TabMenuItem icon={<IconPinFilled size={15} />} onClick={() => { setMenu(null); onTogglePin(activeId); }}>
                {activeTab?.pinned ? 'Unpin tab' : 'Pin tab'}
              </TabMenuItem>
            )}
            {activeId && (
              <TabMenuItem icon={<IconX size={15} />} onClick={() => { setMenu(null); onCloseOthers(activeId); }}>Close others</TabMenuItem>
            )}
            <TabMenuItem icon={<IconX size={15} />} danger onClick={() => { setMenu(null); onCloseAll(); }}>Close all</TabMenuItem>
          </div>
        </>
      )}
    </div>
  );
}

function TabMenuItem({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-75 hover:bg-accent active:bg-(--accent-pressed)',
        danger && 'text-destructive hover:bg-destructive/10',
      )}
    >
      <span className={danger ? '' : 'text-muted-foreground'}>{icon}</span>
      {children}
    </button>
  );
}
