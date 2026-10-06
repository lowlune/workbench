import { useEffect, useRef, useState } from 'react';
import { IconArrowUp, IconPlayerStopFilled, IconSparkles } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/whirl/markdown';
import { cn } from '@/lib/utils';

/* The read-only assistant: streams answers grounded in this session's
   transcript from /api/v2/assistant. Nothing it says can touch the
   workspace. */

const STARTERS = [
  'Summarise what changed in this conversation',
  'What should I review before shipping?',
  'Explain the last error in plain language',
];

interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface AssistantEvent {
  delta?: string;
  done?: boolean;
  error?: string;
}

let messageSequence = 0;
const nextMessageId = () => `assistant-${Date.now().toString(36)}-${messageSequence++}`;

export function AssistantPanel({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: string;
  sessionTitle?: string;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* A new session gets a clean slate — the old transcript's Q&A would lie. */
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setStreaming(false);
  }, [sessionId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  function markUnavailable(message: string) {
    onToast(message, true);
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: 'Assistant is unavailable.' };
      return next;
    });
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || streaming || !sessionId) return;
    setInput('');
    const userMessage: AssistantMessage = { id: nextMessageId(), role: 'user', content: question };
    const assistantMessage: AssistantMessage = { id: nextMessageId(), role: 'assistant', content: '' };
    const history = [...messages, userMessage].map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch('/api/v2/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: sessionId, messages: history }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error('The assistant returned no stream.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let event: AssistantEvent;
          try {
            event = JSON.parse(data) as AssistantEvent;
          } catch {
            continue;
          }
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (delta) {
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + delta };
              return next;
            });
          }
          if (event.error) {
            markUnavailable(event.error);
            finished = true;
            break;
          }
          if (event.done) {
            finished = true;
            break;
          }
        }
      }
    } catch (error) {
      if ((error as { name?: string } | null)?.name !== 'AbortError') {
        markUnavailable(error instanceof Error ? error.message : 'The assistant could not answer.');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages((current) => {
      const last = current[current.length - 1];
      if (!last || last.role !== 'assistant' || last.content) return current;
      return current.slice(0, -1);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[8vh] flex max-h-[80vh] w-[calc(100vw-2rem)] max-w-2xl flex-col rounded-2xl">
        <DialogTitle className="flex items-center gap-2">
          <IconSparkles size={15} className="text-muted-foreground" />
          Ask about this conversation
        </DialogTitle>
        <DialogDescription className="truncate">
          {sessionTitle || 'Read-only assistant · answers from the transcript'}
        </DialogDescription>

        <div ref={scrollRef} className="wb-scroll mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <div className="flex flex-col gap-1.5 py-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => void ask(starter)}
                  className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-full bg-well px-3.5 text-left text-[13px]/[18px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--well-outline),inset_0_1px_0_0_var(--well-highlight)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--well),var(--foreground)_5%)] hover:text-foreground"
                >
                  {starter}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((message) => <ChatRow key={message.id} message={message} />)}
            </div>
          )}
        </div>

        <form
          className="relative mt-3 rounded-[26px] bg-well p-2 shadow-[inset_0_0_0_1px_var(--well-outline)]"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(input);
          }}
        >
          <textarea
            value={input}
            disabled={streaming}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask(input);
              }
            }}
            rows={1}
            placeholder="Ask about this session…"
            aria-label="Ask about this session"
            className="field-text block max-h-40 min-h-9 w-full resize-none overflow-y-auto bg-transparent px-1.5 py-1.5 pb-10 caret-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="absolute right-2 bottom-2">
            {streaming ? (
              <button
                type="button"
                onClick={stop}
                aria-label="Stop generating"
                className="grid size-9 cursor-pointer place-items-center rounded-full bg-well text-foreground shadow-[inset_0_0_0_1px_var(--well-outline)] transition-colors duration-150 hover:bg-accent"
              >
                <IconPlayerStopFilled size={15} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                aria-label="Ask"
                className="grid size-9 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40"
              >
                <IconArrowUp size={17} stroke={2.4} />
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChatRow({ message }: { message: AssistantMessage }) {
  const text = message.content;
  const assistant = message.role === 'assistant';
  if (!text) return null;
  return (
    <div className={cn('flex min-w-0 flex-col', assistant ? 'items-start' : 'items-end')}>
      {assistant
        ? <Markdown className="w-full">{text}</Markdown>
        : (
          <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-well px-3.5 py-2 text-[15px]/6 break-words whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--well-outline),inset_0_1px_0_0_var(--well-highlight)]">
            {text}
          </div>
        )}
    </div>
  );
}
