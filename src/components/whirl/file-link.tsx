import type { ReactNode } from 'react';
import { IconFile, IconFilePencil, IconFileText } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

export type FileStatus = 'read' | 'changed' | 'created' | 'deleted';

/** A reference to a file the viewer can open. `projectId` reads through the
 *  project file endpoint; `url`/`attachmentId` cover uploaded attachments. */
export interface FileRef {
  path: string;
  status: FileStatus;
  projectId?: string | null;
  additions?: number;
  deletions?: number;
  attachmentId?: string;
  url?: string;
  name?: string;
}

export function baseName(path: string) {
  return path.split('/').filter(Boolean).pop() || path;
}

export function statusIcon(status: FileStatus): ReactNode {
  if (status === 'changed') return <IconFilePencil size={13} />;
  if (status === 'read') return <IconFileText size={13} />;
  return <IconFile size={13} />;
}

export const STATUS_TONE: Record<FileStatus, string> = {
  read: 'text-muted-foreground',
  changed: 'text-amber-600 dark:text-amber-400',
  created: 'text-emerald-600 dark:text-emerald-400',
  deleted: 'text-destructive',
};

/** Inline, clickable file reference used across the thread. Kept in its own
 *  lightweight module so the heavy file-viewer chunk stays lazy-loadable. */
export function FileLink({ file, onOpen, className }: { file: FileRef; onOpen?: (file: FileRef) => void; className?: string }) {
  const name = file.name || baseName(file.path);
  const clickable = Boolean(onOpen);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => onOpen?.(file)}
      title={file.path}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[12px] transition-colors duration-100',
        clickable ? 'cursor-pointer hover:bg-accent' : 'cursor-default',
        className,
      )}
    >
      <span className={cn('shrink-0', STATUS_TONE[file.status])}>{statusIcon(file.status)}</span>
      <span className="truncate text-foreground">{name}</span>
      {(file.additions ?? 0) > 0 && <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
      {(file.deletions ?? 0) > 0 && <span className="shrink-0 tabular-nums text-destructive">-{file.deletions}</span>}
    </button>
  );
}
