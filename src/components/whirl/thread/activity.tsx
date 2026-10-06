import { IconChevronRight, IconSparkles, IconTool } from '@tabler/icons-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { v2 } from '@/lib/workbench';
import type { MessagePart } from '@/lib/types';
import { cn } from '@/lib/utils';

/* One tool call inside an activity run: a quiet row that expands into the
   raw output. Wears the same well treatment as the composer. */
export function ToolCard({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false);
  const artifact = useQuery({ queryKey: ['artifact', part.artifactId], queryFn: () => v2<{ artifact: { input?: unknown; output?: string; error?: string } }>(`/artifacts/${part.artifactId}`), enabled: open && !!part.artifactId, staleTime: 30000 });
  const state = part.state || {};
  const details = artifact.data?.artifact || state;
  const output = details.error || details.output || (details.input ? JSON.stringify(details.input, null, 2) : '');
  const status = state.status || 'done';
  return (
    <details onToggle={event => setOpen(event.currentTarget.open)} className="group/tool overflow-hidden rounded-xl bg-well shadow-[inset_0_0_0_1px_var(--well-outline)]">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-[13px] marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="grid size-5 shrink-0 place-items-center text-muted-foreground"><IconTool size={13} /></span>
        <span className="shrink-0 font-medium">{part.tool || 'Tool'}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{state.title || ''}</span>
        <span className={cn(
          'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] capitalize',
          status === 'error' ? 'bg-destructive/10 text-destructive'
            : status === 'running' || status === 'pending' ? 'text-foreground'
              : 'text-muted-foreground',
        )}>{status}</span>
        {output && <IconChevronRight size={13} className="shrink-0 text-muted-foreground transition-transform duration-150 group-open/tool:rotate-90" />}
      </summary>
      {open && (output || artifact.isPending || artifact.isError) && (
        <pre className="wb-scroll max-h-72 overflow-auto border-t border-[var(--well-outline)] px-3 py-2.5 font-mono text-[11px]/5 whitespace-pre-wrap break-words text-muted-foreground">
          {artifact.isError ? artifact.error.message : output || 'Loading details…'}
        </pre>
      )}
    </details>
  );
}

/* The collapsed run of work behind a reply — Whirl's PhaseActivity, fed by
   Workbench tool parts. Opens itself while the agent is still working. */
export function ToolActivity({ tools, running }: { tools: MessagePart[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const runningTool = tools.some((part) => ['running', 'pending'].includes(part.state?.status || ''));
  const active = running || runningTool;
  const label = active
    ? (runningTool ? 'Using tools' : 'Thinking')
    : tools.length
      ? `Completed ${tools.length} action${tools.length === 1 ? '' : 's'}`
      : 'Task progress';
  return (
    <details className="group/activity w-full min-w-0" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-full px-2.5 text-[13px] text-muted-foreground transition-colors duration-150 marker:hidden hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className={cn('grid size-5 place-items-center', active && 'text-foreground')}>
          {active ? <IconSparkles size={14} /> : <IconTool size={14} />}
        </span>
        <span className="font-medium">{label}</span>
        {active && <span className="size-1.5 animate-pulse rounded-full bg-foreground/60" aria-hidden="true" />}
        <IconChevronRight size={13} className="transition-transform duration-150 group-open/activity:rotate-90" />
      </summary>
      {open && <div className="mt-1.5 space-y-1.5">
        {tools.length > 0
          ? tools.map((part) => <ToolCard key={part.id} part={part} />)
          : <p className="px-1 text-[13px]/5 text-muted-foreground">{active ? 'The agent is working through your request. Private reasoning is not displayed.' : 'Progress details are not available for this step.'}</p>}
      </div>}
    </details>
  );
}
