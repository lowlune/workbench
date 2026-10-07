import { useMemo } from 'react';
import { IconChecklist, IconCircleCheck, IconCircleDashed, IconCircleX, IconLoader2 } from '@tabler/icons-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Todo } from '@/lib/types';
import { cn } from '@/lib/utils';

/* The agent's task list, surfaced top-right over the transcript so a spawned
   plan is actually visible (and readable in full) while the run unfolds. */
export function TaskListPanel({ todos }: { todos?: Todo[] }) {
  const list = useMemo(() => (todos || []).filter((todo) => todo && String(todo.text || '').trim()), [todos]);
  const done = list.filter((todo) => isComplete(todo.status)).length;
  if (!list.length) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Tasks: ${done} of ${list.length} complete`}
            className="raised inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border transition-colors duration-150 hover:bg-accent"
          >
            <IconChecklist size={14} className="text-muted-foreground" />
            <span className="tabular-nums">{done}/{list.length}</span>
            <span className="hidden sm:inline text-muted-foreground">tasks</span>
          </button>
        }
      />
      <PopoverContent side="bottom" align="end" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <IconChecklist size={15} className="shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-semibold">Tasks</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{done} / {list.length} complete</span>
        </div>
        <ul className="wb-scroll max-h-80 overflow-y-auto p-1.5">
          {list.map((todo, index) => {
            const complete = isComplete(todo.status);
            const failed = isFailed(todo.status);
            const status = String(todo.status || '').toLowerCase();
            return (
              <li key={todo.id || `${index}`} className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-[12.5px]">
                <span className={cn('mt-0.5 shrink-0', complete ? 'text-emerald-600/80 dark:text-emerald-400/80' : failed ? 'text-destructive/80' : status === 'in_progress' || status === 'running' ? 'text-foreground' : 'text-muted-foreground/50')}>
                  {complete ? <IconCircleCheck size={14} />
                    : failed ? <IconCircleX size={14} />
                      : status === 'in_progress' || status === 'running' ? <IconLoader2 size={14} className="animate-spin" />
                        : <IconCircleDashed size={14} />}
                </span>
                <span className={cn('min-w-0 break-words', complete && 'text-muted-foreground/70 line-through')}>{todo.text}</span>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function isComplete(status?: string) {
  return ['done', 'completed', 'succeeded'].includes(String(status || '').toLowerCase());
}

function isFailed(status?: string) {
  return ['failed', 'cancelled', 'error'].includes(String(status || '').toLowerCase());
}
