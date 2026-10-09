import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconChevronDown, IconClock, IconSearch, IconStar, IconStarFilled } from '@tabler/icons-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatTokens } from '@/lib/format';
import { mutate, offerings, recentModels, rememberModel } from '@/lib/workbench';
import type { Engine, Offering, Project, Session } from '@/lib/types';
import { cn, shortDirectory } from '@/lib/utils';

/* One model picker for the whole app — Home, Usage and the chat composer all
   render this component, so search, recents, the default star and the
   connection grouping can never drift between surfaces. */
export function ModelSelect({
  engine,
  value,
  onChange,
  onToast,
  session,
  project,
  context,
  directory,
  tags,
  liveAgent = false,
  compact = false,
  align = 'end',
}: {
  engine: Engine;
  value?: string | null;
  onChange: (model: string) => void;
  onToast: (text: string, error?: boolean) => void;
  session?: Session;
  project?: Project;
  context?: { used: number; limit: number; percent: number };
  directory?: string;
  tags?: string[];
  liveAgent?: boolean;
  compact?: boolean;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => recentModels(engine));
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['model-offerings'], queryFn: offerings, staleTime: 60_000, refetchInterval: (q) => (q.state.data?.refreshing ? 2000 : false) });
  const data = query.data;
  const models = useMemo(() => (data?.models || []).filter((model) => model.engine === engine), [data, engine]);
  const available = useMemo(() => models.filter((model) => model.available !== false), [models]);
  const unavailable = useMemo(() => models.filter((model) => model.available === false), [models]);
  const selected = models.find((model) => model.id === value);
  const defaultId = data?.defaults?.[engine] || null;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return available;
    return available.filter((model) => `${model.name} ${model.id} ${model.connectionLabel || model.provider} ${model.planLabel || ''}`.toLowerCase().includes(needle));
  }, [available, search]);
  const recentList = useMemo(() => recents.map((id) => filtered.find((model) => model.id === id)).filter((model): model is Offering => Boolean(model)), [recents, filtered]);
  const groups = useMemo(() => {
    const byConnection = new Map<string, Offering[]>();
    for (const model of filtered) {
      const key = model.connectionId || model.provider;
      if (!byConnection.has(key)) byConnection.set(key, []);
      byConnection.get(key)!.push(model);
    }
    return [...byConnection.entries()];
  }, [filtered]);

  async function choose(model: Offering) {
    if (session && engine === 'pi') {
      try {
        const nextLevels = model.thinkingLevels || (model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['off']);
        const thinkingLevel = nextLevels.includes(session.thinkingLevel || 'off') ? (session.thinkingLevel || 'off') : 'off';
        await mutate(`/conversations/${encodeURIComponent(session.id)}`, { model: model.id, thinkingLevel });
        await client.invalidateQueries({ queryKey: ['session', session.id] });
      } catch (error) {
        onToast((error as Error).message, true);
        return;
      }
    }
    rememberModel(engine, model.id);
    setRecents(recentModels(engine));
    onChange(model.id);
    setOpen(false);
  }

  function setDefault(model: Offering) {
    void mutate('/settings', { defaultModel: model.id, engine })
      .then(() => Promise.all([
        client.invalidateQueries({ queryKey: ['model-offerings'] }),
        client.invalidateQueries({ queryKey: ['bootstrap'] }),
      ]))
      .then(() => onToast(`${engine === 'pi' ? 'Pi' : 'OpenCode'} default set to ${model.name}.`))
      .catch((error) => onToast((error as Error).message, true));
  }

  function setProjectDefault() {
    if (!project || !selected) return;
    void mutate(`/projects/${project.id}`, { model: selected.id, engine })
      .then(() => client.invalidateQueries({ queryKey: ['model-offerings'] }))
      .then(() => onToast(`Default for ${project.name} updated.`))
      .catch((error) => onToast((error as Error).message, true));
  }

  function option(model: Offering) {
    const isDefault = defaultId === model.id;
    return (
      <div key={`${model.engine}:${model.id}`} className="flex items-center rounded-md hover:bg-accent active:bg-(--accent-pressed)">
        <button
          role="option"
          aria-selected={value === model.id}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
          onClick={() => choose(model)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{model.name}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {model.connectionLabel || model.provider}
              {model.planLabel ? ` · ${model.planLabel}` : ''}
              {model.contextLimit ? ` · ${formatTokens(model.contextLimit)} context` : ''}
              {model.images ? ' · Vision' : ''}
              {model.reasoning ? ' · Reasoning' : ''}
              {model.stale ? ' · cached' : ''}
            </span>
          </span>
          {value === model.id && <IconCheck size={14} className="shrink-0" />}
        </button>
        <button
          type="button"
          aria-label={isDefault ? `${model.name} is the ${engine === 'pi' ? 'Pi' : 'OpenCode'} default` : `Set ${model.name} as the ${engine === 'pi' ? 'Pi' : 'OpenCode'} default`}
          title={isDefault ? `${engine === 'pi' ? 'Pi' : 'OpenCode'} default` : `Set as ${engine === 'pi' ? 'Pi' : 'OpenCode'} default`}
          className={cn('shrink-0 p-2 transition-colors', isDefault ? 'text-amber-500' : 'text-muted-foreground hover:text-foreground')}
          onClick={() => { if (!isDefault) setDefault(model); }}
        >
          {isDefault ? <IconStarFilled size={14} /> : <IconStar size={14} />}
        </button>
      </div>
    );
  }

  function section(label: string, icon: ReactNode, list: Offering[], key?: string) {
    if (!list.length) return null;
    return (
      <div key={key || label}>
        <p className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{icon}{label}</p>
        {list.map(option)}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setSearch(''); setShowUnavailable(false); } }}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Choose model"
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 rounded-full transition-[background-color,scale] duration-150 hover:bg-accent active:scale-[0.98]',
              compact
                ? 'h-7 max-w-52 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground'
                : 'raised h-8 max-w-72 bg-well px-3 text-[12px] ring-1 ring-border',
              session && !compact && 'max-w-56',
            )}
          />
        }
      >
        <span className="truncate">{selected?.name || (value ? value.split('/').slice(1).join('/') : 'Choose model')}</span>
        {selected?.authKind === 'subscription' && !compact && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] text-muted-foreground">Plan</span>}
        <IconChevronDown size={13} className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        side={compact ? 'top' : 'bottom'}
        align={align}
        className="w-[min(26rem,calc(100vw-2rem))] p-0"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { setOpen(false); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
          const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]'));
          if (!options.length) return;
          const current = options.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'Enter') { if (current >= 0) { event.preventDefault(); options[current].click(); } return; }
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
          event.preventDefault();
          options[index].focus();
          options[index].scrollIntoView({ block: 'nearest' });
        }}
      >
        {(context || directory || (tags && tags.length)) && (
          <div className="border-b border-border px-3 py-2.5">
            {(directory || context) && (
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="truncate">{shortDirectory(directory)}</span>
                {context && context.limit > 0 && <span className="shrink-0 tabular-nums">{formatTokens(context.used)} / {formatTokens(context.limit)}</span>}
              </div>
            )}
            {context && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full w-full origin-left rounded-full bg-foreground transition-transform duration-500 ease-out', context.percent >= 90 && 'bg-destructive')} style={{ transform: `scaleX(${context.limit > 0 ? Math.min(1, Math.max(0, context.percent / 100)) : 0})` }} />
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">Context {context.percent}%</span>
              </div>
            )}
            {tags && tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-well px-2 py-0.5 text-[10px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--well-outline)]">{tag}</span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-border px-3">
          <IconSearch size={14} className="shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models, connections…"
            aria-label="Search models"
            className="h-9 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="wb-scroll max-h-80 overflow-y-auto p-1" role="listbox" aria-label={`${engine} models`}>
          {!search && section('Recent', <IconClock size={11} />, recentList, 'recent')}
          {!search && section('Default', <IconStarFilled size={11} />, filtered.filter((model) => model.id === defaultId), 'default')}
          {groups.map(([connectionId, list]) => section(list[0]?.connectionLabel || connectionId, null, list, connectionId))}
          {!filtered.length && (
            <p className="p-4 text-sm text-muted-foreground">
              {query.isPending || data?.refreshing ? 'Loading connected models…' : available.length ? 'No model matches that search.' : 'No connected models. Add a connection in Usage & models.'}
            </p>
          )}
          {unavailable.length > 0 && (
            <div className="border-t border-border">
              <button type="button" className="w-full px-3 py-2 text-left text-[11px] text-muted-foreground" onClick={() => setShowUnavailable((current) => !current)}>
                {showUnavailable ? 'Hide' : 'Show'} unavailable ({unavailable.length})
              </button>
              {showUnavailable && unavailable.filter((model) => !search || `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase())).map((model) => (
                <div key={model.id} className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  <span className="truncate text-[10px]">{model.unavailableReason || (model.stale ? 'cached catalog' : 'unavailable')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {session && engine === 'pi' && selected && (selected.thinkingLevels || (selected.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['off'])).length > 1 && (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <label htmlFor={`thinking-${session.id}`} className="shrink-0 text-[11px] text-muted-foreground">Reasoning</label>
            <select
              id={`thinking-${session.id}`}
              aria-label="Reasoning level"
              value={session.thinkingLevel || 'off'}
              disabled={thinkingBusy}
              onChange={(event) => {
                const thinkingLevel = event.target.value;
                setThinkingBusy(true);
                void mutate(`/conversations/${encodeURIComponent(session.id)}`, { thinkingLevel })
                  .then(() => client.invalidateQueries({ queryKey: ['session', session.id] }))
                  .catch((error) => onToast((error as Error).message, true))
                  .finally(() => setThinkingBusy(false));
              }}
              className="min-w-0 flex-1 rounded-md bg-background px-2 py-1 text-[11px] disabled:opacity-50"
            >
              {(selected.thinkingLevels || ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).map((level) => <option key={level} value={level}>{level === 'max' ? 'Max' : level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1)}</option>)}
            </select>
          </div>
        )}
        {liveAgent && (
          <p className="border-t border-border px-3 py-2 text-[11px]/4 text-muted-foreground">
            The running turn keeps its model — your choice applies from the next one.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1 border-t border-border p-2 text-[11px]">
          {data?.error && <span className="mr-auto max-w-40 truncate text-destructive" title={data.error}>Catalog: {data.error}</span>}
          {!data?.error && <span className="mr-auto text-muted-foreground">{defaultId ? '★ marks the default' : 'Tap ★ to set a default'}</span>}
          {value && project && <button type="button" className="rounded-md px-2 py-1 hover:bg-accent" onClick={setProjectDefault}>Default for {project.name}</button>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
