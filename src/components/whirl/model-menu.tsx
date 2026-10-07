import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconLoader2, IconSearch } from '@tabler/icons-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getModels } from '@/lib/api';
import { formatTokens } from '@/lib/format';
import { cn, shortDirectory } from '@/lib/utils';

/* The model pill: opens the picker, wears the current model, and carries
   the thread's context usage (moved off the composer). */
export function ModelMenu({
  model,
  context,
  directory,
  tags,
  liveAgent,
  onSelect,
  compact = false,
}: {
  model?: string;
  context: { used: number; limit: number; percent: number };
  directory?: string;
  tags?: string[];
  liveAgent: boolean;
  onSelect: (model: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  /* Always warm: a saved preference is a raw id, and the closed pill should
     wear the friendly name, not `provider/model`. One fetch per 10 minutes. */
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: getModels,
    staleTime: 10 * 60_000,
  });
  const models = modelsQuery.data?.models || [];
  const displayName = models.find((item) => item.id === model)?.name || model;
  const needle = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = needle
      ? models.filter((item) => item.id.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle))
      : models;
    return list.slice(0, 100);
  }, [models, needle]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Change model"
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 rounded-full transition-colors duration-150 hover:bg-accent',
              compact
                ? 'h-7 max-w-52 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground'
                : 'raised h-8 max-w-60 bg-(--popover-translucent) px-3 text-[12px] font-medium backdrop-blur-sm ring-1 ring-border',
            )}
          >
            <span className="truncate">{displayName || 'Choose model'}</span>
          </button>
        }
      />
      <PopoverContent side={compact ? 'top' : 'bottom'} align="end" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{shortDirectory(directory)}</span>
            {context.limit > 0 && (
              <span className="shrink-0 tabular-nums">{formatTokens(context.used)} / {formatTokens(context.limit)}</span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full bg-foreground transition-[width] duration-500', context.percent >= 90 && 'bg-destructive')}
                style={{ width: `${context.limit > 0 ? context.percent : 0}%` }}
              />
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">Context {context.percent}%</span>
          </div>
          {tags && tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.map((tag) => (
                <span key={tag} className="rounded-full bg-well px-2 py-0.5 text-[10px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--well-outline)]">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <IconSearch size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models…"
            aria-label="Search models"
            className="h-9 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="wb-scroll max-h-72 overflow-y-auto p-1">
          {modelsQuery.isPending ? (
            <div className="grid place-items-center py-8 text-muted-foreground"><IconLoader2 size={16} className="animate-spin" /></div>
          ) : modelsQuery.isError ? (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">{modelsQuery.error.message}</p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">No models match.</p>
          ) : (
            filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSelect(item.id);
                }}
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-75 hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{item.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{item.id}</span>
                </span>
                {item.id === model && <IconCheck size={14} className="shrink-0" />}
              </button>
            ))
          )}
        </div>
        {liveAgent && (
          <p className="border-t border-border px-3 py-2 text-[11px]/4 text-muted-foreground">
            The running turn keeps its model — your choice applies from the next one.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
