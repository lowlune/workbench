import { isValidElement, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ClipboardText,
  Copy,
  Cpu,
  DotsThree,
  FileImage,
  List,
  Paperclip,
  Sparkle,
  SpinnerGap,
  Stop,
  Wrench,
  X,
} from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getOlderMessages } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import type { Agent, Message, MessagePart, Session } from '@/lib/types';
import { cn, formatTime, humanBytes, shortDirectory } from '@/lib/utils';

export interface Attachment {
  name: string;
  dataUrl: string;
}

interface ChatViewProps {
  session?: Session;
  agent?: Agent;
  loading: boolean;
  sessionId?: string;
  draft: string;
  attachments: Attachment[];
  sending: boolean;
  connectionError?: boolean;
  resumeMemoryAvailable: boolean;
  memoryFree?: number;
  onDraftChange: (value: string) => void;
  onAttachmentsChange: (value: Attachment[]) => void;
  onSend: () => Promise<void>;
  onBack: () => void;
  onOpenNavigation: () => void;
  onStop: (agent: Agent) => void;
  onStopSession: (sessionId: string) => void;
  onOutput: (agent: Agent) => void;
  onNewTask: () => void;
  onToast: (message: string, isError?: boolean) => void;
  onReplaceSession: (session: Session, mode: 'merge' | 'prepend') => void;
}

function statusLabel(status?: string) {
  return ({ working: 'Thinking', blocked: 'Needs your attention', idle: 'Ready', done: 'Ready to continue', unknown: 'Online' } as Record<string, string>)[status || ''] || 'Conversation';
}

function titleCase(value?: string) {
  if (!value) return '';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function messageText(message: Message) {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
}

function isActivity(message: Message) {
  return message.info.role === 'assistant'
    && !messageText(message).trim()
    && message.parts.some((part) => ['tool', 'step-start', 'step-finish', 'reasoning'].includes(part.type));
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = nodeText(children).replace(/\n$/, '');
  async function handleCopy() {
    try {
      await copyText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* Clipboard denial should not break message rendering. */ }
  }
  return (
    <div className="group/code my-4 overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex h-9 items-center justify-between border-b border-border px-3 text-xs text-muted-foreground">
        <span>Code</span>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs opacity-75 group-hover/code:opacity-100" onClick={handleCopy} aria-label="Copy code block">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-w-full overflow-x-auto p-4 text-[13px] leading-6"><code>{children}</code></pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined} {...props}>{children}</a>
  ),
  pre: ({ children }) => <MarkdownPre>{children}</MarkdownPre>,
  code: ({ className, children, ...props }) => (
    <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-[.88em]', className?.includes('language-') && 'bg-transparent p-0')} {...props}>{children}</code>
  ),
};

function ToolItem({ part }: { part: MessagePart }) {
  const state = part.state || {};
  const output = state.error || state.output || state.raw || (state.input ? JSON.stringify(state.input, null, 2) : '');
  return (
    <details className="rounded-lg border border-border bg-panel">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-xs marker:hidden [&::-webkit-details-marker]:hidden">
        <Wrench aria-hidden="true" size={15} className="text-muted-foreground" />
        <span className="font-medium">{part.tool || 'Tool'}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{state.title || 'Activity'}</span>
        <Badge variant={state.status === 'error' ? 'destructive' : state.status === 'running' ? 'working' : 'default'} className="px-2 py-0.5 text-[10px]">{state.status || 'done'}</Badge>
      </summary>
      {output && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-3 font-mono text-[11px] leading-5 text-muted-foreground">{output}</pre>}
    </details>
  );
}

function ActivityGroup({ messages, isWorking }: { messages: Message[]; isWorking: boolean }) {
  const tools = messages.flatMap((message) => message.parts.filter((part) => part.type === 'tool'));
  const progress = messages.flatMap((message) => message.parts.filter((part) => ['reasoning', 'step-start', 'step-finish'].includes(part.type)));
  const runningTool = tools.some((part) => ['running', 'pending'].includes(part.state?.status || ''));
  const active = runningTool || isWorking;
  const label = active ? (runningTool ? 'Using tools' : 'Thinking') : tools.length ? `Completed ${tools.length} ${tools.length === 1 ? 'action' : 'actions'}` : 'Task progress';
  return (
    <details className="group/activity w-full max-w-3xl self-start overflow-hidden rounded-xl border border-border bg-muted/45">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-3.5 text-sm marker:hidden [&::-webkit-details-marker]:hidden">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg bg-panel text-muted-foreground', active && 'text-success')}>
          {runningTool ? <Wrench aria-hidden="true" size={15} /> : <Sparkle aria-hidden="true" size={15} />}
        </span>
        <span className="font-medium">{label}</span>
        {active && <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />}
        {Boolean(tools.length || progress.length) && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{tools.length || progress.length}</span>}
        <DotsThree aria-hidden="true" size={17} className="text-muted-foreground transition-transform group-open/activity:rotate-90" />
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-3">
        {tools.length ? tools.map((part) => <ToolItem key={part.id} part={part} />) : (
          <p className="px-1 py-1 text-xs leading-5 text-muted-foreground">{active ? 'The agent is working through your request. Private reasoning is not displayed.' : 'Progress details are not available for this step.'}</p>
        )}
      </div>
    </details>
  );
}

function MessageBubble({ message, onToast }: { message: Message; onToast: (message: string, isError?: boolean) => void }) {
  const role = message.info.role;
  const text = messageText(message);
  const date = message.created ? new Date(Number(message.created)) : null;
  const dateTime = date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
  return (
    <article className={cn('group/message flex w-full max-w-3xl gap-3', role === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto')} aria-label={role === 'user' ? 'Your message' : 'Assistant message'}>
      <span aria-hidden="true" className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold', role === 'user' ? 'bg-secondary text-secondary-foreground' : 'bg-primary text-primary-foreground')}>{role === 'user' ? 'Y' : 'W'}</span>
      <div className={cn('min-w-0 flex-1', role === 'user' && 'max-w-[88%] rounded-2xl bg-secondary px-4 py-3 sm:max-w-[78%]')}>
        <header className="mb-1.5 flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{role === 'user' ? 'You' : 'Workbench'}</span>
          {dateTime && <time dateTime={dateTime}>{formatTime(message.created)}</time>}
          {text && <Button type="button" size="icon-sm" variant="ghost" className="ml-auto size-7 opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100" onClick={() => void copyText(text).then(() => onToast('Message copied')).catch(() => onToast('Could not copy message.', true))} aria-label="Copy message"><Copy aria-hidden="true" size={14} /></Button>}
        </header>
        {text && <div className={cn('message-markdown min-w-0 text-sm leading-7', role === 'user' && 'whitespace-pre-wrap') }><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown></div>}
        <div className="mt-2 grid gap-2">
          {message.parts.filter((part) => part.type === 'file').map((part) => (
            part.mime?.startsWith('image/') && part.url
              ? <a key={part.id} href={part.url} target="_blank" rel="noreferrer" className="inline-block max-w-full"><img src={part.url} alt={part.filename || 'Attached image'} className="max-h-80 max-w-full rounded-xl border border-border object-contain" loading="lazy" /></a>
              : <div key={part.id} className="flex items-center gap-2 text-xs text-muted-foreground"><FileImage aria-hidden="true" size={16} />{part.filename || 'Attached file'}</div>
          ))}
          {message.parts.filter((part) => part.type === 'tool').map((part) => <ToolItem key={part.id} part={part} />)}
        </div>
      </div>
    </article>
  );
}

function MessageList({ messages, isWorking, onToast }: { messages: Message[]; isWorking: boolean; onToast: (message: string, isError?: boolean) => void }) {
  const rows = useMemo(() => {
    const output: Array<{ kind: 'message'; message: Message } | { kind: 'activity'; messages: Message[] }> = [];
    for (let index = 0; index < messages.length;) {
      if (!isActivity(messages[index])) {
        output.push({ kind: 'message', message: messages[index++] });
        continue;
      }
      const group: Message[] = [];
      while (index < messages.length && isActivity(messages[index])) group.push(messages[index++]);
      output.push({ kind: 'activity', messages: group });
    }
    return output;
  }, [messages]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-7 sm:px-7 sm:py-9">
      {rows.map((row) => row.kind === 'message'
        ? <MessageBubble key={row.message.id} message={row.message} onToast={onToast} />
        : <ActivityGroup key={row.messages[0].id} messages={row.messages} isWorking={isWorking && row === rows.at(-1)} />)}
    </div>
  );
}

function EmptyConversation({ title }: { title: string }) {
  return (
    <div className="mx-auto grid w-full max-w-2xl flex-1 content-center justify-items-center px-5 pb-8 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground"><Sparkle aria-hidden="true" size={22} /></span>
      <h2 className="mt-4 text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">Tell your agent what you want to accomplish. You can add an image, paste a screenshot, or send a follow-up at any time.</p>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<Attachment> {
  const supported = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!supported.has(file.type)) return Promise.reject(new Error('Choose a JPEG, PNG, WebP, or GIF image.'));
  if (file.size > 5 * 1024 * 1024) return Promise.reject(new Error('Images must be 5 MB or smaller.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name || 'image', dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
}

function Composer({
  draft,
  attachments,
  disabled,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onToast,
  sendBlocked,
  disabledLabel,
}: {
  draft: string;
  attachments: Attachment[];
  disabled: boolean;
  onDraftChange: (text: string) => void;
  onAttachmentsChange: (attachments: Attachment[]) => void;
  onSend: () => Promise<void>;
  onToast: (message: string, isError?: boolean) => void;
  sendBlocked?: boolean;
  disabledLabel?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);

  async function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (attachments.length + incoming.length > 4) return onToast('Attach up to four images at a time.', true);
    setProcessing(true);
    try {
      const next = await Promise.all(incoming.map(fileToDataUrl));
      onAttachmentsChange([...attachments, ...next]);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not read that image.', true);
    } finally {
      setProcessing(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!disabled && !sendBlocked && !processing && (draft.trim() || attachments.length)) void onSend();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length) {
      event.preventDefault();
      void addFiles(images);
    }
  }

  async function pasteFromClipboard() {
    if (!window.isSecureContext) return onToast('System clipboard requires a secure HTTPS connection.', true);
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        const files: File[] = [];
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            files.push(new File([blob], `clipboard-${Date.now()}.${imageType.split('/')[1]}`, { type: imageType }));
          }
        }
        if (files.length) return void await addFiles(files);
      }
      if (navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) onDraftChange(`${draft}${draft && !draft.endsWith('\n') ? '\n' : ''}${text}`);
        else onToast('The clipboard is empty.', true);
      } else onToast('Clipboard access is unavailable in this browser.', true);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Clipboard permission was not granted.', true);
    }
  }

  const canSend = !disabled && !sendBlocked && !processing && Boolean(draft.trim() || attachments.length);

  return (
    <div className="sticky bottom-0 z-10 bg-gradient-to-t from-background via-background to-transparent px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-5">
      <form
        className="mx-auto w-full max-w-3xl rounded-2xl border border-input bg-panel shadow-[0_8px_32px_-18px_rgba(20,20,30,.35)] transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20"
        onSubmit={(event: FormEvent) => { event.preventDefault(); if (canSend) void onSend(); }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files); }}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached images">
            {attachments.map((attachment, index) => (
              <div key={`${attachment.name}-${index}`} className="relative size-16 overflow-hidden rounded-xl border border-border bg-muted">
                <img src={attachment.dataUrl} alt={attachment.name} className="size-full object-cover" />
                <button type="button" onClick={() => onAttachmentsChange(attachments.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${attachment.name}`} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/75 text-white hover:bg-black"><X aria-hidden="true" size={13} weight="bold" /></button>
              </div>
            ))}
          </div>
        )}
        <label htmlFor="message-composer" className="sr-only">Message your agent</label>
        <Textarea
          id="message-composer"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          placeholder={disabled ? disabledLabel || 'Your agent is responding…' : 'Message your agent…'}
          className="max-h-52 min-h-16 resize-y border-0 bg-transparent px-4 py-3 text-[15px] leading-6 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          aria-describedby="composer-hint"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            <input ref={fileRef} tabIndex={-1} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple aria-label="Choose images to attach" disabled={disabled || processing} onChange={(event) => { if (event.target.files?.length) void addFiles(event.target.files); event.target.value = ''; }} />
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => fileRef.current?.click()} aria-label="Attach images" disabled={disabled || processing}><Paperclip aria-hidden="true" size={17} /></Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void pasteFromClipboard()} aria-label="Paste from clipboard" disabled={disabled || processing}><ClipboardText aria-hidden="true" size={17} /></Button>
            <span id="composer-hint" className="hidden truncate pl-1 text-[11px] text-muted-foreground sm:inline">Enter to send · Shift+Enter for a new line · drop an image to attach</span>
            {processing && <span className="text-xs text-muted-foreground" role="status">Adding image…</span>}
          </div>
          <Button type="submit" size="icon" className="size-9 rounded-xl" aria-label={disabled ? 'Sending message' : sendBlocked ? 'Free up memory before sending' : 'Send message'} disabled={!canSend}>
            {disabled ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : <ArrowUp aria-hidden="true" weight="bold" />}
          </Button>
        </div>
      </form>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground">Agents can make mistakes. Review important changes before shipping.</p>
    </div>
  );
}

export function ChatView({
  session,
  agent,
  loading,
  sessionId,
  draft,
  attachments,
  sending,
  connectionError,
  resumeMemoryAvailable,
  memoryFree,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onBack,
  onOpenNavigation,
  onStop,
  onStopSession,
  onOutput,
  onNewTask,
  onToast,
  onReplaceSession,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastUpdateRef = useRef('');

  useEffect(() => {
    if (!session?.messages?.length) return;
    const last = session.messages.at(-1);
    const revision = `${last?.id || ''}:${last?.parts.length || 0}:${session.updated || ''}`;
    if (revision === lastUpdateRef.current) return;
    lastUpdateRef.current = revision;
    if (atBottomRef.current) {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
      setShowJump(false);
    } else setShowJump(true);
    initialScrollDoneRef.current = true;
  }, [session?.messages, session?.updated]);

  async function loadOlder() {
    const first = session?.messages?.[0];
    if (!sessionId || !first || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const element = scrollRef.current;
    const oldHeight = element?.scrollHeight || 0;
    const oldTop = element?.scrollTop || 0;
    let releaseAfterLayout = false;
    try {
      const payload = await getOlderMessages(sessionId, first.id);
      onReplaceSession(payload.session, 'prepend');
      if (element) {
        releaseAfterLayout = true;
        requestAnimationFrame(() => {
          element.scrollTop = oldTop + element.scrollHeight - oldHeight;
          loadingOlderRef.current = false;
          setLoadingOlder(false);
        });
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not load earlier messages.', true);
    } finally {
      if (!releaseAfterLayout) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }

  function jumpToLatest() {
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJump(false);
  }

  const hasLivePane = Boolean(agent && agent.status !== 'unknown');
  const needsAttention = agent?.status === 'blocked';
  const resumeRunning = !hasLivePane && session?.resumeStatus === 'working';
  const resumeMemoryBlocked = !hasLivePane && Boolean(session?.canResume) && !resumeMemoryAvailable;
  const canContinue = hasLivePane || Boolean(session?.canResume);
  const status = hasLivePane
    ? statusLabel(agent?.status)
    : resumeRunning ? 'Thinking' : session?.canResume ? 'Ready to continue' : 'Saved history';
  const messages = session?.messages || [];
  const latestUsageMessage = [...messages].reverse().find((message) => {
    const tokens = message.info.tokens;
    return message.info.role === 'assistant' && Boolean(tokens?.input || tokens?.cache?.read || tokens?.cache?.write);
  });
  const latestInfo = latestUsageMessage?.info;
  const modelId = latestInfo?.modelID || session?.model?.id;
  const providerId = latestInfo?.providerID || session?.model?.providerID;
  const modelName = latestInfo?.modelName || (session?.model?.id === modelId ? session?.model?.name || modelId : modelId);
  const effort = latestInfo?.variant || session?.model?.variant;
  const mode = latestInfo?.mode;
  const contextLimit = Number(latestInfo?.contextLimit || session?.model?.contextLimit || 0);
  const usage = latestInfo?.tokens;
  const contextUsed = Number(usage?.input || 0) + Number(usage?.cache?.read || 0) + Number(usage?.cache?.write || 0);
  const contextPercent = contextLimit > 0 && contextUsed > 0 ? Math.min(100, Math.round(contextUsed / contextLimit * 100)) : 0;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Conversation">
      <header className="z-10 flex min-h-[60px] shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-6">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenNavigation} aria-label="Open navigation"><List aria-hidden="true" size={19} /></Button>
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to previous page" title="Back"><ArrowLeft aria-hidden="true" size={18} /></Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{session?.title || 'Conversation'}</h1>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className="truncate">{shortDirectory(session?.directory)}</span>
            <span aria-hidden="true">·</span>
            <span role="status" aria-live="polite" className={cn('truncate', (agent?.status === 'working' || resumeRunning) && 'text-success', needsAttention && 'text-warning')}>{status}</span>
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-[10px] text-muted-foreground" aria-label="Model and context details">
            {modelName && <span title={`${providerId || 'Model'} · ${modelId}`} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-1 font-medium text-foreground"><Cpu aria-hidden="true" size={12} />{modelName}</span>}
            <Badge className="shrink-0 px-1.5 py-0.5 text-[10px]">Effort · {titleCase(effort) || 'Default'}</Badge>
            {mode && <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5">{titleCase(mode)}</span>}
            <span className="ml-auto inline-flex min-w-0 shrink-0 items-center gap-1.5" title={contextLimit ? `Last turn context: ${formatTokens(contextUsed)} of ${formatTokens(contextLimit)} tokens` : 'Context limit unavailable for this model'}>
              <span>Context</span>
              {contextLimit > 0 && contextUsed > 0 ? (
                <>
                  <progress className={cn('context-progress h-1.5 w-14 overflow-hidden rounded-full', contextPercent >= 85 && 'is-warning', contextPercent >= 95 && 'is-critical')} max={100} value={contextPercent} aria-label={`Context used ${contextPercent}%`} />
                  <span className="tabular-nums">{contextPercent}% · {formatTokens(contextUsed)}/{formatTokens(contextLimit)}</span>
                </>
              ) : <span>Usage unavailable</span>}
            </span>
          </div>
        </div>
        {agent?.status === 'working' && <Button variant="outline" size="sm" onClick={() => onStop(agent)}><Stop aria-hidden="true" size={15} weight="fill" /><span className="hidden sm:inline">Stop</span></Button>}
        {resumeRunning && sessionId && <Button variant="outline" size="sm" onClick={() => onStopSession(sessionId)}><Stop aria-hidden="true" size={15} weight="fill" /><span className="hidden sm:inline">Stop</span></Button>}
        {agent && <Button variant="ghost" size="sm" onClick={() => onOutput(agent)} className="hidden sm:inline-flex">Output</Button>}
        {agent && <Button variant="ghost" size="icon-sm" onClick={() => onOutput(agent)} className="sm:hidden" aria-label="View live output"><Wrench aria-hidden="true" size={17} /></Button>}
      </header>

      {needsAttention && (
        <div className="flex items-center justify-between gap-3 border-b border-warning/25 bg-warning/10 px-4 py-2.5 text-sm sm:px-7" role="status">
          <span className="min-w-0 text-warning">Your agent is waiting for approval. Review its live output before continuing.</span>
          {agent && <Button variant="outline" size="sm" onClick={() => onOutput(agent)}>Review output</Button>}
        </div>
      )}
      {connectionError && <div className="border-b border-warning/25 bg-warning/10 px-4 py-2 text-center text-xs text-warning" role="status">Reconnecting — your draft is safe.</div>}
      {resumeMemoryBlocked && <div className="border-b border-warning/25 bg-warning/10 px-4 py-2 text-center text-xs text-warning" role="status">Free up at least 1 GB of memory to continue this saved task. {humanBytes(memoryFree)} is available now.</div>}

      <div
        ref={scrollRef}
        data-message-scroll=""
        role="region"
        aria-label="Conversation messages"
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          atBottomRef.current = nearBottom;
          if (nearBottom) setShowJump(false);
          if (initialScrollDoneRef.current && element.scrollTop <= 56 && session?.hasMoreMessages && !loadingOlderRef.current) void loadOlder();
        }}
        onWheel={(event) => {
          const element = event.currentTarget;
          if (event.deltaY < 0 && element.scrollTop <= 56 && initialScrollDoneRef.current && session?.hasMoreMessages && !loadingOlderRef.current) void loadOlder();
        }}
        onTouchStart={(event) => { touchStartYRef.current = event.touches[0]?.clientY ?? null; }}
        onTouchEnd={(event) => {
          const startY = touchStartYRef.current;
          const endY = event.changedTouches[0]?.clientY;
          touchStartYRef.current = null;
          const element = event.currentTarget;
          if (startY !== null && endY !== undefined && endY - startY > 32 && element.scrollTop <= 56 && initialScrollDoneRef.current && session?.hasMoreMessages && !loadingOlderRef.current) void loadOlder();
        }}
      >
        {loading ? (
          <div className="mx-auto grid w-full max-w-3xl gap-5 px-4 py-8 sm:px-7" aria-label="Loading conversation">
            {[0, 1, 2].map((item) => <div key={item} className={cn('h-16 animate-pulse rounded-xl bg-muted', item === 1 && 'ml-12 w-3/4', item === 2 && 'w-5/6')} />)}
          </div>
        ) : session ? (
          <>
            {loadingOlder && <div className="sticky top-3 z-10 flex justify-center"><span role="status" className="inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-muted-foreground shadow-sm"><SpinnerGap aria-hidden="true" size={14} className="animate-spin" />Loading earlier messages…</span></div>}
            {messages.length ? <MessageList messages={messages} isWorking={agent?.status === 'working' || resumeRunning} onToast={onToast} /> : <EmptyConversation title="Ready when you are." />}
          </>
        ) : (
          <div className="mx-auto max-w-xl px-6 py-12 text-center" role="alert">
            <h2 className="font-semibold">Conversation unavailable</h2>
            <p className="mt-2 text-sm text-muted-foreground">The conversation could not be loaded. Go back and try again.</p>
          </div>
        )}
        {showJump && <Button variant="outline" size="icon" className="sticky bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-panel shadow-md" onClick={jumpToLatest} aria-label="Jump to latest message"><ArrowDown aria-hidden="true" /></Button>}
      </div>

      {canContinue ? (
        <Composer draft={draft} attachments={attachments} disabled={sending || needsAttention || resumeRunning} sendBlocked={resumeMemoryBlocked} disabledLabel={resumeRunning ? 'Your saved conversation is responding…' : needsAttention ? 'This agent needs your attention…' : 'Sending…'} onDraftChange={onDraftChange} onAttachmentsChange={onAttachmentsChange} onSend={onSend} onToast={onToast} />
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 border-t border-border bg-panel px-5 py-4 text-center sm:flex-row sm:justify-between sm:px-7">
          <p className="text-sm text-muted-foreground">This saved conversation is read-only because its project folder is unavailable to Workbench.</p>
          <Button size="sm" onClick={onNewTask}>Start a task</Button>
        </div>
      )}
    </section>
  );
}
