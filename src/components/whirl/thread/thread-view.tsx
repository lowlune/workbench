import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { IconArrowDown, IconLoader2 } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ToolActivity } from '@/components/whirl/thread/activity';
import { AssistantMessage } from '@/components/whirl/thread/assistant-message';
import { UserMessage } from '@/components/whirl/thread/user-message';
import { isActivity } from '@/lib/format';
import type { Message } from '@/lib/types';

type Row = { kind: 'message'; message: Message } | { kind: 'activity'; messages: Message[]; key: string };

/* The transcript: scrolls at the live edge while the agent writes and stays
   wherever the reader left it otherwise. Opens with real bottom padding so
   the floating composer never covers the last turn. */
export function ThreadView({
  messages,
  isWorking,
  hasMore = false,
  onLoadOlder,
  viewportRef: externalViewportRef,
}: {
  /** `undefined` while the thread loads — draws the spinner. */
  messages: Message[] | undefined;
  isWorking: boolean;
  hasMore?: boolean;
  onLoadOlder?: () => void;
  /** Lets the parent own the scroller (scroll preservation when older
   *  messages are prepended). */
  viewportRef?: RefObject<HTMLDivElement | null>;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const viewportRef = externalViewportRef ?? internalRef;
  const atBottomRef = useRef(true);
  const lastRevisionRef = useRef('');
  const [showJump, setShowJump] = useState(false);

  const rows = useMemo(() => {
    const output: Row[] = [];
    const list = messages || [];
    for (let index = 0; index < list.length;) {
      const message = list[index];
      if (!isActivity(message)) {
        output.push({ kind: 'message', message });
        index += 1;
        continue;
      }
      const group: Message[] = [];
      while (index < list.length && isActivity(list[index])) group.push(list[index++]);
      output.push({ kind: 'activity', messages: group, key: group[0].id });
    }
    return output;
  }, [messages]);

  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => viewportRef.current,
    estimateSize: () => 180, overscan: 8, enabled: rows.length > 80,
    getItemKey: index => rows[index].kind === 'message' ? rows[index].message.id : rows[index].key });
  function renderRow(row: Row) {
    return row.kind === 'message' ? row.message.info.role === 'user'
      ? <UserMessage message={row.message} /> : <AssistantMessage message={row.message} isWorking={isWorking && row === rows.at(-1)} />
      : <ToolActivity tools={row.messages.flatMap(message => message.parts.filter(part => part.type === 'tool'))} running={isWorking && row === rows.at(-1)} />;
  }

  useEffect(() => {
    const list = messages || [];
    const last = list.at(-1);
    const revision = `${list.length}:${last?.id || ''}:${last?.revision || 0}:${last?.parts.map((part) => `${part.text?.length || 0}:${part.state?.status || ''}`).join(',') || ''}`;
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
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          atBottomRef.current = nearBottom;
          if (nearBottom) setShowJump(false);
          if (nearBottom) return;
          if (element.scrollTop <= 56 && hasMore && onLoadOlder) onLoadOlder();
        }}
      >
        <div className="mx-auto w-full max-w-3xl px-3 pt-5 pb-6 md:px-6">
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
              {virtual.getVirtualItems().map(item => <div key={item.key} data-index={item.index} ref={virtual.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }} className="pb-7">{renderRow(rows[item.index])}</div>)}
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {rows.map((row) => row.kind === 'message'
                ? (
                  row.message.info.role === 'user'
                    ? <UserMessage key={row.message.id} message={row.message} />
                    : <AssistantMessage key={row.message.id} message={row.message} isWorking={isWorking && row === rows.at(-1)} />
                )
                : (
                  <div key={row.key} className="w-full min-w-0">
                    <ToolActivity
                      tools={row.messages.flatMap((message) => message.parts.filter((part) => part.type === 'tool'))}
                      running={isWorking && row === rows.at(-1)}
                    />
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
          className="raised absolute bottom-36 left-1/2 z-10 grid size-9 -translate-x-1/2 cursor-pointer place-items-center rounded-full bg-popover text-foreground ring-1 ring-border transition-[scale,background-color] duration-150 hover:bg-accent active:scale-[0.94]"
        >
          <IconArrowDown size={17} />
        </button>
      )}
    </div>
  );
}
