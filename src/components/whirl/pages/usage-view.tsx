import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconExternalLink, IconRefresh, IconTrash } from '@tabler/icons-react';
import { ModelPicker } from '@/components/whirl/model-picker';
import { connections, deleteUsageLimit, mutate, offerings, saveUsageLimit, usageLimits, usagePacing, usageReport } from '@/lib/workbench';
import { formatTokens } from '@/lib/format';
import type { Connection, Engine, PacingMetric, Project, UsageBreakdown, UsageLimit, UsagePacing } from '@/lib/types';
import { cn } from '@/lib/utils';

const money = (value: number | null | undefined) => value == null ? 'Unknown' : `$${value.toFixed(value >= 1 ? 2 : 4)}`;

export default function UsageView({ projects, onToast }: { projects: Project[]; onToast: (message: string, error?: boolean) => void }) {
  const [days, setDays] = useState('30');
  const [project, setProject] = useState('');
  const [engine, setEngine] = useState('opencode');
  const [provider, setProvider] = useState('opencode-go');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState<{ url: string; instructions?: string; method: string; provider: string; authMethod: number }>();
  const [code, setCode] = useState('');
  const client = useQueryClient();

  const usage = useQuery({ queryKey: ['usage', days, project], queryFn: () => usageReport(Number(days), project || undefined), staleTime: 10000 });
  const conns = useQuery({ queryKey: ['connections'], queryFn: connections });
  const models = useQuery({ queryKey: ['model-offerings'], queryFn: offerings, staleTime: 60000 });

  async function connect() {
    setBusy(true);
    try {
      await mutate('/connections', { engine, provider, apiKey });
      setApiKey('');
      await client.invalidateQueries({ queryKey: ['connections'] });
      await client.invalidateQueries({ queryKey: ['model-offerings'] });
      onToast('Connection saved. Refreshing models…');
    } catch (error) { onToast((error as Error).message, true); } finally { setBusy(false); }
  }

  async function setDefault(next: string, forEngine: Engine) {
    try {
      await mutate('/settings', { defaultModel: next, engine: forEngine });
      await client.invalidateQueries({ queryKey: ['model-offerings'] });
      await client.invalidateQueries({ queryKey: ['bootstrap'] });
      onToast(`${forEngine === 'pi' ? 'Pi' : 'OpenCode'} default updated.`);
    } catch (error) { onToast((error as Error).message, true); }
  }

  const totals = usage.data?.totals;
  const daily = usage.data?.daily || [];
  const maxDaily = Math.max(1, ...daily.map((day) => day.requests));

  return (
    <div className="wb-scroll h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-xl font-semibold">Usage & models</h1>
        <p className="mt-1 text-sm text-muted-foreground">Recorded consumption, connection health and model defaults. Subscription value is not an invoice.</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <select aria-label="Usage period" className="rounded-full bg-well px-3 py-2 text-sm" value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="365">Last year</option>
          </select>
          <select aria-label="Usage project" className="rounded-full bg-well px-3 py-2 text-sm" value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="">All projects</option><option value="general">General</option>
            {projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </div>

        {usage.isError && <p role="alert" className="mt-3 text-sm text-destructive">{usage.error.message}</p>}

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {([
            ['Requests', String(totals?.requests || 0)],
            ['Input tokens', formatTokens(totals?.input || 0)],
            ['Output tokens', formatTokens(totals?.output || 0)],
            ['Cache read', formatTokens(totals?.cacheRead || 0)],
            ['Recorded value', money(totals?.cost)],
          ] as const).map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-well p-4">
              <p className="text-[11px] text-muted-foreground">{label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        {Boolean(totals?.unknownCost) && <p className="mt-2 text-[11px] text-muted-foreground">{totals!.unknownCost} requests have unknown cost (subscription plans or missing provider pricing).</p>}

        <LimitsPacing onToast={onToast} />

        {daily.length > 1 && (
          <div className="mt-6 rounded-2xl bg-well p-4">
            <div className="flex items-end justify-between"><h2 className="text-sm font-medium">Daily requests</h2><span className="text-[11px] text-muted-foreground">{daily[0].day} → {daily.at(-1)!.day}</span></div>
            <div className="mt-3 flex h-16 items-end gap-px" role="img" aria-label="Daily request chart">
              {daily.map((day) => (
                <div key={day.day} title={`${day.day}: ${day.requests} requests, ${formatTokens(day.output)} output`} className="min-w-px flex-1 rounded-t bg-foreground/25 transition-colors hover:bg-foreground/50" style={{ height: `${Math.max(3, Math.round((day.requests / maxDaily) * 64))}px` }} />
              ))}
            </div>
          </div>
        )}

        <h2 className="mt-8 text-sm font-semibold">By model</h2>
        <div className="mt-3 overflow-auto rounded-xl bg-well">
          <table className="w-full text-left text-xs">
            <thead><tr className="text-muted-foreground"><th className="p-3">Model / connection</th><th className="p-3">Engine</th><th className="p-3">Requests</th><th className="p-3">Input / output</th><th className="p-3">Value</th></tr></thead>
            <tbody>
              {usage.data?.byModel.map((model: UsageBreakdown) => (
                <tr key={`${model.engine}:${model.provider}/${model.model}`} className="border-t border-border">
                  <td className="p-3">{model.model}<span className="block text-muted-foreground">{model.provider}</span></td>
                  <td className="p-3">{model.engine}</td>
                  <td className="p-3 tabular-nums">{model.requests}</td>
                  <td className="p-3 tabular-nums">{formatTokens(model.input)} / {formatTokens(model.output)}</td>
                  <td className="p-3 tabular-nums">{money(model.cost)}{model.unknownCost ? <span className="block text-[10px] text-muted-foreground">{model.unknownCost} unknown</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!usage.data?.byModel.length && <p className="p-4 text-xs text-muted-foreground">No usage recorded in this period.</p>}
        </div>

        <h2 className="mt-8 text-sm font-semibold">By project</h2>
        <div className="mt-2 space-y-2">
          {usage.data?.byProject.map((item: UsageBreakdown) => (
            <div key={item.projectId || 'general'} className="flex justify-between rounded-xl bg-well p-3 text-xs">
              <span>{item.label}</span>
              <span className="tabular-nums">{item.requests} requests · {formatTokens(item.output)} output · {money(item.cost)}</span>
            </div>
          ))}
        </div>

        <h2 className="mt-8 text-sm font-semibold">Connections</h2>
        <p className="mt-1 text-xs text-muted-foreground">Provider quota is only shown when the provider reports it. OpenCode Go and ChatGPT plans do not expose a public quota API here.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {conns.data?.connections.map((connection: Connection) => (
            <article key={connection.id} className="rounded-2xl bg-well p-4">
              <div className="flex items-center gap-2">
                <span className={cn('size-2 rounded-full', connection.health === 'ok' ? 'bg-emerald-500' : connection.health === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40')} aria-hidden="true" />
                <p className="text-sm font-medium">{connection.label}</p>
                <span className="text-[10px] text-muted-foreground">{connection.engine === 'pi' ? 'Pi' : 'OpenCode'}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{connection.auth} · {connection.modelCount} models</p>
              {connection.healthMessage && <p className="mt-1 text-[11px] text-destructive">{connection.healthMessage}</p>}
              <p className="mt-2 text-xs">Provider quota: not reported</p>
              {connection.consoleUrl && (
                <a className="mt-2 inline-flex items-center gap-1 text-xs underline" href={connection.consoleUrl} target="_blank" rel="noreferrer">
                  Provider account <IconExternalLink size={12} />
                </a>
              )}
            </article>
          ))}
          {!conns.data?.connections.length && <p className="text-xs text-muted-foreground">No provider connections found.</p>}
        </div>

        <div className="mt-5 rounded-2xl bg-well p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Connect an API key</h3>
            <button className="inline-flex items-center gap-1 text-xs underline" onClick={() => void mutate('/models/refresh', {}).then(() => client.invalidateQueries({ queryKey: ['model-offerings'] })).catch((error) => onToast(error.message, true))}>
              <IconRefresh size={12} /> Refresh catalog{models.data?.fetchedAt ? ` (${new Date(models.data.fetchedAt).toLocaleTimeString()})` : ''}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Pi reuses OpenCode API keys without copying OAuth refresh tokens. OpenAI OAuth stays managed by OpenCode.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <select aria-label="Connection engine" className="rounded-lg bg-background p-2 text-sm" value={engine} onChange={(event) => setEngine(event.target.value)}>
              <option value="opencode">OpenCode</option><option value="pi">Pi</option>
            </select>
            <input aria-label="Provider ID" className="min-w-0 flex-1 rounded-lg bg-background p-2 text-sm" value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="Provider ID (e.g. openai)" />
            <input aria-label="Provider API key" type="password" autoComplete="off" className="w-full rounded-lg bg-background p-2 text-sm" placeholder="API key — stored on your VPS" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            <button disabled={busy || !apiKey || !provider} onClick={() => void connect()} className="rounded-full bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-40">{busy ? 'Connecting…' : 'Connect'}</button>
          </div>
        </div>

        <div className="mt-4 rounded-2xl bg-well p-4 text-xs">
          <h3 className="text-sm font-medium">OpenAI OAuth / subscription</h3>
          <p className="mt-1 text-muted-foreground">OpenCode owns and refreshes this connection. API billing and subscription limits are separate.</p>
          {!oauth ? (
            <button disabled={busy} className="mt-3 rounded-full bg-primary px-3 py-2 text-primary-foreground" onClick={() => { setBusy(true); void mutate<typeof oauth>('/connections/oauth/start', { provider: 'openai' }).then(setOauth).catch((error) => onToast(error.message, true)).finally(() => setBusy(false)); }}>Sign in with OpenAI</button>
          ) : (
            <div className="mt-3 space-y-2">
              <a href={oauth.url} target="_blank" rel="noreferrer" className="block underline">Open provider authorization</a>
              <p className="whitespace-pre-wrap">{oauth.instructions}</p>
              {oauth.method === 'code' && <input aria-label="Authorization code" value={code} onChange={(event) => setCode(event.target.value)} className="w-full rounded-lg bg-background p-2" placeholder="Authorization code" />}
              <button disabled={busy} className="rounded-full bg-primary px-3 py-2 text-primary-foreground disabled:opacity-40" onClick={() => { setBusy(true); void mutate('/connections/oauth/complete', { provider: oauth.provider, authMethod: oauth.authMethod, code }).then(() => { setOauth(undefined); setCode(''); void client.invalidateQueries({ queryKey: ['connections'] }); void client.invalidateQueries({ queryKey: ['model-offerings'] }); onToast('OpenAI connected.'); }).catch((error) => onToast(error.message, true)).finally(() => setBusy(false)); }}>{busy ? 'Waiting for authorization…' : 'Complete sign-in'}</button>
            </div>
          )}
        </div>

        <h2 className="mt-8 text-sm font-semibold">My model defaults</h2>
        <p className="mt-1 text-xs text-muted-foreground">Used for new conversations unless a project or conversation overrides them.</p>
        <div className="mt-3 space-y-2">
          {(['opencode', 'pi'] as const).map((item) => (
            <div key={item} className="flex items-center gap-3 rounded-xl bg-well p-3 text-xs">
              <span className="w-20 text-muted-foreground">{item === 'pi' ? 'Pi' : 'OpenCode'}</span>
              <ModelPicker engine={item} value={models.data?.defaults?.[item]} onChange={(model) => void setDefault(model, item)} onToast={onToast} />
            </div>
          ))}
        </div>

        <p className="mt-5 pb-8 text-xs leading-5 text-muted-foreground">{usage.data?.coverage} Context occupancy is shown inside each conversation and is separate from these cumulative token totals.</p>
      </div>
    </div>
  );
}

/* ---- Limits, budgets and pacing (§30–32) ---- */

const SOURCE_TONE: Record<string, string> = {
  reported: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  estimated: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  manual: 'bg-muted text-muted-foreground',
};

function sourceBadge(source?: string) {
  const key = source || 'estimated';
  return <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize', SOURCE_TONE[key] || SOURCE_TONE.estimated)}>{key}</span>;
}

function paceText(metric: PacingMetric): string | null {
  if (metric.pacePercent != null) {
    const diff = Math.round(metric.pacePercent);
    if (Math.abs(diff) < 1) return 'on pace';
    return diff > 0 ? `${diff}% ahead of pace` : `${Math.abs(diff)}% behind pace`;
  }
  if (metric.limit && metric.expected != null && metric.used != null) {
    const diff = Math.round(((metric.used - metric.expected) / metric.limit) * 100);
    if (Math.abs(diff) < 1) return 'on pace';
    return diff > 0 ? `${diff}% ahead of pace` : `${Math.abs(diff)}% behind pace`;
  }
  return null;
}

function PacingCard({ label, metric, source }: { label: string; metric: PacingMetric; source?: string }) {
  const limit = metric.limit ?? null;
  const used = Number(metric.used || 0);
  const percent = metric.percent ?? (limit ? (used / limit) * 100 : 0);
  const expectedPercent = limit && metric.expected != null ? (metric.expected / limit) * 100 : null;
  const pace = paceText(metric);
  const format = (value: number) => label === 'Cost' ? money(value) : label === 'Requests' ? String(value) : formatTokens(value);
  return (
    <div className="rounded-2xl bg-well p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        {sourceBadge(source)}
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">
        {format(used)}
        {limit != null && <span className="text-xs font-normal text-muted-foreground"> / {format(limit)}</span>}
      </p>
      {limit != null && (
        <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', percent >= 100 ? 'bg-destructive' : percent >= 80 ? 'bg-amber-500' : 'bg-foreground')}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
          {expectedPercent != null && (
            <span
              className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-foreground/60"
              style={{ left: `${Math.min(100, Math.max(0, expectedPercent))}%` }}
              title="Expected by now"
            />
          )}
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {limit == null ? 'No limit set' : `${Math.round(percent)}% used${pace ? ` · ${pace}` : ''}`}
      </p>
    </div>
  );
}

function LimitsPacing({ onToast }: { onToast: (message: string, isError?: boolean) => void }) {
  const client = useQueryClient();
  const limitsQuery = useQuery({ queryKey: ['usage-limits'], queryFn: usageLimits, staleTime: 30_000, retry: 1 });
  const pacingQuery = useQuery({ queryKey: ['usage-pacing'], queryFn: usagePacing, staleTime: 30_000, retry: 1 });
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly');
  const [metric, setMetric] = useState<'tokens' | 'cost' | 'requests'>('tokens');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const limits = limitsQuery.data?.limits || limitsQuery.data?.usageLimits || [];
  const pacing: UsagePacing | undefined = pacingQuery.data?.pacing || pacingQuery.data;
  const endpointMissing = limitsQuery.isFetched && limitsQuery.data === undefined;

  async function refresh() {
    await client.invalidateQueries({ queryKey: ['usage-limits'] });
    await client.invalidateQueries({ queryKey: ['usage-pacing'] });
  }

  async function save() {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) { onToast('Enter a positive budget.', true); return; }
    setBusy(true);
    try {
      const body: Partial<UsageLimit> = { scope: 'global', period, source: 'manual', manual: true };
      if (metric === 'tokens') body.limitTokens = Math.round(amount);
      if (metric === 'cost') body.limitCost = amount;
      if (metric === 'requests') body.limitRequests = Math.round(amount);
      await saveUsageLimit(body);
      setValue('');
      await refresh();
      onToast('Budget saved.');
    } catch (error) { onToast((error as Error).message, true); } finally { setBusy(false); }
  }

  async function remove(id?: string) {
    if (!id) return;
    try {
      await deleteUsageLimit(id);
      await refresh();
      onToast('Budget removed.');
    } catch (error) { onToast((error as Error).message, true); }
  }

  const metrics = pacing
    ? ([['Tokens', pacing.tokens], ['Cost', pacing.cost], ['Requests', pacing.requests]] as const)
      .filter(([, item]) => item && (item.limit != null || item.used != null))
    : [];

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Limits &amp; pacing</h2>
        {pacing?.resetAt && <span className="text-[11px] text-muted-foreground">Resets {new Date(pacing.resetAt).toLocaleDateString()}</span>}
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Budgets are labelled by source: <b>reported</b> from the provider, <b>estimated</b> from recorded usage, <b>manual</b> set by you. Pacing compares usage against a straight line to the reset.
      </p>

      {pacingQuery.isError && <p role="alert" className="mt-3 text-xs text-destructive">{pacingQuery.error.message}</p>}

      {metrics.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {metrics.map(([label, item]) => <PacingCard key={label} label={label} metric={item as PacingMetric} source={pacing?.source} />)}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {limits.map((limit) => (
          <div key={limit.id || `${limit.scope}:${limit.provider || ''}:${limit.period}`} className="flex flex-wrap items-center gap-2 rounded-xl bg-well p-3 text-xs">
            <span className="font-medium">{limit.provider || (limit.scope === 'global' ? 'All providers' : limit.scope)}</span>
            <span className="text-muted-foreground capitalize">{limit.period}</span>
            <span className="tabular-nums">
              {limit.limitTokens ? `${formatTokens(limit.limitTokens)} tokens` : ''}
              {limit.limitCost ? `${money(limit.limitCost)}${limit.currency ? ` ${limit.currency}` : ''}` : ''}
              {limit.limitRequests ? `${limit.limitRequests} requests` : ''}
            </span>
            {sourceBadge(limit.source || (limit.manual ? 'manual' : undefined))}
            {limit.resetAt && <span className="text-muted-foreground">resets {new Date(limit.resetAt).toLocaleDateString()}</span>}
            {limit.id && (
              <button
                type="button"
                aria-label="Remove budget"
                onClick={() => void remove(limit.id)}
                className="ml-auto grid size-6 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <IconTrash size={13} />
              </button>
            )}
          </div>
        ))}
        {limitsQuery.isPending && <p className="text-xs text-muted-foreground">Loading budgets…</p>}
        {limitsQuery.isFetched && limits.length === 0 && !endpointMissing && (
          <p className="text-xs text-muted-foreground">No budgets set. Add a manual weekly or monthly budget below.</p>
        )}
        {endpointMissing && (
          <p className="text-xs text-muted-foreground">This control plane does not expose usage limits yet — only recorded usage is shown.</p>
        )}
      </div>

      {!endpointMissing && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-well p-4">
          <span className="text-xs font-medium">Set a manual budget</span>
          <select aria-label="Budget period" className="rounded-lg bg-background p-2 text-xs" value={period} onChange={(event) => setPeriod(event.target.value as 'weekly' | 'monthly')}>
            <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
          </select>
          <select aria-label="Budget metric" className="rounded-lg bg-background p-2 text-xs" value={metric} onChange={(event) => setMetric(event.target.value as 'tokens' | 'cost' | 'requests')}>
            <option value="tokens">Tokens</option><option value="cost">Cost (USD)</option><option value="requests">Requests</option>
          </select>
          <input
            aria-label="Budget amount"
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={metric === 'cost' ? '20' : '1000000'}
            className="w-28 rounded-lg bg-background p-2 text-xs"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="cursor-pointer rounded-full bg-primary px-3 py-2 text-xs text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save budget'}
          </button>
        </div>
      )}
    </section>
  );
}
