import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconLoader2, IconPlayerStopFilled, IconX } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { getProcesses, getSystemHistory, killProcess } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import type { Agent, ProcessInfo, SystemSnapshot, SystemSample } from '@/lib/types';
import { cn, formatTime, humanBytes } from '@/lib/utils';

/* The system popover: current load, an hour of history, live tasks and the
   top processes with a two-step stop. */
export function SystemPanel({
  open,
  onOpenChange,
  system,
  agents,
  onStopAgent,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  system?: SystemSnapshot;
  agents: Agent[];
  onStopAgent: (agent: Agent) => void;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const historyQuery = useQuery({ queryKey: ['system-history'], queryFn: getSystemHistory, refetchInterval: 60_000, enabled: open });
  const processesQuery = useQuery({ queryKey: ['processes'], queryFn: getProcesses, refetchInterval: 15_000, refetchIntervalInBackground: false, enabled: open });
  const samples = historyQuery.data?.samples || [];
  const working = agents.filter((agent) => agent.status === 'working' || agent.status === 'blocked');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[6vh] flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col rounded-xl">
        <DialogTitle>System</DialogTitle>
        <DialogDescription className="sr-only">CPU, memory, disk, tasks and running processes.</DialogDescription>
        <button
          type="button"
          aria-label="Close system panel"
          onClick={() => onOpenChange(false)}
          className="absolute top-3 right-3 grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <IconX size={15} />
        </button>
        <div className="wb-scroll mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-2 sm:grid-cols-3">
            <Gauge
              label="CPU"
              percent={system?.cpu?.percent || 0}
              detail={system ? `${system.cpu?.cores || 0} cores · load ${(system.load || []).join(' / ')}` : 'Waiting for a sample'}
            />
            <Gauge
              label="Memory"
              percent={system?.memoryPercent || 0}
              detail={system ? `${humanBytes((system.memoryTotal || 0) - (system.memoryFree || 0))} / ${humanBytes(system.memoryTotal || 0)}` : ''}
            />
            <Gauge
              label="Disk"
              percent={system?.disk?.percent || 0}
              detail={system?.disk ? `${humanBytes(system.disk.used)} / ${humanBytes(system.disk.total)}` : ''}
            />
          </div>

          <HistoryChart samples={samples} />

          <section className="mt-5">
            <h3 className="px-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Live tasks</h3>
            <div className="mt-2 flex flex-col gap-1.5">
              {working.length === 0 && <p className="px-2 py-2 text-[13px] text-muted-foreground">No agents are running right now.</p>}
              {working.map((agent) => (
                <div key={agent.paneId} className="flex min-w-0 items-center gap-2.5 rounded-xl bg-well px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--well-outline)]">
                  <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', agent.status === 'working' ? 'animate-pulse bg-foreground' : 'bg-destructive')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{agent.sessionTitle || agent.title || agent.agent}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{agent.agent} · {agent.status}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onStopAgent(agent)}
                    className="shrink-0 cursor-pointer rounded-full bg-well px-3 py-1.5 text-[12px] font-medium shadow-[inset_0_0_0_1px_var(--well-outline)] transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
                  >
                    Stop
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-5">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Processes</h3>
              {processesQuery.isFetching && <IconLoader2 size={13} className="animate-spin text-muted-foreground" />}
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {(processesQuery.data?.processes || []).map((item) => (
                <ProcessRow key={item.pid} process={item} onToast={onToast} />
              ))}
              {processesQuery.isPending && (
                <div className="grid place-items-center py-8 text-muted-foreground"><IconLoader2 size={18} className="animate-spin" /></div>
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Gauge({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  return (
    <div className="rounded-xl bg-well p-3.5 shadow-[inset_0_0_0_1px_var(--well-outline)]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</span>
        <span className="text-[15px] font-semibold tabular-nums">{percent}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full bg-foreground transition-[width] duration-500', percent >= 90 && 'bg-destructive')}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      {detail && <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

function HistoryChart({ samples }: { samples: SystemSample[] }) {
  const width = 600;
  const height = 140;
  if (samples.length < 2) {
    return (
      <div className="mt-3 grid h-36 place-items-center rounded-xl bg-well text-[12px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--well-outline)]">
        Collecting the first samples…
      </div>
    );
  }
  const x = (index: number) => (index / (samples.length - 1)) * width;
  const y = (value: number) => height - (Math.max(0, Math.min(100, value)) / 100) * height;
  const cpu = samples.map((sample, index) => `${x(index).toFixed(1)},${y(sample.cpu).toFixed(1)}`).join(' ');
  const memory = samples.map((sample, index) => `${x(index).toFixed(1)},${y(sample.memoryPercent).toFixed(1)}`).join(' ');
  const last = samples.at(-1)!;
  const spanMinutes = Math.round((last.t - samples[0].t) / 60_000);

  return (
    <div className="mt-3 rounded-xl bg-well p-3.5 shadow-[inset_0_0_0_1px_var(--well-outline)]">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">Last {Math.max(1, spanMinutes)} min</span>
        <span className="flex items-center gap-3 tabular-nums">
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-foreground" /> CPU {last.cpu}%</span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground"><span className="h-0.5 w-4 rounded-full bg-muted-foreground/60" /> RAM {last.memoryPercent}%</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="mt-2 h-28 w-full text-foreground" aria-hidden="true">
        <polyline points={memory} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-muted-foreground/50" />
        <polyline points={cpu} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(last.t - spanMinutes * 60_000)}</span>
        <span>{formatTime(last.t)}</span>
      </div>
    </div>
  );
}

function ProcessRow({ process, onToast }: { process: ProcessInfo; onToast: (message: string, isError?: boolean) => void }) {
  const queryClient = useQueryClient();
  const [armed, setArmed] = useState(false);
  const kill = useMutation({
    mutationFn: () => killProcess(process.pid),
    onSuccess: () => {
      onToast(`Stopped ${process.name} (${process.pid}).`);
      void queryClient.invalidateQueries({ queryKey: ['processes'] });
    },
    onError: (error: Error) => onToast(error.message, true),
  });
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent">
      <span className="w-14 shrink-0 text-[11px] tabular-nums text-muted-foreground">{process.pid}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]">{process.name}</span>
        <span className="block truncate text-[10px] text-muted-foreground">{process.args || process.user}</span>
      </span>
      <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums sm:block">{process.cpu.toFixed(1)}% cpu</span>
      <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums sm:block">{process.memory.toFixed(1)}% mem</span>
      <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground md:block">{formatDuration(process.etimes)}</span>
      <button
        type="button"
        disabled={kill.isPending}
        onMouseLeave={() => setArmed(false)}
        onClick={() => {
          if (armed) kill.mutate();
          else setArmed(true);
        }}
        aria-label={armed ? `Confirm stop ${process.name}` : `Stop ${process.name}`}
        className={cn(
          'shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 disabled:opacity-50',
          armed
            ? 'bg-destructive/15 text-destructive'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {armed ? 'Confirm' : <IconPlayerStopFilled size={13} />}
      </button>
    </div>
  );
}
