import { useEffect, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconGitCommit, IconLoader2, IconPlayerStopFilled, IconRefresh } from '@tabler/icons-react';
import { mutate, v2 } from '@/lib/workbench';
import type { Session } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Changes { files: { path: string; additions: number; deletions: number; untracked?: boolean }[]; at?: number }

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting', 'stopping']);
const RETRYABLE = new Set(['failed', 'interrupted', 'uncertain', 'cancelled']);

function elapsedLabel(started?: number | null, ended?: number | null) {
  if (!started) return '';
  const seconds = Math.max(0, Math.round(((ended || Date.now()) - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/* One honest line about the current turn: what is running, on which model,
   for how long, what changed — and the actions that make sense right now. */
export function RunCard({ session, onStop, onToast }: { session: Session; onStop: () => void; onToast: (message: string, error?: boolean) => void }) {
  const run = session.activeRun;
  const [, forceRender] = useReducer((value: number) => value + 1, 0);
  const active = Boolean(run && ACTIVE.has(run.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => forceRender(), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const changes = useQuery({
    queryKey: ['changes', run?.id],
    queryFn: () => v2<{ artifact: Changes }>(`/artifacts/changes_${run!.id}`),
    enabled: Boolean(run && (run.status === 'succeeded' || run.status === 'failed')),
    retry: false,
    staleTime: 60000,
  });

  if (!run) {
    if (!session.paused && !session.queued?.length) return null;
    return (
      <div className="mb-2 flex items-center gap-2 rounded-xl bg-well px-3 py-2 text-xs text-muted-foreground">
        <span>{session.paused ? 'Queue paused.' : 'Waiting in queue.'}</span>
        {session.paused && (
          <button className="font-medium text-foreground underline" onClick={() => void mutate(`/conversations/${session.id}/resume`, {}).catch((error) => onToast(error.message, true))}>
            Resume
          </button>
        )}
      </div>
    );
  }

  const label = run.status === 'running' ? 'Working'
    : run.status === 'waiting' ? 'Needs your input'
    : run.status === 'stopping' ? 'Stopping'
    : run.status === 'queued' || run.status === 'starting' ? 'Starting'
    : run.status === 'failed' ? 'Failed'
    : run.status === 'interrupted' ? 'Interrupted'
    : run.status === 'uncertain' ? 'Unconfirmed'
    : run.status === 'cancelled' ? 'Stopped'
    : 'Finished';
  const shortModel = run.model?.split('/').slice(1).join('/');
  const files = changes.data?.artifact?.files || [];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className={cn('mb-2 space-y-1.5', run.status === 'failed' && 'text-destructive')}>
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-well px-3 py-2 text-xs">
        {active && <IconLoader2 size={13} className="animate-spin text-muted-foreground" />}
        {run.status === 'failed' && <IconAlertTriangle size={13} />}
        <span className="font-medium">{label}</span>
        {run.status === 'failed' && run.error && <span className="min-w-0 max-w-72 truncate text-[11px]" title={run.error}>{run.error}</span>}
        {run.status === 'uncertain' && <span className="text-[11px] text-muted-foreground">The message may not have reached the agent. Check the transcript before retrying.</span>}
        {shortModel && <span className="text-[10px] text-muted-foreground">{shortModel}</span>}
        {run.started && <span className="text-[10px] text-muted-foreground tabular-nums">{elapsedLabel(run.started, run.ended)}</span>}
        <span className="ml-auto flex items-center gap-1">
          {active && (
            <button className="grid size-7 place-items-center rounded-full bg-well ring-1 ring-border hover:bg-accent" aria-label="Stop" onClick={onStop}>
              <IconPlayerStopFilled size={12} />
            </button>
          )}
          {RETRYABLE.has(run.status) && (
            <button
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-medium text-foreground underline"
              onClick={() => void mutate(`/commands/${run.id}/retry`, {}).then(() => onToast('Retrying with the same message.')).catch((error) => onToast(error.message, true))}
            >
              <IconRefresh size={12} /> Retry
            </button>
          )}
        </span>
      </div>
      {files.length > 0 && (
        <details className="rounded-xl bg-well px-3 py-2 text-xs">
          <summary className="flex cursor-pointer items-center gap-2 text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
            <IconGitCommit size={13} />
            <span className="font-medium text-foreground">{files.length} file{files.length === 1 ? '' : 's'} changed</span>
            <span className="tabular-nums text-emerald-600 dark:text-emerald-400">+{additions}</span>
            <span className="tabular-nums text-destructive">−{deletions}</span>
          </summary>
          <ul className="mt-2 space-y-1">
            {files.map((file) => (
              <li key={file.path} className="flex items-center gap-2 font-mono text-[11px]">
                <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
                {file.untracked && <span className="text-[9px] text-muted-foreground">new</span>}
                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                <span className="tabular-nums text-destructive">−{file.deletions}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
