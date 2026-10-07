import { useEffect, useMemo, useState } from 'react';
import {
  IconAlertTriangleFilled,
  IconBan,
  IconCircleCheck,
  IconCircleX,
  IconFileDiff,
  IconListCheck,
  IconPlayerPause,
} from '@tabler/icons-react';
import { classifyPart, isToolPart } from '@/components/whirl/thread/tool-data';
import { DotsRing } from '@/components/loading-ui/dots-ring';
import { formatDuration } from '@/lib/format';
import type { ActiveRun, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

/* Control-plane run health. Extra fields (todos, currentAction, eta) are
   additive — the card degrades gracefully until the backend fills them. */
interface RunTodo { id?: string; text?: string; status?: string }
interface RunExtras {
  todos?: RunTodo[];
  currentAction?: string | { kind?: string; title?: string; summary?: string };
  etaLow?: number;
  etaHigh?: number;
  eta?: number | { low?: number; high?: number };
  worktreeId?: string | null;
}
type Run = ActiveRun & RunExtras;

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting', 'waiting_for_user', 'waiting_for_permission', 'stopping', 'interrupting']);
const COMPLETE = new Set(['succeeded', 'completed']);

function statusInfo(status: string) {
  const value = (status || '').toLowerCase();
  if (value === 'queued') return { label: 'Queued', tone: 'muted' as const };
  if (value === 'waiting' || value === 'waiting_for_user') return { label: 'Waiting for input', tone: 'attention' as const };
  if (value === 'waiting_for_permission') return { label: 'Permission required', tone: 'attention' as const };
  if (value === 'stopping' || value === 'interrupting') return { label: 'Stopping', tone: 'muted' as const };
  if (COMPLETE.has(value)) return { label: 'Completed', tone: 'ok' as const };
  if (value === 'failed' || value === 'uncertain') return { label: 'Failed', tone: 'error' as const };
  if (value === 'cancelled') return { label: 'Cancelled', tone: 'muted' as const };
  if (value === 'interrupted' || value === 'interrupted_by_restart') return { label: 'Interrupted', tone: 'error' as const };
  return { label: 'Working', tone: 'active' as const };
}

function isDoneTodo(todo: RunTodo) {
  return ['done', 'completed', 'succeeded'].includes(String(todo.status || '').toLowerCase());
}

function currentActionOf(run: Run, session: Session) {
  const action = run.currentAction;
  if (typeof action === 'string') return action;
  if (action) return action.summary || action.title || action.kind || '';
  const messages = session.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parts = messages[index].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (!isToolPart(part)) continue;
      const view = classifyPart(part);
      const title = 'title' in view ? view.title : '';
      if (title) return title;
      if (part.state?.title) return part.state.title;
      if (part.tool) return part.tool;
    }
  }
  return '';
}

function etaRange(run: Run, elapsedMs: number, todos: RunTodo[] | undefined) {
  let low: number | undefined;
  let high: number | undefined;
  if (typeof run.eta === 'number') {
    low = run.eta;
    high = run.eta;
  } else if (run.eta && typeof run.eta === 'object') {
    low = run.eta.low;
    high = run.eta.high;
  }
  low = low ?? run.etaLow;
  high = high ?? run.etaHigh;
  if (low !== undefined || high !== undefined) return { low: low ?? high ?? 0, high: high ?? low ?? 0 };
  const total = todos?.length || 0;
  const done = todos?.filter(isDoneTodo).length || 0;
  if (total > 0 && done > 0 && elapsedMs > 0) {
    const remaining = (elapsedMs / done) * (total - done);
    return { low: remaining * 0.7, high: remaining * 1.4 };
  }
  return null;
}

function formatEta(lowMs: number, highMs: number) {
  const toMinutes = (value: number) => Math.max(1, Math.round(value / 60000));
  const low = toMinutes(lowMs);
  const high = toMinutes(highMs);
  if (high < 60) return low >= high ? `~${low} min` : `~${low}–${high} min`;
  const roundHours = (minutes: number) => Math.max(1, Math.round(minutes / 60));
  const lowH = roundHours(low);
  const highH = roundHours(high);
  return lowH >= highH ? `~${lowH} h` : `~${lowH}–${highH} h`;
}

/** Compact run card shown above the composer while a Run is alive. */
export function RunSummary({ session, run, onViewChanges }: {
  session: Session;
  run: ActiveRun;
  /* Stop lives on the composer pill; kept optional for the frozen call site. */
  onStop?: () => void;
  onInterrupt?: () => void;
  onViewChanges?: (runId: string, active: boolean) => void;
}) {
  const extended = run as Run;
  const todos = extended.todos?.length ? extended.todos : session.todos;
  const active = ACTIVE.has((run.status || '').toLowerCase());
  const [now, setNow] = useState(() => Date.now());
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, run.id]);

  /* A finished Run reports its outcome once, then the summary yields the
     composer back to the conversation. */
  useEffect(() => {
    if (active) { setExpired(false); return; }
    const ended = run.ended || Date.now();
    const remaining = 20_000 - (Date.now() - ended);
    if (remaining <= 0) { setExpired(true); return; }
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [active, run.ended, run.id]);

  /* Hooks must run on every render: compute `action` before the early return
     so an expired card never changes the hook count (Rules of Hooks). */
  const action = useMemo(() => currentActionOf(extended, session), [extended, session]);

  if (expired) return null;

  const elapsedMs = run.started ? Math.max(0, (run.ended || now) - run.started) : 0;
  const info = statusInfo(run.status);
  const done = todos?.filter(isDoneTodo).length || 0;
  const total = todos?.length || 0;
  const eta = active ? etaRange(extended, elapsedMs, todos) : null;

  const tone = info.tone;

  return (
    <div
      role="status"
      className={cn(
        'mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-3xl border border-[var(--well-outline)] bg-(--well-translucent) px-3.5 py-2 text-[12px] backdrop-blur-xl',
        tone === 'error' && 'text-destructive',
        tone === 'attention' && 'text-amber-700 dark:text-amber-300',
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5 font-medium">
        <StatusGlyph tone={tone} />
        {info.label}
      </span>

      {total > 0 && (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <IconListCheck size={13} />
          <span className="tabular-nums text-foreground/90">{done} / {total}</span>
          <span>tasks complete</span>
        </span>
      )}

      {action ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
          <span className="truncate">{action}</span>
        </span>
      ) : active ? (
        <span className="min-w-0 flex-1" aria-hidden="true" />
      ) : null}

      {elapsedMs > 0 && (
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{formatDuration(elapsedMs / 1000)}</span>
      )}

      {eta && (
        <span className="shrink-0 tabular-nums text-muted-foreground" title="Rough estimate">{formatEta(eta.low, eta.high)}</span>
      )}

      {onViewChanges && (extended.worktreeId || !active) && (
        <button
          type="button"
          onClick={() => onViewChanges(run.id, active)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <IconFileDiff size={12} />
          Changes
        </button>
      )}
    </div>
  );
}

function StatusGlyph({ tone }: { tone: 'active' | 'attention' | 'ok' | 'error' | 'muted' }) {
  if (tone === 'active') return <DotsRing className="size-3.5 text-foreground" aria-hidden="true" />;
  if (tone === 'attention') return <IconAlertTriangleFilled size={13} className="shrink-0" />;
  if (tone === 'ok') return <IconCircleCheck size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />;
  if (tone === 'error') return <IconCircleX size={13} className="shrink-0" />;
  if (tone.startsWith('muted')) return <IconPlayerPause size={13} className="shrink-0 text-muted-foreground" />;
  return <IconBan size={13} className="shrink-0 text-muted-foreground" />;
}
