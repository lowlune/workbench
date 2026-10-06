import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCopy, IconPaperclip, IconPin, IconTrash } from '@tabler/icons-react';
import { clips as fetchClips, mutate, v2 } from '@/lib/workbench';
import { fileToDataUrl, type Attachment } from '@/lib/attachments';
import type { Clip, Project } from '@/lib/types';
import { cn, timeAgo } from '@/lib/utils';

/* Reusable context: notes, files and screenshots scoped to a project folder
   or General. A clip saved from a conversation defaults to that project;
   attaching it never mixes it into an unrelated conversation. */
export default function ContextLibrary({
  projects,
  projectId,
  onToast,
  onUse,
}: {
  projects: Project[];
  projectId?: string | null;
  onToast: (text: string, error?: boolean) => void;
  onUse?: (text: string, attachment?: Attachment) => void;
}) {
  const client = useQueryClient();
  const [scope, setScope] = useState(projectId || 'general');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (projectId !== undefined) setScope(projectId || 'general'); }, [projectId]);
  const query = useQuery({ queryKey: ['context-clips', scope], queryFn: () => fetchClips(scope) });
  const refresh = () => client.invalidateQueries({ queryKey: ['context-clips'] });
  const projectName = (id: string | null) => !id ? 'General' : projects.find((project) => project.id === id)?.name || 'Project';
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = query.data?.clips || [];
    return needle ? list.filter((clip) => `${clip.title} ${clip.text}`.toLowerCase().includes(needle)) : list;
  }, [query.data, search]);

  async function save(attachmentId?: string) {
    setBusy(true);
    try {
      await mutate('/clips', { text, attachmentId, title: title || undefined, projectId: scope === 'all' || scope === 'general' ? null : scope });
      setText('');
      setTitle('');
      await refresh();
    } catch (error) { onToast((error as Error).message, true); } finally { setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const attachment = await fileToDataUrl(file);
      await mutate('/clips', { text, attachmentId: attachment.id, projectId: scope === 'all' || scope === 'general' ? null : scope });
      setText('');
      await refresh();
    } catch (error) { onToast((error as Error).message, true); } finally { setBusy(false); }
  }

  return (
    <div className="wb-scroll h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-semibold">Context library</h1>
        <p className="mt-1 text-sm text-muted-foreground">Reusable notes, files and screenshots. Scoped to a project folder, or General for everything else.</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select aria-label="Library scope" className="rounded-full bg-well px-3 py-2 text-sm" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="general">General</option>
            <option value="all">All projects</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input aria-label="Search clips" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search saved context…" className="min-w-0 flex-1 rounded-full bg-well px-3 py-2 text-sm outline-none" />
        </div>

        <div className="mt-4 rounded-2xl bg-well p-3 ring-1 ring-border">
          <input aria-label="Clip title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional title" className="mb-1 w-full bg-transparent text-[13px] font-medium outline-none placeholder:text-muted-foreground" />
          <textarea
            aria-label="New context clip"
            placeholder="Paste a note, code, a link or a screenshot…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => { const file = Array.from(event.clipboardData.files)[0]; if (file) { event.preventDefault(); void upload(file); } }}
            className="min-h-24 w-full resize-y bg-transparent text-sm outline-none"
          />
          <div className="flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-1 text-xs">
              <IconPaperclip size={14} />Upload file
              <input type="file" className="sr-only" disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
            </label>
            <button disabled={busy || !text.trim()} onClick={() => void save()} className="rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">{busy ? 'Saving…' : `Save to ${scope === 'all' || scope === 'general' ? 'General' : projects.find((project) => project.id === scope)?.name || 'project'}`}</button>
          </div>
        </div>

        {query.isError && <p role="alert" className="mt-4 text-sm text-destructive">{query.error.message}</p>}

        <div className="mt-5 space-y-3">
          {visible.map((clip: Clip) => (
            <article key={clip.id} className="rounded-2xl bg-well p-4 ring-1 ring-border">
              <div className="flex items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{clip.title || 'Untitled clip'}</h2>
                <span className={cn('rounded-full px-2 py-0.5 text-[10px]', clip.projectId ? 'bg-accent text-foreground' : 'text-muted-foreground')}>{projectName(clip.projectId)}</span>
                <span className="text-[10px] text-muted-foreground">{timeAgo(clip.created)}</span>
              </div>
              {clip.text && <p className="mt-2 max-h-60 overflow-auto text-[13px]/6 break-words whitespace-pre-wrap">{clip.text}</p>}
              {clip.attachment?.mime.startsWith('image/') ? (
                <img src={`/api/v2/attachments/${clip.attachment.id}`} alt={clip.attachment.name} loading="lazy" className="mt-2 max-h-64 rounded-xl object-contain" />
              ) : clip.attachment ? (
                <p className="mt-2 text-xs">{clip.attachment.name}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                {onUse && <button className="rounded-full bg-primary px-3 py-1.5 text-primary-foreground" onClick={() => onUse(clip.text, clip.attachment ? { ...clip.attachment, dataUrl: `/api/v2/attachments/${clip.attachment.id}` } : undefined)}>Add to message</button>}
                {clip.text && (
                  <button aria-label="Copy clip" className="p-1.5" onClick={() => void navigator.clipboard.writeText(clip.text).then(() => onToast('Copied.')).catch(() => onToast('Copy failed.', true))}>
                    <IconCopy size={15} />
                  </button>
                )}
                <button aria-label={clip.pinned ? 'Unpin clip' : 'Pin clip'} className="p-1.5" onClick={() => void mutate(`/clips/${clip.id}`, { pinned: !clip.pinned }, 'PATCH').then(refresh).catch((error) => onToast(error.message, true))}>
                  <IconPin size={15} />
                </button>
                <select aria-label={`Move ${clip.title} to project`} value={clip.projectId || 'general'} className="max-w-40 rounded bg-background p-1" onChange={(event) => void mutate(`/clips/${clip.id}`, { projectId: event.target.value === 'general' ? null : event.target.value }, 'PATCH').then(refresh).catch((error) => onToast(error.message, true))}>
                  <option value="general">General</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
                <button aria-label="Delete clip" className="ml-auto p-1.5 text-muted-foreground hover:text-destructive" onClick={() => void v2(`/clips/${clip.id}`, { method: 'DELETE' }).then(refresh).catch((error) => onToast(error.message, true))}>
                  <IconTrash size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
        {query.isSuccess && !visible.length && <p className="py-12 text-center text-sm text-muted-foreground">No saved context in this scope yet.</p>}
      </div>
    </div>
  );
}
