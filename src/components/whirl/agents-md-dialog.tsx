import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBook, IconCircleCheckFilled, IconLoader2, IconPlayerPlayFilled } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { agentInstructionFiles, saveAgentInstruction, type AgentInstructionFile } from '@/lib/workbench';
import { cn } from '@/lib/utils';

const SCOPE_LABEL: Record<string, string> = {
  global: 'Global',
  project: 'Project',
  nested: 'Nested',
};

const SCOPE_TONE: Record<string, string> = {
  global: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  project: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  nested: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

/* AGENTS.md lives outside the chat: global (~/.config/workbench) plus project
   root and any nested files between the root and the run directory (§29). All
   of them are real files the user owns, so each is editable in place. */
export function AgentsMdDialog({ open, onOpenChange, projectId, projectName, path, onToast, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string | null;
  projectName?: string;
  path?: string | null;
  onToast: (message: string, isError?: boolean) => void;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const [activePath, setActivePath] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [loadedFor, setLoadedFor] = useState('');

  const query = useQuery({
    queryKey: ['agents-md', projectId || null, path || ''],
    queryFn: () => agentInstructionFiles(projectId, path),
    enabled: open,
    staleTime: 30_000,
    retry: 1,
  });

  const files = query.data?.files || [];
  const active = useMemo(() => files.find((file) => file.path === activePath) || files[0], [files, activePath]);

  useEffect(() => {
    if (!open) return;
    setActivePath('');
    setLoadedFor('');
  }, [open, projectId, path]);

  useEffect(() => {
    if (!active) return;
    if (loadedFor === active.path) return;
    setLoadedFor(active.path);
    setDraft(active.content || '');
  }, [active, loadedFor]);

  const dirty = Boolean(active) && draft !== (active?.content || '');

  const save = useMutation({
    mutationFn: () => saveAgentInstruction({
      scope: active!.scope,
      projectId,
      path: active!.scope === 'global' ? null : active!.path,
      content: draft,
    }),
    onSuccess: () => {
      onToast(`${SCOPE_LABEL[active!.scope] || 'AGENTS.md'} saved.`);
      void queryClient.invalidateQueries({ queryKey: ['agents-md'] });
      setLoadedFor('');
      onSaved?.();
    },
    onError: (error) => onToast(error instanceof Error ? error.message : 'Could not save AGENTS.md.', true),
  });

  const exists = files.filter((file) => file.exists).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[6vh] flex h-[84vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-0 overflow-hidden rounded-2xl p-0">
        <DialogTitle className="sr-only">AGENTS.md instructions</DialogTitle>
        <DialogDescription className="sr-only">View and edit the global and project instruction files your agent loads into context.</DialogDescription>

        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <IconBook size={16} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold">AGENTS.md</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {projectName ? `${projectName} · ` : ''}{exists ? `${exists} applicable file${exists === 1 ? '' : 's'}` : 'No instruction files yet'}
            </p>
          </div>
          {active && (
            <button
              type="button"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:opacity-40"
            >
              {save.isPending ? <IconLoader2 size={13} className="animate-spin" /> : <IconPlayerPlayFilled size={13} />}
              Save
            </button>
          )}
        </header>

        {query.isPending ? (
          <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground"><IconLoader2 size={20} className="animate-spin" /></div>
        ) : query.isError ? (
          <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
            <p className="max-w-sm text-[13px] text-destructive">{query.error.message}</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="wb-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-64 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0">
              {files.map((file: AgentInstructionFile) => {
                const selected = active?.path === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => { setActivePath(file.path); setLoadedFor(''); }}
                    className={cn(
                      'min-w-52 cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors duration-100 md:min-w-0',
                      selected ? 'bg-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium', SCOPE_TONE[file.scope] || 'bg-well text-muted-foreground')}>
                        {SCOPE_LABEL[file.scope] || file.scope}
                      </span>
                      {file.exists
                        ? <IconCircleCheckFilled size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                        : <span className="shrink-0 text-[10px] text-muted-foreground">new</span>}
                    </span>
                    <span className="mt-1 block truncate text-[12px] font-medium">{file.label}</span>
                    <span className="block truncate font-mono text-[10.5px] text-muted-foreground" title={file.path}>{file.path}</span>
                  </button>
                );
              })}
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {active ? (
                <>
                  <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={active.path}>{active.path}</span>
                    {dirty && <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">Unsaved</span>}
                  </div>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    spellCheck={false}
                    aria-label={`${active.label} AGENTS.md content`}
                    placeholder={active.scope === 'global' ? '# Global instructions\n\nApplies to every project.' : '# Project instructions\n\nApplies to this project.'}
                    className="wb-scroll min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px]/5 outline-none placeholder:text-muted-foreground"
                  />
                </>
              ) : (
                <div className="grid flex-1 place-items-center p-6 text-center">
                  <p className="text-[13px] text-muted-foreground">No instruction files available.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
