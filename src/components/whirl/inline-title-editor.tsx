import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconCheck, IconLoader2, IconSparklesFilled } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

export function InlineTitleEditor({
  initialValue,
  onSave,
  onRegenerate,
  onCancel,
  onError,
  className,
}: {
  initialValue: string;
  onSave: (title: string) => Promise<void>;
  onRegenerate: () => Promise<string>;
  onCancel: () => void;
  onError?: (message: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const regenerateRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function save() {
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try { await onSave(title); }
    catch (error) { onError?.(error instanceof Error ? error.message : 'Could not save the title.'); }
    finally { setBusy(false); }
  }

  async function regenerate() {
    if (busy) return;
    setBusy(true);
    try {
      const title = await onRegenerate();
      if (title) {
        setValue(title);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(title.length, title.length);
        });
      }
    } catch (error) { onError?.(error instanceof Error ? error.message : 'Could not regenerate the title.'); }
    finally { setBusy(false); }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); regenerateRef.current?.focus(); }
  }

  function onActionKeyDown(event: KeyboardEvent<HTMLButtonElement>, action: 'regenerate' | 'save') {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'regenerate') {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') saveRef.current?.focus();
      else inputRef.current?.focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') regenerateRef.current?.focus();
    else inputRef.current?.focus();
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onInputKeyDown}
        maxLength={120}
        aria-label="Rename conversation"
        className="h-7 min-w-0 flex-1 rounded-md bg-background px-2 text-[12px] text-foreground outline-none ring-1 ring-primary/60"
      />
      <button
        ref={regenerateRef}
        type="button"
        disabled={busy}
        aria-label="Regenerate title"
        title="Regenerate title (↓, then → and Enter)"
        onClick={() => void regenerate()}
        onKeyDown={(event) => onActionKeyDown(event, 'regenerate')}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? <IconLoader2 size={14} className="animate-spin" /> : <IconSparklesFilled size={14} />}
      </button>
      <button
        ref={saveRef}
        type="button"
        disabled={busy || !value.trim()}
        aria-label="Save title"
        title="Save title (Enter)"
        onClick={() => void save()}
        onKeyDown={(event) => onActionKeyDown(event, 'save')}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-primary text-primary-foreground hover:bg-(--primary-hover) disabled:opacity-50"
      >
        <IconCheck size={14} />
      </button>
    </div>
  );
}
