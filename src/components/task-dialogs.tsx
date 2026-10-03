import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, SpinnerGap, TerminalWindow } from '@phosphor-icons/react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, getAgentOutput } from '@/lib/api';
import type { Agent, Overview } from '@/lib/types';
import { copyText } from '@/lib/clipboard';
import { humanBytes } from '@/lib/utils';

interface NewTaskDialogProps {
  open: boolean;
  overview?: Overview;
  onOpenChange: (open: boolean) => void;
  onStarted: (message: string, isError?: boolean) => void;
  onComplete: () => void;
}

export function NewTaskDialog({ open, overview, onOpenChange, onStarted, onComplete }: NewTaskDialogProps) {
  const [directory, setDirectory] = useState('');
  const [kind, setKind] = useState(() => {
    try { return localStorage.getItem('workbench-agent-kind') === 'pi' ? 'pi' : 'opencode'; }
    catch { return 'opencode'; }
  });
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const dirs = overview?.directories || [];
  const memoryFree = Number(overview?.system?.memoryFree || 0);
  const memoryReady = memoryFree >= 1024 ** 3;

  useEffect(() => {
    if (!open) return;
    let saved = '';
    try { saved = localStorage.getItem('workbench-project') || ''; } catch { /* Use the first available project. */ }
    const preferred = dirs.some((item) => item.directory === saved) ? saved : dirs[0]?.directory || '';
    setDirectory((current) => current || preferred);
  }, [open, dirs]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || pending || !memoryReady) return;
    setPending(true);
    try {
      const result = await api<{ started: boolean; paneId: string; promptSubmitted?: boolean; warning?: string; kind: string }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ directory, kind, title, prompt }),
      });
      onOpenChange(false);
      onComplete();
      onStarted(result.promptSubmitted === false
        ? result.warning || 'The agent started, but its first message could not be confirmed. Check live output before resending.'
        : 'Your task is starting. It will appear in your workspace shortly.', result.promptSubmitted === false);
      setTitle('');
      setPrompt('');
    } catch (error) {
      onStarted(error instanceof Error ? error.message : 'Could not start this task.', true);
    } finally { setPending(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a task</DialogTitle>
          <DialogDescription>Choose where your agent should work, then describe the outcome you want.</DialogDescription>
        </DialogHeader>
        {!memoryReady && (
          <div className="rounded-xl border border-warning/25 bg-warning/10 px-3.5 py-3 text-sm text-warning" role="status">
            Only {humanBytes(memoryFree)} of memory is available. Finish or close a task before starting another.
          </div>
        )}
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <label htmlFor="task-project" className="text-sm font-medium">Project</label>
            <select id="task-project" value={directory} onChange={(event) => { setDirectory(event.target.value); try { localStorage.setItem('workbench-project', event.target.value); } catch { /* Preference is optional. */ } }} required className="h-10 w-full rounded-lg border border-input bg-panel px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              {dirs.map((item) => <option key={item.directory} value={item.directory}>{item.name}</option>)}
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <label htmlFor="task-agent" className="text-sm font-medium">Agent</label>
              <select id="task-agent" value={kind} onChange={(event) => { setKind(event.target.value); try { localStorage.setItem('workbench-agent-kind', event.target.value); } catch { /* Preference is optional. */ } }} className="h-10 w-full rounded-lg border border-input bg-panel px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <option value="opencode">OpenCode</option><option value="pi">Pi</option>
              </select>
            </div>
            <div className="grid gap-2">
              <label htmlFor="task-title" className="text-sm font-medium">Task name <span className="font-normal text-muted-foreground">(optional)</span></label>
              <Input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={70} placeholder="e.g. Improve chat history" />
            </div>
          </div>
          <div className="grid gap-2">
            <label htmlFor="task-prompt" className="text-sm font-medium">What should the agent do?</label>
            <Textarea id="task-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={60_000} required placeholder="Describe the result you want. You can include constraints and how to verify it." className="min-h-32" />
            <p className="text-xs text-muted-foreground">A specific goal and a way to verify it usually work best.</p>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || !prompt.trim() || !directory || !memoryReady}>
              {pending ? <SpinnerGap aria-hidden="true" className="animate-spin" /> : <TerminalWindow aria-hidden="true" />}
              {pending ? 'Starting…' : 'Start task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OutputDialog({ agent, onOpenChange, onToast }: { agent?: Agent; onOpenChange: (open: boolean) => void; onToast: (message: string, isError?: boolean) => void }) {
  const outputQuery = useQuery({
    queryKey: ['agent-output', agent?.paneId],
    queryFn: () => getAgentOutput(agent!),
    enabled: Boolean(agent),
    staleTime: 0,
    retry: 0,
  });
  const output = outputQuery.data?.output || '';
  return (
    <Dialog open={Boolean(agent)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Live agent output</DialogTitle>
          <DialogDescription>{agent?.sessionTitle || agent?.title} · {agent?.paneId}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60dvh] min-h-32 overflow-auto rounded-xl border border-border bg-background p-4">
          {outputQuery.isPending ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><SpinnerGap aria-hidden="true" className="animate-spin" />Reading recent output…</div>
            : outputQuery.isError ? <p role="alert" className="text-sm text-destructive">{outputQuery.error.message}</p>
              : <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground">{output || 'No recent output.'}</pre>}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" disabled={!output} onClick={() => void copyText(output).then(() => onToast('Output copied.')).catch((error) => onToast(error.message, true))}><Copy aria-hidden="true" /> Copy output</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
