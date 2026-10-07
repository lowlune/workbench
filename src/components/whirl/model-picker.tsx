import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconChevronDown, IconClock, IconStar, IconStarFilled } from '@tabler/icons-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatTokens } from '@/lib/format';
import { mutate, offerings, recentModels, rememberModel } from '@/lib/workbench';
import type { Engine, Offering, Project, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

/* The universal model picker: one component for Home and chat. Models are
   grouped by connection (plan vs API key), searched, favorited and marked
   as defaults. The active model for a running turn is always captured on
   the command, so changing here only affects what runs next. */
export function ModelPicker({
  engine,
  value,
  session,
  project,
  onChange,
  onToast,
  align = 'end',
}: {
  engine: Engine;
  value?: string | null;
  session?: Session;
  project?: Project;
  onChange: (model: string) => void;
  onToast: (text: string, error?: boolean) => void;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => recentModels(engine));
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['model-offerings'], queryFn: offerings, staleTime: 60000, refetchInterval: (q) => q.state.data?.refreshing ? 2000 : false });
  const data = query.data;
  const favorites = data?.favorites || [];
  const models = useMemo(() => (data?.models || []).filter((model) => model.engine === engine), [data, engine]);
  const available = useMemo(() => models.filter((model) => model.available !== false), [models]);
  const unavailable = useMemo(() => models.filter((model) => model.available === false), [models]);
  const selected = models.find((model) => model.id === value);

  const matches = (model: Offering) => `${model.name} ${model.id} ${model.connectionLabel || model.provider} ${model.planLabel || ''}`.toLowerCase().includes(search.toLowerCase());
  const filtered = useMemo(() => available.filter(matches), [available, search]);
  const recentList = useMemo(() => recents.map((id) => filtered.find((model) => model.id === id)).filter((model): model is Offering => Boolean(model)), [recents, filtered]);
  const favoriteList = useMemo(() => filtered.filter((model) => favorites.includes(model.id)), [filtered, favorites]);
  const groups = useMemo(() => {
    const byConnection = new Map<string, Offering[]>();
    for (const model of filtered) {
      const key = model.connectionId || model.provider;
      if (!byConnection.has(key)) byConnection.set(key, []);
      byConnection.get(key)!.push(model);
    }
    return [...byConnection.entries()];
  }, [filtered]);

  async function setDefault(scope: 'user' | 'project') {
    if (!value) return;
    try {
      if (scope === 'project' && project) await mutate(`/projects/${project.id}`, { model: value, engine });
      else await mutate('/settings', { defaultModel: value, engine });
      await client.invalidateQueries({ queryKey: ['model-offerings'] });
      await client.invalidateQueries({ queryKey: ['bootstrap'] });
      onToast(scope === 'project' ? `Default for ${project?.name} updated.` : `${engine === 'pi' ? 'Pi' : 'OpenCode'} default updated.`);
    } catch (error) { onToast((error as Error).message, true); }
  }

  function choose(model: Offering) {
    rememberModel(engine, model.id);
    setRecents(recentModels(engine));
    onChange(model.id);
    setOpen(false);
  }

  function option(model: Offering) {
    const favorite = favorites.includes(model.id);
    return (
      <div key={`${model.engine}:${model.id}`} className="flex items-center rounded-md hover:bg-accent">
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
          {value === model.id && <IconCheck size={14} />}
        </button>
        <button
          aria-label={`${favorite ? 'Remove from favorites' : 'Add to favorites'} ${model.name}`}
          className="p-2 text-muted-foreground"
          onClick={() => {
            const next = favorite ? favorites.filter((id) => id !== model.id) : [...favorites, model.id];
            void mutate('/settings', { favorites: next })
              .then(() => client.invalidateQueries({ queryKey: ['model-offerings'] }))
              .catch((error) => onToast((error as Error).message, true));
          }}
        >
          {favorite ? <IconStarFilled size={14} /> : <IconStar size={14} />}
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" className={cn('raised inline-flex h-8 max-w-72 items-center gap-1.5 rounded-full bg-well px-3 text-[12px] ring-1 ring-border', session && 'max-w-56')} aria-label="Choose model" />}>
        <span className="truncate">{selected?.name || (value ? value.split('/').slice(1).join('/') : 'Choose model')}</span>
        {selected?.authKind === 'subscription' && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] text-muted-foreground">Plan</span>}
        <IconChevronDown size={13} />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[min(26rem,calc(100vw-2rem))] p-0"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { setOpen(false); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
          const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]'));
          if (!options.length) return;
          const current = options.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'Enter') {
            if (current >= 0) { event.preventDefault(); options[current].click(); }
            return;
          }
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
          event.preventDefault();
          options[index].focus();
          options[index].scrollIntoView({ block: 'nearest' });
        }}
      >
        <div className="border-b border-border p-3">
          <input autoFocus aria-label="Search models" placeholder="Search models, connections…" value={search} onChange={(event) => setSearch(event.target.value)} className="w-full bg-transparent text-sm outline-none" />
        </div>
        <div className="wb-scroll max-h-80 overflow-y-auto p-1" role="listbox" aria-label={`${engine} models`}>
          {!search && section('Recent', <IconClock size={11} />, recentList, 'recent')}
          {!search && section('Favorites', <IconStarFilled size={11} />, favoriteList, 'favorites')}
          {groups.map(([connectionId, list]) => section(list[0]?.connectionLabel || connectionId, null, list, connectionId))}
          {!filtered.length && (
            <p className="p-4 text-sm text-muted-foreground">
              {query.isPending || data?.refreshing ? 'Loading connected models…' : available.length ? 'No model matches that search.' : 'No connected models. Add a connection in Usage & models.'}
            </p>
          )}
          {unavailable.length > 0 && (
            <div className="border-t border-border">
              <button className="w-full px-3 py-2 text-left text-[11px] text-muted-foreground" onClick={() => setShowUnavailable((current) => !current)}>
                {showUnavailable ? 'Hide' : 'Show'} unavailable ({unavailable.length})
              </button>
              {showUnavailable && unavailable.filter(matches).map((model) => (
                <div key={model.id} className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  <span className="truncate text-[10px]">{model.unavailableReason || model.stale ? 'cached catalog' : 'unavailable'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 border-t border-border p-2 text-[11px]">
          {data?.error && <span className="mr-auto max-w-40 truncate text-destructive" title={data.error}>Catalog: {data.error}</span>}
          {value && <button className="ml-auto rounded-md px-2 py-1 hover:bg-accent" onClick={() => void setDefault('user')}>Set my default</button>}
          {value && project && <button className="rounded-md px-2 py-1 hover:bg-accent" onClick={() => void setDefault('project')}>Default for {project.name}</button>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
