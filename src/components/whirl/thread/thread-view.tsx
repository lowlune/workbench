import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { IconArrowDown, IconLoader2 } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AssistantMessage } from '@/components/whirl/thread/assistant-message';
import { UserMessage } from '@/components/whirl/thread/user-message';
import { cn } from '@/lib/utils';
import type { FileRef } from '@/components/whirl/file-viewer';
import type { Message } from '@/lib/types';

function isEmptyAssistant(message: Message) {
  return message.info.role === 'assistant'
    && !(message.parts || []).some((part) => (part.type === 'text' && String(part.text || '').trim())
      || ['tool', 'file', 'reasoning', 'step-start', 'step-finish'].includes(part.type));
}

/* The transcript: scrolls at the live edge while the agent writes and stays
   wherever the reader left it otherwise. Opens with real bottom padding so
   the floating composer never covers the last turn. */
export function ThreadView({
  messages,
  isWorking,
  hasMore = false,
  onLoadOlder,
  viewportRef: externalViewportRef,
  onOpenFile,
  hiddenCommandIds,
}: {
  /** `undefined` while the thread loads — draws the spinner. */
  messages: Message[] | undefined;
  isWorking: boolean;
  hasMore?: boolean;
  onLoadOlder?: () => void;
  /** Lets the parent own the scroller (scroll preservation when older
   *  messages are prepended). */
  viewportRef?: RefObject<HTMLDivElement | null>;
  onOpenFile?: (file: FileRef) => void;
  /** Command ids that are still queued; their user message is hidden from the
   *  transcript until the run actually starts. */
  hiddenCommandIds?: Set<string>;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const viewportRef = externalViewportRef ?? internalRef;
  const atBottomRef = useRef(true);
  const lastRevisionRef = useRef('');
  const [showJump, setShowJump] = useState(false);
  const [atTop, setAtTop] = useState(true);

  const rows = useMemo(() => {
    /* Guard against malformed cached entries: a message without `info` (or a
       non-array `parts`) from a partial SSE patch must never take the whole
       transcript down when a tab is switched in. */
    // Keep model steps separate so a long run remains virtualizable.
    return (messages || []).filter((message) => Boolean(message?.info) && Array.isArray(message.parts) && !isEmptyAssistant(message) && !(message.commandId && hiddenCommandIds?.has(message.commandId)));
  }, [messages, hiddenCommandIds]);

  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => viewportRef.current,
    estimateSize: () => 180, overscan: 8, enabled: rows.length > 80,
    /* The virtualizer can ask for an index from the previous (longer) list for
       one frame after a tab switch; stay in bounds instead of throwing. */
    getItemKey: (index) => rows[index]?.id ?? index });
  function renderRow(message: Message) {
    return (
      <div data-message-id={message.id}>
        {message.info.role === 'user'
          ? <UserMessage message={message} />
          : <AssistantMessage message={message} isWorking={isWorking && message === rows.at(-1)} onOpenFile={onOpenFile} />}
      </div>
    );
  }

  useEffect(() => {
    const list = messages || [];
    const last = list.at(-1);
    const revision = `${list.length}:${last?.id || ''}:${last?.revision || 0}:${(last?.parts || []).map((part) => `${part.text?.length || 0}:${part.state?.status || ''}`).join(',') || ''}`;
    if (revision === lastRevisionRef.current) return;
    lastRevisionRef.current = revision;
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (atBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [messages]);

  function jumpToLatest() {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJump(false);
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label="Conversation messages"
        className="wb-scroll h-full overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const element = event.currentTarget;
          setAtTop(element.scrollTop <= 2);
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          atBottomRef.current = nearBottom;
          if (nearBottom) setShowJump(false);
          if (nearBottom) return;
          if (element.scrollTop <= 56 && hasMore && onLoadOlder) onLoadOlder();
        }}
      >
        <div className="mx-auto w-full max-w-[52rem] px-3 pt-5 pb-[var(--dock-clearance,7rem)] md:px-6">
          {messages === undefined ? (
            <div className="flex h-[40vh] items-center justify-center">
              <IconLoader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-[40vh] flex-col items-center justify-center gap-2 text-center">
              <p className="text-[15px]/6 font-medium">Ready when you are.</p>
              <p className="max-w-sm text-[13px]/5 text-muted-foreground">Send a message below to continue this conversation.</p>
            </div>
          ) : rows.length > 80 ? (
            <div style={{ height: virtual.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtual.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    data-message-id={row.id}
                    ref={virtual.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                    className="pb-7"
                  >
                    {renderRow(row)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {rows.map((row) => <div key={row.id}>{renderRow(row)}</div>)}
            </div>
          )}
        </div>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-[5] h-6 bg-gradient-to-b from-surface to-transparent transition-opacity duration-200',
          atTop && 'opacity-0',
        )}
      />
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
          className="raised absolute bottom-36 left-1/2 z-10 grid size-9 -translate-x-1/2 cursor-pointer place-items-center rounded-full bg-popover text-foreground ring-1 ring-border transition-[scale,background-color] duration-150 hover:bg-accent active:scale-[0.96]"
        >
          <IconArrowDown size={17} />
        </button>
      )}
    </div>
  );
}
