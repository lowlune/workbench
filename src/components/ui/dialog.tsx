import { X } from '@phosphor-icons/react';
import { createContext, useContext, useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext() {
  const context = useContext(DialogContext);
  if (!context) throw new Error('Dialog parts must be rendered within <Dialog>.');
  return context;
}

export function Dialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const titleId = useId();
  const descriptionId = useId();
  return <DialogContext.Provider value={{ open, onOpenChange, titleId, descriptionId }}>{children}</DialogContext.Provider>;
}

export function DialogContent({ className, children }: { className?: string; children: ReactNode }) {
  const context = useDialogContext();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (context.open && !dialog.open) dialog.showModal();
    else if (!context.open && dialog.open) dialog.close();
  }, [context.open]);

  function close() {
    context.onOpenChange(false);
    if (dialogRef.current?.open) dialogRef.current.close();
  }

  return (
    <dialog
      ref={dialogRef}
      data-workbench-dialog=""
      aria-labelledby={context.titleId}
      aria-describedby={context.descriptionId}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={() => context.onOpenChange(false)}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}
      className={cn('fixed left-1/2 top-1/2 m-0 grid max-h-[min(88dvh,760px)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-2xl border border-border bg-panel p-0 text-panel-foreground shadow-2xl outline-none backdrop:bg-black/45 backdrop:backdrop-blur-[2px]', className)}
    >
      <div className="relative grid gap-5 p-6 sm:p-7">
        {children}
        <button type="button" aria-label="Close dialog" onClick={close} className="absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <X aria-hidden="true" size={18} />
        </button>
      </div>
    </dialog>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid gap-1.5 pr-8', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  const context = useDialogContext();
  return <h2 id={context.titleId} className={cn('text-lg font-semibold tracking-tight', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const context = useDialogContext();
  return <p id={context.descriptionId} className={cn('text-sm leading-6 text-muted-foreground', className)} {...props} />;
}
