import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  IconArrowUp,
  IconClipboard,
  IconFile,
  IconLoader2,
  IconPaperclip,
  IconPlayerStopFilled,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { uploadAttachment, type Attachment } from '@/lib/attachments';
import { cn } from '@/lib/utils';

const MAX_ATTACHMENTS = 4;

/* Whirl's composer capsule: a well (frosted while floating over a thread)
   that hugs the textarea, carries the attachment tray inside the same
   spring, and keeps its controls pinned to the corners. */
export function Composer({
  draft,
  attachments,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onStop,
  isGenerating = false,
  disabled = false,
  sending = false,
  sendBlocked = false,
  placeholder = 'Ask anything…',
  floating = false,
  focusSignal = 0,
  onToast,
  meta,
}: {
  draft: string;
  attachments: Attachment[];
  onDraftChange: (value: string) => void;
  onAttachmentsChange: (attachments: Attachment[]) => void;
  onSend: () => Promise<void>;
  onStop?: () => void;
  isGenerating?: boolean;
  disabled?: boolean;
  /** A send is in flight; the textarea stays editable, only submit waits. */
  sending?: boolean;
  /** Typing stays open; only submitting is refused (agent needs approval). */
  sendBlocked?: boolean;
  placeholder?: string;
  floating?: boolean;
  /** Bump to focus the textarea — "New task" lands the caret here. */
  focusSignal?: number;
  onToast: (message: string, isError?: boolean) => void;
  /** Model selector + context usage, rendered inside the capsule. */
  meta?: ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 208)}px`;
  }, [draft]);

  /* Focus when asked, and once more if the composer was still disabled at
     that moment (the home chips seed the project a render later). Only the
     latest signal is ever handled, so later enable/disable flips don't steal
     the caret. */
  const handledFocusRef = useRef(0);
  useEffect(() => {
    if (!focusSignal || handledFocusRef.current === focusSignal) return;
    const element = textareaRef.current;
    if (!element || element.disabled) return;
    handledFocusRef.current = focusSignal;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [focusSignal, disabled]);

  async function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    if (attachments.length + incoming.length > MAX_ATTACHMENTS) {
      onToast(`Attach up to ${MAX_ATTACHMENTS} files at a time.`, true);
      return;
    }
    setProcessing(true);
    try {
      const next = await Promise.all(incoming.map(uploadAttachment));
      onAttachmentsChange([...attachments, ...next]);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not upload that file.', true);
    } finally {
      setProcessing(false);
    }
  }

  async function pasteFromClipboard() {
    if (!window.isSecureContext) {
      onToast('The system clipboard needs a secure connection.', true);
      return;
    }
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
      } else {
        onToast('Clipboard access is unavailable in this browser.', true);
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Clipboard permission was not granted.', true);
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

  const canSend = !disabled && !sendBlocked && !sending && !processing && Boolean(draft.trim() || attachments.length);

  function submit() {
    if (sendBlocked) {
      onToast('The agent is waiting for approval — review its output first.', true);
      return;
    }
    if (!canSend) return;
    void onSend();
  }

  return (
    <form
      onSubmit={(event: FormEvent) => { event.preventDefault(); submit(); }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); if (!disabled) void addFiles(event.dataTransfer.files); }}
      className={cn(
        'relative rounded-3xl border border-[var(--well-outline)] transition-shadow duration-150 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--foreground)_6%,transparent)]',
        floating ? 'bg-(--well-translucent) backdrop-blur-xl' : 'bg-well',
      )}
    >
      <div className="relative p-2">
        {attachments.length > 0 && (
          <div className="wb-enter mb-1 flex flex-wrap gap-2 px-1 pt-1" aria-label="Attached files">
            {attachments.map((attachment, index) => {
              const isImage = Boolean(attachment.mime?.startsWith('image/'));
              return (
                <div key={`${attachment.name}-${index}`} className="relative size-16 overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--well-outline)]">
                  {isImage ? (
                    <img src={attachment.dataUrl} alt={attachment.name} className="size-full object-cover" />
                  ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-1 bg-well px-1.5 text-center">
                      <IconFile size={18} className="shrink-0 text-muted-foreground" />
                      <span className="line-clamp-2 w-full break-all text-[9px]/3 text-muted-foreground">{attachment.name}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => onAttachmentsChange(attachments.filter((_, itemIndex) => itemIndex !== index))}
                    className="absolute top-1 right-1 grid size-5 cursor-pointer place-items-center rounded-full bg-black/70 text-white transition-colors hover:bg-black"
                  >
                    <IconX size={11} stroke={2.5} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <label htmlFor="wb-composer" className="sr-only">Message your agent</label>
        <textarea
          id="wb-composer"
          ref={textareaRef}
          value={draft}
          rows={1}
          disabled={disabled}
          placeholder={disabled
            ? 'Your agent is responding…'
            : isGenerating
              ? 'Add a follow-up — it will wait for this task…'
              : placeholder}
          onChange={(event) => onDraftChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="field-text wb-scrollbar block max-h-52 min-h-9 w-full resize-none overflow-y-auto bg-transparent px-1.5 py-1.5 pb-10 caret-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <div className="absolute bottom-2 left-2 flex items-center">
          <input
            ref={fileRef}
            tabIndex={-1}
            className="sr-only"
            type="file"
            multiple
            aria-label="Choose files to attach"
            disabled={disabled || processing}
            onChange={(event) => {
              if (event.target.files?.length) void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Add attachment"
                  disabled={disabled || processing}
                  className="grid size-8 cursor-pointer place-items-center rounded-full text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
                />
              }
            >
              <IconPlus size={17} stroke={2.2} />
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-56 p-1">
              <MenuItem icon={<IconPaperclip size={15} />} label="Upload file" onClick={() => fileRef.current?.click()} />
              <MenuItem icon={<IconClipboard size={15} />} label="Paste from clipboard" onClick={() => void pasteFromClipboard()} />
            </PopoverContent>
          </Popover>
          {meta && <div className="ml-0.5 flex min-w-0 items-center gap-1.5">{meta}</div>}
        </div>
        <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
          {processing && <IconLoader2 size={15} className="animate-spin text-muted-foreground" />}
          {isGenerating && onStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="grid size-9 cursor-pointer place-items-center rounded-full bg-well text-foreground shadow-[inset_0_0_0_1px_var(--well-outline)] transition-[background-color,scale] duration-150 hover:bg-accent active:scale-[0.96]"
            >
              <IconPlayerStopFilled size={15} />
            </button>
          )}
          {(!isGenerating || canSend) && (
            <button
              type="submit"
              disabled={!canSend}
              aria-label={sending || disabled ? 'Sending message' : 'Send message'}
              title={sendBlocked ? 'Review the agent output before sending' : undefined}
              className="grid size-9 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground transition-[background-color,scale,opacity] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
            >
              {sending || disabled ? <IconLoader2 size={16} className="animate-spin" /> : <IconArrowUp size={17} stroke={2.4} />}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function MenuItem({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-100 hover:bg-accent active:bg-(--accent-pressed)"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );
}
