import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconChevronLeft, IconFile, IconFolder, IconLoader2 } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { fileToDataUrl, type Attachment } from '@/lib/attachments';
import { projectFiles, projectFileUrl } from '@/lib/workbench';
import type { Project } from '@/lib/types';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/plain', '.log': 'text/plain', '.txt': 'text/plain', '.ts': 'text/plain', '.tsx': 'text/plain', '.js': 'text/plain', '.jsx': 'text/plain', '.py': 'text/plain', '.css': 'text/plain', '.html': 'text/plain', '.sh': 'text/plain', '.yml': 'text/plain', '.yaml': 'text/plain' } as Record<string, string>;
const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} kB` : `${bytes} B`;

export function ProjectFilesDialog({ project, open, onOpenChange, onPick, onToast }: {
  project?: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (attachment: Attachment) => void;
  onToast: (text: string, error?: boolean) => void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState('');
  const query = useQuery({ queryKey: ['project-files', project?.id, path], queryFn: () => projectFiles(project!.id, path), enabled: open && !!project, staleTime: 5000 });

  async function pick(name: string, relative: string) {
    if (!project) return;
    if ((MIME[name.slice(name.lastIndexOf('.')).toLowerCase()] || 'text/plain') !== 'text/plain' && !MIME[name.slice(name.lastIndexOf('.')).toLowerCase()]) {
      onToast('Choose a text, Markdown, JSON or image file.', true);
      return;
    }
    setBusy(relative);
    try {
      const response = await fetch(projectFileUrl(project.id, relative));
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not read the file.');
      const blob = await response.blob();
      const mime = MIME[name.slice(name.lastIndexOf('.')).toLowerCase()] || 'text/plain';
      onPick(await fileToDataUrl(new File([blob], name, { type: mime })));
    } catch (error) { onToast((error as Error).message, true); } finally { setBusy(''); }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setPath(''); } onOpenChange(next); }}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Add from {project?.name || 'project'}</DialogTitle>
        <DialogDescription>Files come from the project folder and are attached as context for your next message.</DialogDescription>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button aria-label="Up one folder" className="grid size-6 place-items-center rounded-md hover:bg-accent disabled:opacity-30" disabled={!path} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>
            <IconChevronLeft size={14} />
          </button>
          <span className="truncate">{project?.name}{path ? ` / ${path}` : ''}</span>
        </div>
        <div className="wb-scroll max-h-80 overflow-y-auto rounded-xl bg-well p-1">
          {query.isPending && <div className="grid h-24 place-items-center"><IconLoader2 size={18} className="animate-spin text-muted-foreground" /></div>}
          {query.isError && <p role="alert" className="p-4 text-sm text-destructive">{query.error.message}</p>}
          {query.data?.entries.map((entry) => (
            <button
              key={entry.path}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] hover:bg-accent"
              onClick={() => entry.directory ? setPath(entry.path) : void pick(entry.name, entry.path)}
            >
              <span className="text-muted-foreground">{entry.directory ? <IconFolder size={14} /> : <IconFile size={14} />}</span>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {busy === entry.path ? <IconLoader2 size={13} className="animate-spin" /> : <span className="text-[10px] text-muted-foreground">{entry.directory ? '' : sizeLabel(entry.size)}</span>}
            </button>
          ))}
          {query.isSuccess && !query.data.entries.length && <p className="p-4 text-sm text-muted-foreground">This folder is empty.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
