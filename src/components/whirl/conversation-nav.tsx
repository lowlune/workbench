import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Message } from '@/lib/types';
import { cn } from '@/lib/utils';

function previewOf(message: Message) {
  const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join(' ').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  const files = message.parts.filter((part) => part.type === 'file').length;
  return files ? `${files} attachment${files === 1 ? '' : 's'}` : 'Message';
}

/** Thin rail of user prompts on the left of the thread: small ticks mark each
 *  prompt, hovering shows a short preview, clicking jumps to that message. */
export function ConversationNav({ messages, prompts: providedPrompts, viewportRef, onJump }: {
  messages?: Message[];
  prompts?: { id: string; preview: string }[];
  viewportRef: RefObject<HTMLDivElement | null>;
  onJump: (messageId: string) => void;
}) {
  const prompts = useMemo(
    () => providedPrompts?.length
      ? providedPrompts
      : (messages || [])
        .filter((message) => message.info.role === 'user')
        .map((message) => ({ id: message.id, preview: previewOf(message) })),
    [messages, providedPrompts],
  );
  const [active, setActive] = useState(0);
  const frameRef = useRef(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      frameRef.current = 0;
      const scrollable = viewport.scrollHeight - viewport.clientHeight;
      const ratio = scrollable > 0 ? viewport.scrollTop / scrollable : 0;
      const count = prompts.length;
      setActive(count <= 1 ? 0 : Math.round(ratio * (count - 1)));
    };
    const onScroll = () => {
      if (frameRef.current) return;
      frameRef.current = window.requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    };
  }, [viewportRef, prompts.length]);

  if (prompts.length < 2) return null;

  function jump(id: string) {
    onJump(id);
    const viewport = viewportRef.current;
    const target = viewport?.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  return (
    <nav
      aria-label="Jump to a prompt"
      className="pointer-events-none absolute top-1/2 left-0 z-10 hidden -translate-y-1/2 md:flex"
    >
      <div className="pointer-events-auto flex flex-col gap-0.5 pl-1">
        {prompts.map((prompt, index) => (
          <button
            key={prompt.id}
            type="button"
            onClick={() => jump(prompt.id)}
            aria-label={`Jump to prompt ${index + 1}`}
            aria-current={index === active ? 'true' : undefined}
            className="group/nav relative flex h-2 w-4 cursor-pointer items-center"
          >
            <span
              className={cn(
                'block h-0.5 rounded-full transition-all duration-200 ease-out',
                index === active ? 'w-4 bg-foreground' : 'w-2.5 bg-muted-foreground/40 group-hover/nav:w-4 group-hover/nav:bg-muted-foreground',
              )}
            />
            <span className="raised pointer-events-none absolute top-1/2 left-full ml-2 hidden max-w-xs -translate-y-1/2 truncate rounded-md bg-popover px-2 py-1 text-[11px] text-popover-foreground ring-1 ring-border group-hover/nav:block">
              {prompt.preview}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
