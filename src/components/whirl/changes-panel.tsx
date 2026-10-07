import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangleFilled,
  IconFileDiff,
  IconGitPullRequest,
  IconLoader2,
  IconTrash,
} from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { applyRun, conversationChanges, discardRun, runChanges, type ChangedFile } from '@/lib/workbench';
import { cn } from '@/lib/utils';

/* Which Run (or conversation) the panel is showing. `runId` enables Apply and
   Discard; without it (a finished Run discovered from the menu) the same
   worktree can still be inspected read-only through the conversation route. */
export interface ChangesTarget {
  runId?: string;
  conversationId?: string;
  runActive?: boolean;
  title?: string;
}

type FileStatus = 'modified' | 'created' | 'deleted' | 'renamed';

/* Worktree changes are a strict binary patch relative to the run baseline
   (§12). Apply never overwrites silently: a mismatch comes back as `conflict`
   and is surfaced loudly here. */
function fileStatuses(patch: string): Record<string, FileStatus> {
  const map: Record<string, FileStatus> = {};
  let current = '';
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = header[2];
      map[current] = 'modified';
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) map[current] = 'created';
    else if (line.startsWith('deleted file mode')) map[current] = 'deleted';
    else if (line.startsWith('rename from')) map[current] = 'renamed';
  }
  return map;
}

const FILE_TONE: Record<FileStatus, string> = {
  modified: 'text-amber-600 dark:text-amber-400',
  created: 'text-emerald-600 dark:text-emerald-400',
  deleted: 'text-destructive',
  renamed: 'text-sky-600 dark:text-sky-400',
};

function statusLabel(status: string) {
  switch (status) {
    case 'applied': return 'Applied';
    case 'discarded': return 'Discarded';
    case 'conflict': return 'Conflict';
    case 'missing': return 'Worktree missing';
    case 'none': return 'No changes';
    default: return 'Open';
  }
}

function patchLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('Binary files')) return 'text-muted-foreground';
  if (line.startsWith('@@')) return 'text-sky-600 dark:text-sky-400';
  if (line.startsWith('+')) return 'text-emerald-700 dark:text-emerald-400';
  if (line.startsWith('-')) return 'text-destructive';
  return 'text-foreground';
}

export function ChangesPanel({ open, onOpenChange, target, onToast, onChanged }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ChangesTarget | null;
  onToast: (message: string, isError?: boolean) => void;
  onChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const [wantPatch, setWantPatch] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const key = target?.runId || target?.conversationId || '';
  const runId = target?.runId;
  const conversationId = target?.conversationId;
  const runActive = Boolean(target?.runActive);

  useEffect(() => {
    setWantPatch(false);
    setConfirmDiscard(false);
  }, [key, open]);

  const changesQuery = useQuery({
    queryKey: ['run-changes', key, wantPatch],
    queryFn: () => runId ? runChanges(runId, wantPatch) : conversationChanges(conversationId!, wantPatch),
    enabled: open && Boolean(key),
    staleTime: 0,
    retry: 1,
    /* Keep the file list while the lazy patch loads, so toggling "Show diff"
       never blanks the panel. */
    placeholderData: (previous) => previous,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['run-changes'] });
    onChanged?.();
  };

  const apply = useMutation({
    mutationFn: () => applyRun(runId!),
    onSuccess: (result) => {
      if (result.status === 'conflict') {
        onToast(result.error || 'The changes no longer apply cleanly. Nothing was overwritten.', true);
      } else {
        onToast('Changes applied to the project.');
      }
      refresh();
    },
    onError: (error) => onToast(error instanceof Error ? error.message : 'Could not apply the changes.', true),
  });

  const discard = useMutation({
    mutationFn: () => discardRun(runId!),
    onSuccess: () => {
      onToast('Changes discarded.');
      setConfirmDiscard(false);
      refresh();
    },
    onError: (error) => onToast(error instanceof Error ? error.message : 'Could not discard the changes.', true),
  });

  const data = changesQuery.data;
  const statuses = useMemo(() => fileStatuses(data?.patch || ''), [data?.patch]);
  const files: ChangedFile[] = data?.files || [];
  const patch = data?.patch || '';
  const busy = apply.isPending || discard.isPending;
  const actionsDisabled = busy || runActive || !runId || !files.length
    || data?.status === 'applied' || data?.status === 'discarded';
  const status = data?.status || 'active';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[6vh] flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-0 overflow-hidden rounded-xl p-0">
        <DialogTitle className="sr-only">Run changes</DialogTitle>
        <DialogDescription className="sr-only">Review the files a run changed in its isolated worktree, then apply or discard them.</DialogDescription>

        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <IconFileDiff size={16} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold">{target?.title || 'Run changes'}</p>
            <p className="text-[11px] text-muted-foreground">
              {statusLabel(status)}
              {files.length > 0 && <> · {files.length} file{files.length === 1 ? '' : 's'} · <span className="text-emerald-600 dark:text-emerald-400">+{data?.additions ?? 0}</span> <span className="text-destructive">-{data?.deletions ?? 0}</span></>}
            </p>
          </div>
        </header>

        {status === 'conflict' && (
          <div role="alert" className="flex shrink-0 items-start gap-2 bg-destructive/10 px-4 py-2.5 text-[12px] text-destructive">
            <IconAlertTriangleFilled size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-medium">These changes no longer apply cleanly.</span> {data?.error || 'The project moved on since the run started. Nothing was overwritten — reconcile the file manually or discard the run.'}</span>
          </div>
        )}
        {status === 'missing' && (
          <div role="status" className="flex shrink-0 items-start gap-2 bg-well px-4 py-2.5 text-[12px] text-muted-foreground">
            <IconAlertTriangleFilled size={14} className="mt-0.5 shrink-0" />
            This worktree is gone from disk, so its changes can no longer be reviewed or applied.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {changesQuery.isPending ? (
            <div className="grid h-40 place-items-center text-muted-foreground"><IconLoader2 size={20} className="animate-spin" /></div>
          ) : changesQuery.isError ? (
            <div className="grid h-40 place-items-center p-6 text-center">
              <p className="max-w-sm text-[13px] text-destructive">{changesQuery.error.message}</p>
            </div>
          ) : !files.length ? (
            <div className="grid h-40 place-items-center p-6 text-center">
              <p className="max-w-sm text-[13px] text-muted-foreground">
                {status === 'applied' ? 'These changes were applied to the project.'
                  : status === 'discarded' ? 'These changes were discarded.'
                    : 'This run made no file changes. Read-only runs run without a worktree.'}
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {files.map((file) => {
                  const fileStatus = statuses[file.path] || 'modified';
                  return (
                    <li key={file.path} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                      <span className={cn('shrink-0 font-medium uppercase tracking-wide', FILE_TONE[fileStatus])}>{fileStatus.slice(0, 3)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span>
                      {file.binary
                        ? <span className="shrink-0 text-muted-foreground">binary</span>
                        : <>
                          <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                          <span className="shrink-0 tabular-nums text-destructive">-{file.deletions}</span>
                        </>}
                    </li>
                  );
                })}
              </ul>

              <div className="border-t border-border px-4 py-2">
                <button
                  type="button"
                  onClick={() => setWantPatch((value) => !value)}
                  className="cursor-pointer rounded-full px-3 py-1 text-[12px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                >
                  {wantPatch ? 'Hide diff' : 'Show diff'}
                </button>
              </div>

              {wantPatch && (
                changesQuery.isFetching && !patch ? (
                  <div className="grid place-items-center py-8 text-muted-foreground"><IconLoader2 size={18} className="animate-spin" /></div>
                ) : (
                  <pre className="wb-scroll max-h-[45vh] overflow-auto border-t border-border bg-well px-3 py-2 font-mono text-[11.5px]/5">
                    {patch.split('\n').map((line, index) => (
                      <div key={index} className={cn('whitespace-pre', patchLineClass(line))}>{line || ' '}</div>
                    ))}
                  </pre>
                )
              )}
            </>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          {runActive && <span className="text-[11px] text-muted-foreground">Wait for the run to finish before applying or discarding.</span>}
          {!runId && !runActive && files.length > 0 && <span className="text-[11px] text-muted-foreground">Open this from the Run card to apply or discard.</span>}
          <div className="ml-auto flex items-center gap-2">
            {confirmDiscard ? (
              <>
                <span className="text-[12px] text-muted-foreground">Discard these changes?</span>
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(false)}
                  className="cursor-pointer rounded-full px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => discard.mutate()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-destructive px-3.5 py-1.5 text-[13px] font-medium text-white transition-[background-color,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:opacity-40"
                >
                  {discard.isPending && <IconLoader2 size={13} className="animate-spin" />}
                  Discard
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={() => setConfirmDiscard(true)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 disabled:opacity-40"
              >
                <IconTrash size={14} />
                Discard
              </button>
            )}
            <button
              type="button"
              disabled={actionsDisabled}
              onClick={() => apply.mutate()}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:opacity-40"
            >
              {apply.isPending ? <IconLoader2 size={13} className="animate-spin" /> : <IconGitPullRequest size={14} />}
              Apply / Merge
            </button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
