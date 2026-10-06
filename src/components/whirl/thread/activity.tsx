import { useState } from 'react';
import { IconChevronRight, IconSparkles, IconTool } from '@tabler/icons-react';
import { ToolRenderer } from '@/components/whirl/thread/tool-cards';
import { classifyPart, toolHeadline } from '@/components/whirl/thread/tool-data';
import type { FileRef } from '@/components/whirl/file-viewer';
import type { MessagePart } from '@/lib/types';
import { cn } from '@/lib/utils';

type OpenFile = (file: FileRef) => void;

/** One tool call rendered by kind (file change, command, test, git, …). */
export function ToolCard({ part, onOpenFile }: { part: MessagePart; onOpenFile?: OpenFile }) {
  return <ToolRenderer view={classifyPart(part)} onOpenFile={onOpenFile} />;
}

/* The collapsed run of work behind a reply — Whirl's PhaseActivity, fed by
   structured tool parts. Opens itself while the agent is still working. */
export function ToolActivity({ tools, running, onOpenFile }: { tools: MessagePart[]; running: boolean; onOpenFile?: OpenFile }) {
  const [open, setOpen] = useState(false);
  const runningTool = tools.some((part) => ['running', 'pending', 'starting'].includes(part.state?.status || ''));
  const active = running || runningTool;
  const latest = tools.length ? toolHeadline(classifyPart(tools[tools.length - 1])) : '';

  /* Finished short bursts read better as the actual events (changed file,
     ran command, test result) rather than a generic "completed" wrapper. */
  if (!active && tools.length > 0 && tools.length <= 5) {
    return (
      <div className="w-full min-w-0 space-y-1.5">
        {tools.map((part) => <ToolRenderer key={part.id} view={classifyPart(part)} onOpenFile={onOpenFile} />)}
      </div>
    );
  }

  const label = active
    ? (latest || (runningTool ? 'Using tools' : 'Working…'))
    : tools.length
      ? `${tools.length} actions`
      : 'Task progress';
  return (
    <details className="group/activity w-full min-w-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex h-8 w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-full px-2.5 text-[13px] text-muted-foreground transition-colors duration-150 marker:hidden hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className={cn('grid size-5 shrink-0 place-items-center', active && 'text-foreground')}>
          {active ? <IconSparkles size={14} /> : <IconTool size={14} />}
        </span>
        <span className="min-w-0 truncate font-medium">{label}</span>
        {active && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground/60" aria-hidden="true" />}
        <IconChevronRight size={13} className="shrink-0 transition-transform duration-150 group-open/activity:rotate-90" />
      </summary>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {tools.length > 0
            ? tools.map((part) => <ToolRenderer key={part.id} view={classifyPart(part)} onOpenFile={onOpenFile} />)
            : <p className="px-1 text-[13px]/5 text-muted-foreground">{active ? 'The agent is working through your request. Private reasoning is not displayed.' : 'Progress details are not available for this step.'}</p>}
        </div>
      )}
    </details>
  );
}
