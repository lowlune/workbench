import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangleFilled, IconArrowLeft, IconArrowUpRight, IconBook, IconClock, IconLoader2, IconX } from '@tabler/icons-react';
import { Composer } from '@/components/whirl/composer';
import { ConversationNav } from '@/components/whirl/conversation-nav';
import type { FileRef } from '@/components/whirl/file-viewer';
import { InteractionCard } from '@/components/whirl/interaction-card';
import { ModelSelect } from '@/components/whirl/model-select';
import { WorkspaceMenu } from '@/components/whirl/workspace-menu';
import { RunSummary } from '@/components/whirl/run-summary';
import { TaskListPanel } from '@/components/whirl/task-list-panel';
import { ThreadView } from '@/components/whirl/thread/thread-view';
import { getOlderMessages } from '@/lib/api';
import { readTabScroll, writeTabScroll } from '@/lib/tabs';
import type { Attachment } from '@/lib/attachments';
import { messageContext } from '@/lib/format';
import type { Agent, Project, QueuedMessage, Session } from '@/lib/types';
import { cn, humanBytes } from '@/lib/utils';
import { conversationPrompts, ACTIVE_RUN_STATES, mutate } from '@/lib/workbench';

const FileViewer = lazy(() => import('@/components/whirl/file-viewer').then(module => ({ default: module.FileViewer })));

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
  /* Optional Fáza 2 hooks (§12/§29); the frozen call site keeps working. */
  onViewChanges?: (runId: string, active: boolean) => void;
  onOpenAgentsMd?: () => void;
  agentsMdActive?: boolean;
  projects?: Project[];
  onSelectWorkspace?: (projectId: string | null) => void;
}

/* True while any dialog, dropdown, listbox or popover is on screen, so ESC
   closes that surface first instead of interrupting the Run (§15). Closed
   keep-mounted popups have no client rects and are ignored. */
function overlayOpen() {
  const nodes = document.querySelectorAll<HTMLElement>(
    '[data-slot="dialog-content"],[role="dialog"],[role="menu"],[data-slot="popover-content"],[role="listbox"]',
  );
  for (const node of nodes) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') continue;
    if (node.getClientRects().length > 0) return true;
  }
  return false;
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
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onBack,
  onStop,
  onStopSession,
  onNewTask,
  onToast,
  onReplaceSession,
  onViewChanges,
  onOpenAgentsMd,
  agentsMdActive,
  projects,
  onSelectWorkspace,
}: ChatViewProps) {
  const queryClient = useQueryClient();
  const sectionRef = useRef<HTMLElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [viewerFile, setViewerFile] = useState<FileRef | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

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

  /* The composer is a floating overlay over the transcript; a wheel event on
     it has no scrollable ancestor, so forward it to the message viewport.
     Textareas that can scroll themselves keep their own wheel handling. */
  useEffect(() => {
    const dock = dockRef.current;
    const viewport = viewportRef.current;
    if (!dock || !viewport) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      const textarea = target?.closest('textarea');
      if (textarea && textarea.scrollHeight > textarea.clientHeight + 1) return;
      viewport.scrollTop += event.deltaY;
      event.preventDefault();
    };
    dock.addEventListener('wheel', onWheel, { passive: false });
    return () => dock.removeEventListener('wheel', onWheel);
  }, []);

  const loadOlder = useCallback(async () => {    const first = session?.messages?.[0];
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
  const isWorking = hasLivePane ? agent?.status === 'working' : resumeRunning;
  const messages = session?.messages;
  const interactions = session?.interactions || [];
  const todos = session?.activeRun?.todos?.length ? session.activeRun.todos : session?.todos;
  const promptsQuery = useQuery({
    queryKey: ['prompts', sessionId],
    queryFn: () => conversationPrompts(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });

  const jumpToMessage = useCallback((messageId: string) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const target = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const fullPrompts = promptsQuery.data?.prompts;
    const fallback = (session?.messages || []).filter((message) => message.info.role === 'user').map((message) => ({ id: message.id }));
    const list = fullPrompts?.length ? fullPrompts : fallback;
    const index = list.findIndex((prompt) => prompt.id === messageId);
    if (index >= 0 && list.length > 1) {
      viewport.scrollTo({ top: (index / (list.length - 1)) * (viewport.scrollHeight - viewport.clientHeight), behavior: 'smooth' });
    }
  }, [session?.messages, promptsQuery.data?.prompts]);

  const openFile = useCallback((file: FileRef) => {
    setViewerFile({ ...file, projectId: file.projectId || session?.projectId || undefined });
    setViewerOpen(true);
  }, [session?.projectId]);


  const stopRun = useCallback(() => {
    if (sessionId) onStopSession(sessionId);
    else if (agent) onStop(agent);
  }, [sessionId, agent, onStopSession, onStop]);

  /* Hard steer: interrupt the running agent so the queued message becomes the
     next turn. `stop` parks the queue, `resume` releases it again — the queued
     command then starts as soon as the interrupted run is reaped. */
  const steer = useCallback(async () => {
    const id = sessionId || session?.id;
    if (!id || !queued.length) return;
    try {
      await mutate(`/conversations/${encodeURIComponent(id)}/stop`, {});
      await mutate(`/conversations/${encodeURIComponent(id)}/resume`, {});
      await queryClient.invalidateQueries({ queryKey: ['session', id] });
      onToast('Stopped the current run — sending your queued message now.');
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not steer the run.', true);
    }
  }, [sessionId, session?.id, queued.length, queryClient, onToast]);

  /* ESC interrupts the active Run only when no other surface owns the key and
     the chat itself holds focus (§15). The callback rides a ref so the
     listener never goes stale and never forces a re-render. */
  const activeRun = session?.activeRun;
  const runActive = Boolean(activeRun && ACTIVE_RUN_STATES.has(String(activeRun.status || '')));
  const interruptRef = useRef<(() => void) | null>(null);
  interruptRef.current = runActive || resumeRunning ? stopRun : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const stop = interruptRef.current;
      if (!stop) return;
      if (overlayOpen()) return;
      const focused = document.activeElement as HTMLElement | null;
      const section = sectionRef.current;
      const inside = !focused || focused === document.body || focused === document.documentElement || (section ? section.contains(focused) : false);
      if (!inside) return;
      event.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  /* Per-tab scroll restore: the transcript
     scroller is reused across tab switches, so remember where each chat was
     and put it back the first time its messages render. */
  const restoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || !messages) return;
    if (restoredForRef.current === sessionId) return;
    restoredForRef.current = sessionId;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const saved = readTabScroll(sessionId);
    viewport.scrollTop = saved == null ? viewport.scrollHeight : saved;
  }, [sessionId, messages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !sessionId) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => writeTabScroll(sessionId, viewport.scrollTop));
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => { viewport.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [sessionId]);

  const queuedIds = useMemo(() => new Set(queued.map((item) => item.id)), [queued]);

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
    <section ref={sectionRef} className="relative flex h-full min-h-0 flex-col" aria-label="Conversation">
      {/* Floating chrome: back on phones, status and actions on the right. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-6">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="raised pointer-events-auto grid size-8 cursor-pointer place-items-center rounded-full bg-(--popover-translucent) text-foreground backdrop-blur-sm ring-1 ring-border transition-[scale,background-color] duration-150 hover:bg-accent active:scale-[0.96] md:hidden"
        >
          <IconArrowLeft size={16} />
        </button>
        <div className="pointer-events-auto ml-auto flex min-w-0 items-center gap-1.5">
          <TaskListPanel todos={todos} />
          {onOpenAgentsMd && agentsMdActive && (
            <button
              type="button"
              onClick={onOpenAgentsMd}
              title="AGENTS.md instructions are active in this project"
              aria-label="Open AGENTS.md instructions"
              className="raised inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border transition-colors duration-150 hover:bg-accent"
            >
              <IconBook size={14} className="text-muted-foreground" />
              <span className="hidden sm:inline">AGENTS.md</span>
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

      <div ref={columnRef} className="relative min-h-0 flex-1 md:py-3">
        <ThreadView
          messages={loading ? undefined : (messages || [])}
          isWorking={Boolean(isWorking)}
          hasMore={Boolean(session?.hasMoreMessages)}
          onLoadOlder={() => void loadOlder()}
          viewportRef={viewportRef}
          onOpenFile={openFile}
          hiddenCommandIds={queuedIds}
        />
        <ConversationNav messages={messages} prompts={promptsQuery.data?.prompts} viewportRef={viewportRef} onJump={jumpToMessage} />
        {loadingOlder && (
          <span role="status" className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-(--popover-translucent) px-3 py-1 text-[11px] text-muted-foreground ring-1 ring-border backdrop-blur-sm">
            <IconLoader2 size={12} className="animate-spin text-muted-foreground/70" />
            Loading earlier messages…
          </span>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
          <div ref={dockRef} className="pointer-events-auto mx-auto w-full max-w-[52rem] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-3">
            {session?.activeRun && (
              <RunSummary
                session={session}
                run={session.activeRun}
                onStop={stopRun}
                onInterrupt={stopRun}
                onViewChanges={onViewChanges}
              />
            )}
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
                {paused && (
                  <div
                    role="status"
                    className="mb-2 flex items-center gap-2 rounded-3xl border border-[var(--well-outline)] bg-(--well-translucent) px-3 py-2 text-[12px] backdrop-blur-xl"
                  >
                    <span className="min-w-0 flex-1 text-muted-foreground">Queue paused — the agent is not processing messages.</span>
                    <button
                      type="button"
                      onClick={() => void resumeSession()}
                      className="shrink-0 cursor-pointer rounded-full bg-well px-3 py-1 text-[12px] font-medium text-foreground shadow-[inset_0_0_0_1px_var(--well-outline)] transition-colors duration-150 hover:bg-accent"
                    >
                      Resume
                    </button>
                  </div>
                )}
                {queued.length > 0 && (
                  <div
                    role="status"
                    className="wb-enter mb-2 rounded-3xl border border-[var(--well-outline)] bg-(--well-translucent) px-3 py-2.5 text-[12px] backdrop-blur-xl"
                  >
                    <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                      <IconClock size={12} className="shrink-0" />
                      <span className="font-medium text-foreground/80">Queued</span>
                      <span className="tabular-nums">{queued.length}</span>
                      <span className="min-w-0 truncate">· sends when the run finishes</span>
                      {runActive && (
                        <button
                          type="button"
                          onClick={() => void steer()}
                          title="Stop the running agent and send this message now"
                          className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-well px-2.5 py-1 font-medium text-foreground shadow-[inset_0_0_0_1px_var(--well-outline)] transition-colors duration-150 hover:bg-accent"
                        >
                          <IconArrowUpRight size={11} stroke={2.2} />
                          Send now
                        </button>
                      )}
                    </div>
                    <ul className="mt-1.5 flex flex-col gap-0.5">
                      {queued.map((item) => (
                        <li key={item.id} className="group/q flex items-start gap-2 rounded-md px-1.5 py-1.5 transition-colors duration-100 hover:bg-accent">
                          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                          <span className="line-clamp-3 min-w-0 flex-1 break-words whitespace-pre-wrap text-[13px]/5 text-foreground/90">
                            {item.text || `${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}`}
                          </span>
                          <button
                            type="button"
                            aria-label="Remove queued message"
                            onClick={() => onRemoveQueued(item.id)}
                            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/q:opacity-100 hover:bg-background hover:text-foreground coarse:opacity-100"
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
                  onStop={runActive || resumeRunning || hasLivePane ? stopRun : undefined}
                  isGenerating={Boolean(isWorking || runActive)}
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
                  meta={(
                    <>
                      {onSelectWorkspace && projects && (
                        <WorkspaceMenu
                          projectId={session?.projectId}
                          directory={session?.directory}
                          projects={projects}
                          onSelect={onSelectWorkspace}
                        />
                      )}
                      <ModelSelect
                        engine={session?.engine || 'pi'}
                        value={selectedModel || session?.modelPref || context.model}
                        context={context}
                        directory={session?.directory}
                        tags={session?.tags}
                        liveAgent={hasLivePane}
                        onChange={onSelectModel}
                        onToast={onToast}
                        compact
                      />
                      {context.limit > 0 && (
                        <span
                          title={`${context.percent}% of the context window used`}
                          className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
                        >
                          {context.percent}%
                        </span>
                      )}
                    </>
                  )}
                />
              </>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-3xl bg-well px-4 py-3 shadow-[inset_0_0_0_1px_var(--well-outline)]">
                <p className="text-[13px]/5 text-muted-foreground">This saved conversation is read-only — its project folder is unavailable.</p>
                <button type="button" onClick={onNewTask} className="shrink-0 cursor-pointer rounded-full bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96]">
                  Start a task
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {viewerOpen && <Suspense fallback={null}><FileViewer open={viewerOpen} file={viewerFile} onOpenChange={setViewerOpen} onToast={onToast} /></Suspense>}
    </section>
  );
}

function Banner({ tone, children }: { tone: 'destructive' | 'muted'; children: ReactNode }) {
  return (
    <div className={cn(
      'wb-enter z-10 flex items-center justify-between gap-3 px-4 py-2 text-[12px] sm:px-6',
      tone === 'destructive'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-well text-muted-foreground',
    )} role="status">
      {children}
    </div>
  );
}
