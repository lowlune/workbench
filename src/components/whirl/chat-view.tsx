import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangleFilled, IconArrowLeft, IconSparkles, IconX } from '@tabler/icons-react';
import { Composer } from '@/components/whirl/composer';
import { InteractionCard } from '@/components/whirl/interaction-card';
import { ModelMenu } from '@/components/whirl/model-menu';
import { ThreadView } from '@/components/whirl/thread/thread-view';
import { getOlderMessages } from '@/lib/api';
import type { Attachment } from '@/lib/attachments';
import { messageContext, statusLabel } from '@/lib/format';
import type { Agent, QueuedMessage, Session } from '@/lib/types';
import { cn, humanBytes } from '@/lib/utils';
import { mutate } from '@/lib/workbench';

interface ChatViewProps {
  session?: Session;
  agent?: Agent;
  loading: boolean;
  sessionId?: string;
  draft: string;
  attachments: Attachment[];
  sending: boolean;
  queued: QueuedMessage[];
  onRemoveQueued: (id: string) => void;
  connectionError?: boolean;
  resumeMemoryAvailable: boolean;
  memoryFree?: number;
  selectedModel?: string;
  onSelectModel: (model: string) => void;
  onAsk?: () => void;
  onDraftChange: (value: string) => void;
  onAttachmentsChange: (value: Attachment[]) => void;
  onSend: () => Promise<void>;
  onBack: () => void;
  onStop: (agent: Agent) => void;
  onStopSession: (sessionId: string) => void;
  onNewTask: () => void;
  onToast: (message: string, isError?: boolean) => void;
  onReplaceSession: (session: Session, mode: 'merge' | 'prepend') => void;
}

/* The chat face, Whirl-shaped: a bare transcript under floating status
   pills, with the composer docked at the bottom edge over the prose. */
export function ChatView({
  session,
  agent,
  loading,
  sessionId,
  draft,
  attachments,
  sending,
  queued,
  onRemoveQueued,
  connectionError,
  resumeMemoryAvailable,
  memoryFree,
  selectedModel,
  onSelectModel,
  onAsk,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onBack,
  onStop,
  onStopSession,
  onNewTask,
  onToast,
  onReplaceSession,
}: ChatViewProps) {
  const queryClient = useQueryClient();
  const columnRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  /* A growing composer pushes the transcript up: publish its height as
     --dock-clearance, which the transcript's bottom padding reads. */
  useEffect(() => {
    const column = columnRef.current;
    const dock = dockRef.current;
    if (!column || !dock) return;
    let previous = 0;
    const observer = new ResizeObserver(() => {
      const clearance = Math.round(dock.offsetHeight) + 12;
      if (clearance === previous) return;
      previous = clearance;
      column.style.setProperty('--dock-clearance', `${clearance}px`);
      const viewport = viewportRef.current;
      if (!viewport) return;
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distance <= clearance + 128) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  const loadOlder = useCallback(async () => {
    const first = session?.messages?.[0];
    if (!sessionId || !first || loadingOlderRef.current || !session?.hasMoreMessages) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const viewport = viewportRef.current;
    const offset = viewport ? viewport.scrollHeight - viewport.scrollTop : 0;
    try {
      const payload = await getOlderMessages(sessionId, first.id);
      onReplaceSession(payload.session, 'prepend');
      requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop = viewport.scrollHeight - offset;
      });
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not load earlier messages.', true);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [session, sessionId, onReplaceSession, onToast]);

  const hasLivePane = Boolean(agent && agent.status !== 'unknown');
  const needsAttention = agent?.status === 'blocked';
  const resumeRunning = !hasLivePane && session?.resumeStatus === 'working';
  const resumeMemoryBlocked = !hasLivePane && Boolean(session?.canResume) && !resumeMemoryAvailable;
  const paused = Boolean(session?.paused);
  const canContinue = hasLivePane || Boolean(session?.canResume) || paused;
  const status = hasLivePane ? statusLabel(agent?.status) : resumeRunning ? 'Thinking' : session?.canResume || paused ? statusLabel('idle') : 'Saved history';
  const isWorking = hasLivePane ? agent?.status === 'working' : resumeRunning;
  const messages = session?.messages;
  const interactions = session?.interactions || [];

  async function resumeSession() {
    const id = sessionId || session?.id;
    if (!id) return;
    try {
      await mutate(`/conversations/${encodeURIComponent(id)}/resume`, {});
      await queryClient.invalidateQueries({ queryKey: ['session', id] });
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not resume this conversation.', true);
    }
  }

  const context = useMemo(() => {
    const list = messages || [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (message.info.role === 'assistant' && (message.info.tokens?.input || message.info.tokens?.cache?.read)) {
        return { ...messageContext(message), model: message.info.modelName || message.info.modelID };
      }
    }
    return { used: 0, limit: 0, percent: 0, output: 0, model: session?.model?.name || session?.model?.id };
  }, [messages, session?.model]);

  return (
    <section className="relative flex h-full min-h-0 flex-col" aria-label="Conversation">
      {/* Floating chrome: back on phones, status and actions on the right. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-6">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="raised pointer-events-auto grid size-8 cursor-pointer place-items-center rounded-full bg-(--popover-translucent) text-foreground backdrop-blur-sm ring-1 ring-border transition-[scale,background-color] duration-150 hover:bg-accent active:scale-[0.94] md:hidden"
        >
          <IconArrowLeft size={16} />
        </button>
        <div className="pointer-events-auto ml-auto flex min-w-0 items-center gap-1.5">
          <ModelMenu
            model={selectedModel || session?.modelPref || context.model}
            context={context}
            directory={session?.directory}
            tags={session?.tags}
            liveAgent={hasLivePane}
            onSelect={onSelectModel}
          />
          {onAsk && (
            <button
              type="button"
              onClick={onAsk}
              className="raised inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border transition-colors duration-150 hover:bg-accent"
            >
              <IconSparkles size={14} />
              <span className="hidden sm:inline">Ask</span>
            </button>
          )}
          <span className={cn(
            'raised inline-flex h-8 items-center gap-1.5 rounded-full bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border',
            needsAttention && 'text-destructive',
          )}>
            <span aria-hidden="true" className={cn(
              'size-1.5 rounded-full',
              isWorking ? 'animate-pulse bg-foreground'
                : needsAttention ? 'bg-destructive'
                  : 'bg-muted-foreground/60',
            )} />
            {status}
          </span>
          {hasLivePane && agent?.status === 'working' && (
            <button
              type="button"
              onClick={() => onStop(agent)}
              className="raised inline-flex h-8 cursor-pointer items-center rounded-full bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
            >
              Stop
            </button>
          )}
          {resumeRunning && sessionId && (
            <button
              type="button"
              onClick={() => onStopSession(sessionId)}
              className="raised inline-flex h-8 cursor-pointer items-center rounded-full bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
            >
              Stop
            </button>
          )}
          {paused && (
            <button
              type="button"
              onClick={() => void resumeSession()}
              className="raised inline-flex h-8 cursor-pointer items-center rounded-full bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border transition-colors duration-150 hover:bg-accent"
            >
              Resume
            </button>
          )}
        </div>
      </div>

      {hasLivePane && !sessionId && (
        <Banner tone="muted">
          Live agent started — no transcript yet. Send a message below and opencode will create its session; the chat then follows it automatically.
        </Banner>
      )}
      {needsAttention && (
        <Banner tone="destructive">
          <span className="flex min-w-0 items-center gap-2">
            <IconAlertTriangleFilled size={14} className="shrink-0" />
            Waiting for approval — respond below to continue.
          </span>
        </Banner>
      )}
      {connectionError && <Banner tone="muted">Reconnecting — your draft is safe.</Banner>}
      {resumeMemoryBlocked && <Banner tone="muted">Free up at least 1 GB of memory to continue this saved task. {humanBytes(memoryFree)} available now.</Banner>}

      <div ref={columnRef} className="relative min-h-0 flex-1">
        <ThreadView
          messages={loading ? undefined : (messages || [])}
          isWorking={Boolean(isWorking)}
          hasMore={Boolean(session?.hasMoreMessages)}
          onLoadOlder={() => void loadOlder()}
          viewportRef={viewportRef}
        />
        {loadingOlder && (
          <span role="status" className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-(--popover-translucent) px-3 py-1 text-[11px] text-muted-foreground ring-1 ring-border backdrop-blur-sm">
            Loading earlier messages…
          </span>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 md:px-6">
          <div ref={dockRef} className="pointer-events-auto mx-auto w-full max-w-3xl pb-3">
            {interactions.map((interaction) => (
              <InteractionCard
                key={interaction.id}
                interaction={interaction}
                onDone={() => {
                  if (session) void queryClient.invalidateQueries({ queryKey: ['session', session.id] });
                }}
                onError={(message) => onToast(message, true)}
              />
            ))}
            {canContinue ? (
              <>
                {queued.length > 0 && (
                  <div
                    role="status"
                    className="mb-2 rounded-2xl bg-(--popover-translucent) px-3 py-2 text-[12px] shadow-[inset_0_0_0_1px_var(--well-outline)] backdrop-blur-sm"
                  >
                    <div className="mb-1 font-medium text-muted-foreground">
                      Queued — sends when the current reply finishes
                    </div>
                    <ul className="flex flex-col gap-1">
                      {queued.map((item) => (
                        <li key={item.id} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-foreground">
                            {item.text || `${item.attachments.length} image${item.attachments.length === 1 ? '' : 's'}`}
                          </span>
                          {item.model && <span className="shrink-0 text-[11px] text-muted-foreground">{item.model}</span>}
                          <button
                            type="button"
                            aria-label="Remove queued message"
                            onClick={() => onRemoveQueued(item.id)}
                            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                          >
                            <IconX size={12} stroke={2.4} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <Composer
                  draft={draft}
                  attachments={attachments}
                  onDraftChange={onDraftChange}
                  onAttachmentsChange={onAttachmentsChange}
                  onSend={onSend}
                  onStop={hasLivePane && agent ? () => onStop(agent) : resumeRunning && sessionId ? () => onStopSession(sessionId) : undefined}
                  isGenerating={Boolean(isWorking)}
                  sending={sending}
                  sendBlocked={needsAttention}
                  placeholder={!sessionId && hasLivePane
                    ? 'Send the first message to this agent…'
                    : resumeRunning
                      ? 'Write a follow-up — it sends when this reply finishes…'
                      : needsAttention
                        ? 'Draft while the agent waits for approval…'
                        : 'Ask anything…'}
                  floating
                  onToast={onToast}
                />
              </>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-[26px] bg-well px-4 py-3 shadow-[inset_0_0_0_1px_var(--well-outline)]">
                <p className="text-[13px]/5 text-muted-foreground">This saved conversation is read-only — its project folder is unavailable.</p>
                <button type="button" onClick={onNewTask} className="shrink-0 cursor-pointer rounded-full bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96]">
                  Start a task
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Banner({ tone, children }: { tone: 'destructive' | 'muted'; children: ReactNode }) {
  return (
    <div className={cn(
      'z-10 flex items-center justify-between gap-3 px-4 py-2 text-[12px] sm:px-6',
      tone === 'destructive'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-well text-muted-foreground',
    )} role="status">
      {children}
    </div>
  );
}
