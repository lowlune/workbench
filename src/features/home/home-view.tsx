import { ArrowRight, ChatCenteredText, Cpu, HardDrives, Memory, TerminalWindow } from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Agent, Overview, Session } from '@/lib/types';
import { cn, humanBytes, plainPreview, shortDirectory, timeAgo } from '@/lib/utils';

interface HomeViewProps {
  overview: Overview;
  onNewTask: () => void;
  onOpenSession: (session: Session, agent?: Agent) => void;
  onOutput: (agent: Agent) => void;
  onHistory: () => void;
}

function statusText(status: string) {
  return ({ working: 'Working', blocked: 'Needs you', idle: 'Ready', done: 'Completed', unknown: 'Live' } as Record<string, string>)[status] || status;
}

function SystemOverview({ overview }: { overview: Overview }) {
  const system = overview.system;
  const memoryPercent = Math.min(100, Math.max(0, Number(system.memoryPercent || 0)));
  const memoryTone = memoryPercent >= 90 ? 'text-destructive' : memoryPercent >= 78 ? 'text-warning' : 'text-foreground';
  return (
    <section className="grid gap-4 rounded-2xl border border-border bg-panel p-4 sm:grid-cols-3 sm:gap-0 sm:p-0" aria-label="VPS resources">
      <div className="flex items-center gap-3 sm:p-4">
        <span className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground"><Cpu aria-hidden="true" size={19} /></span>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">CPU load</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">{Number(system.load?.[0] || 0).toFixed(1)} <span className="font-normal text-muted-foreground">/ {system.cpuCount || 0} cores</span></div>
        </div>
      </div>
      <div className="flex items-center gap-3 sm:border-l sm:border-border sm:p-4">
        <span className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground"><Memory aria-hidden="true" size={19} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Memory</span><span className={cn('font-medium tabular-nums', memoryTone)}>{memoryPercent}%</span>
          </div>
          <progress className={cn('memory-progress mt-1.5 h-1.5 w-full overflow-hidden rounded-full', memoryPercent >= 90 && 'is-critical', memoryPercent >= 78 && memoryPercent < 90 && 'is-warning')} aria-label="Memory used" max={100} value={memoryPercent}>{memoryPercent}%</progress>
          <div className="mt-1 text-[11px] text-muted-foreground">{humanBytes(system.memoryFree)} available</div>
        </div>
      </div>
      <div className="flex items-center gap-3 sm:border-l sm:border-border sm:p-4">
        <span className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground"><HardDrives aria-hidden="true" size={19} /></span>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Swap in use</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">{humanBytes(system.swap?.used)} <span className="font-normal text-muted-foreground">/ {humanBytes(system.swap?.total)}</span></div>
        </div>
      </div>
    </section>
  );
}

export function HomeView({ overview, onNewTask, onOpenSession, onOutput, onHistory }: HomeViewProps) {
  const activeAgents = overview.agents.filter((agent) => agent.status !== 'done');
  const agentBySession = new Map(overview.agents.filter((agent) => agent.sessionId).map((agent) => [agent.sessionId!, agent]));
  const recent = overview.sessions.slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-7 sm:px-7 sm:py-9">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">Your workspace</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pick up where you left off.</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your agents, recent work, and next steps — all in one place.</p>
        </div>
        <Button size="lg" onClick={onNewTask}><TerminalWindow aria-hidden="true" /> Start a task</Button>
      </header>

      <SystemOverview overview={overview} />

      <section aria-labelledby="active-heading">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="active-heading" className="text-base font-semibold">In progress</h2>
            <p className="mt-1 text-xs text-muted-foreground">What your agents are doing right now.</p>
          </div>
          <Badge>{activeAgents.length} {activeAgents.length === 1 ? 'agent' : 'agents'}</Badge>
        </div>
        {activeAgents.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {activeAgents.map((agent) => {
              const session = agent.sessionId ? overview.sessions.find((item) => item.id === agent.sessionId) : undefined;
              const variant = agent.status === 'working' ? 'working' : agent.status === 'blocked' ? 'blocked' : 'default';
              return (
                <article key={agent.paneId} className="rounded-2xl border border-border bg-panel p-4 transition-colors hover:border-input sm:p-5">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full bg-muted-foreground/60', agent.status === 'working' && 'animate-pulse bg-success', agent.status === 'blocked' && 'bg-warning')} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold">{agent.sessionTitle || session?.title || agent.title || agent.agent}</h3>
                        <Badge variant={variant}>{statusText(agent.status)}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{agent.agent} · {shortDirectory(agent.cwd)}</p>
                      <p className="mt-3 line-clamp-2 min-h-9 text-sm leading-5 text-muted-foreground">{plainPreview(session?.preview) || (agent.status === 'blocked' ? 'Your agent is waiting for your input.' : 'Your agent is working on this task.')}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
                    {session && <Button size="sm" onClick={() => onOpenSession(session, agent)}>Open chat <ArrowRight aria-hidden="true" /></Button>}
                    <Button size="sm" variant="ghost" onClick={() => onOutput(agent)}>Live output</Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-4 rounded-2xl border border-dashed border-border bg-panel/70 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">No agents are running</h3>
              <p className="mt-1 text-sm text-muted-foreground">Start a task or open a previous conversation.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={onNewTask}>Start a task</Button>
              <Button size="sm" variant="outline" onClick={onHistory}>Browse history</Button>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="recent-tasks-heading">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 id="recent-tasks-heading" className="text-base font-semibold">Recent conversations</h2>
            <p className="mt-1 text-xs text-muted-foreground">Continue a task from any of your projects.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onHistory}>View history <ArrowRight aria-hidden="true" /></Button>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-panel">
          {recent.length ? recent.map((session, index) => {
            const agent = agentBySession.get(session.id);
            return (
              <button key={session.id} type="button" data-session-id={session.id} onClick={() => onOpenSession(session, agent)} className={cn('flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent sm:px-5', index > 0 && 'border-t border-border')}>
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><ChatCenteredText aria-hidden="true" size={18} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{session.title || 'Untitled conversation'}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">{plainPreview(session.preview) || session.agent || shortDirectory(session.directory)}</span>
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{timeAgo(session.updated)}</span>
                <ArrowRight aria-hidden="true" size={16} className="shrink-0 text-muted-foreground" />
              </button>
            );
          }) : <p className="p-5 text-sm text-muted-foreground">Your conversation history will appear here.</p>}
        </div>
      </section>
    </div>
  );
}
