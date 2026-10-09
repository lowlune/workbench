import { IconChevronRight, IconLoader2, IconTool } from '@tabler/icons-react';
import { ToolRenderer } from '@/components/whirl/thread/tool-cards';
import { classifyPart } from '@/components/whirl/thread/tool-data';
import type { FileRef } from '@/components/whirl/file-viewer';
import type { MessagePart } from '@/lib/types';

type OpenFile = (file: FileRef) => void;

/** One tool call rendered by kind (file change, command, test, git, …). */
export function ToolCard({ part, onOpenFile }: { part: MessagePart; onOpenFile?: OpenFile }) {
  return <ToolRenderer view={classifyPart(part)} onOpenFile={onOpenFile} />;
}

/* A run of tool calls. One call renders as itself; several collapse into a
   single quiet row that shows only the count — the details open on click.
   Hover is just a fine dotted underline, never a full-width fill. */
export function ToolActivity({ tools, onOpenFile }: { tools: MessagePart[]; onOpenFile?: OpenFile }) {
  if (!tools.length) return null;
  if (tools.length === 1) {
    return <ToolRenderer view={classifyPart(tools[0])} onOpenFile={onOpenFile} />;
  }
  const active = tools.some((part) => ['running', 'pending', 'starting'].includes(String(part.state?.status || '')));
  return (
    <details className="wb-disclosure group/activity w-full min-w-0">
      <summary className="tool-row flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
        {active
          ? <IconLoader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />
          : <IconTool size={13} className="shrink-0 text-muted-foreground/70" aria-hidden="true" />}
        <span className="shrink-0">tool calls</span>
        <span className="tabular-nums">{tools.length}</span>
        <IconChevronRight size={12} className="shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/activity:rotate-90" />
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {tools.map((part) => <ToolRenderer key={part.id} view={classifyPart(part)} onOpenFile={onOpenFile} />)}
      </div>
    </details>
  );
}
