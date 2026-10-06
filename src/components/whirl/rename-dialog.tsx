import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/* Whirl's rename dialog, Workbench-sized. */
export function RenameDialog({
  open,
  initialValue,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initialValue: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) setValue(initialValue);
    wasOpenRef.current = open;
  }, [open, initialValue]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== initialValue.trim();

  function save() {
    if (!canSave) return;
    onOpenChange(false);
    onSubmit(trimmed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[24vh] max-w-sm rounded-2xl">
        <DialogTitle>Rename conversation</DialogTitle>
        <DialogDescription className="sr-only">Give this conversation a new title.</DialogDescription>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.target.select()}
            placeholder="Conversation title"
            maxLength={120}
            className="h-10 rounded-xl bg-well ring-[var(--well-outline)]"
          />
          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer rounded-full px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="cursor-pointer rounded-full bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
            >
              Rename
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
