import { useMemo, useState, type ReactNode } from 'react';
import { IconCheck, IconFolder, IconHome, IconLoader2 } from '@tabler/icons-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Project } from '@/lib/types';
import { cn, shortDirectory } from '@/lib/utils';

/* Where a conversation runs. Project → isolated git worktree; General → a
   private scratch dir. Switching the workspace rebinds the conversation, so the
   next run gets its own isolated tree instead of sharing one with another chat. */
export function WorkspaceMenu({
  projectId,
  directory,
  projects,
  onSelect,
}: {
  projectId?: string | null;
  directory?: string | null;
  projects: Project[];
  onSelect: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = useMemo(() => projects.find((project) => project.id === projectId) || null, [projects, projectId]);
  const label = current?.name || 'General';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={`Workspace: ${current?.directory || directory || 'General'}`}
            className={cn(
              'inline-flex h-7 max-w-44 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[11px] font-medium transition-colors duration-150 hover:bg-accent hover:text-foreground',
              current ? 'text-muted-foreground' : 'text-muted-foreground',
            )}
          >
            {current ? <IconFolder size={13} className="shrink-0 text-muted-foreground" /> : <IconHome size={13} className="shrink-0 text-muted-foreground" />}
            <span className="truncate">{label}</span>
          </button>
        }
      />
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2.5">
          <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Workspace</p>
          <p className="mt-1 truncate text-[12px] text-muted-foreground">{shortDirectory(current?.directory || directory || '')}</p>
          <p className="mt-1.5 text-[11px]/4 text-muted-foreground/80">
            Project runs get an isolated git worktree; General runs get a private scratch dir — so parallel chats never edit each other's files.
          </p>
        </div>
        <div className="wb-scroll max-h-72 overflow-y-auto p-1">
          <WorkspaceRow
            icon={<IconHome size={15} />}
            title="General"
            subtitle="Private scratch — parallel-safe"
            active={!projectId}
            onSelect={() => { setOpen(false); onSelect(null); }}
          />
          {projects.map((project) => (
            <WorkspaceRow
              key={project.id}
              icon={<IconFolder size={15} />}
              title={project.name}
              subtitle={shortDirectory(project.directory)}
              active={project.id === projectId}
              onSelect={() => { setOpen(false); onSelect(project.id); }}
            />
          ))}
          {projects.length === 0 && (
            <p className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground"><IconLoader2 size={13} className="animate-spin" /> Loading projects…</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WorkspaceRow({
  icon,
  title,
  subtitle,
  active,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors duration-75 hover:bg-accent"
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
      {active && <IconCheck size={14} className="shrink-0" />}
    </button>
  );
}
