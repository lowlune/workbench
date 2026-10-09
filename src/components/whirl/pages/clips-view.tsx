import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconClipboardText, IconCopy, IconLoader2, IconPaperclip, IconTrash } from '@tabler/icons-react';
import { api, getClips, postJson } from '@/lib/api';
import { uploadAttachment } from '@/lib/attachments';
import type { Clip } from '@/lib/types';
import { timeAgo } from '@/lib/utils';

export function ClipsView({ onToast }: { onToast: (message: string, isError?: boolean) => void }) {
  const queryClient = useQueryClient();
  const clipsQuery = useQuery({ queryKey: ['clips'], queryFn: getClips, staleTime: 2_000 });
  const clips = clipsQuery.data?.clips || [];
  const [text, setText] = useState('');
  const [copiedId, setCopiedId] = useState<string>();

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['clips'] });

  const addText = useMutation({
    mutationFn: () => postJson<{ clip: Clip }>('/api/v2/clips', { text, projectId: null }),
    onSuccess: () => { setText(''); invalidate(); onToast('Copied to the clip tray.'); },
    onError: (error: Error) => onToast(error.message, true),
  });

  const addImage = useMutation({
    mutationFn: async (file: File) => {
      const attachment = await uploadAttachment(file);
      return postJson<{ clip: Clip }>('/api/v2/clips', { attachmentId: attachment.id, projectId: null });
    },
    onSuccess: () => { invalidate(); onToast('Image saved to the clip tray.'); },
    onError: (error: Error) => onToast(error.message, true),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<{ deleted: boolean }>(`/api/v2/clips/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (error: Error) => onToast(error.message, true),
  });

  function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      onToast('Choose a JPEG, PNG, WebP, or GIF image.', true);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      onToast('Images must be 5 MB or smaller.', true);
      return;
    }
    addImage.mutate(file);
  }

  return (
    <div className="wb-scroll h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-3 pt-[max(2.5rem,env(safe-area-inset-top))] pb-16 md:px-6">
        <h1 className="px-1 text-[20px] font-semibold tracking-tight">Clipboard</h1>
        <p className="mt-1 px-1 text-[13px] text-muted-foreground">Snips and screenshots that sync between your devices.</p>

        <div className="mt-5 rounded-3xl bg-well p-2 shadow-[inset_0_0_0_1px_var(--well-outline),inset_0_1px_0_0_var(--well-highlight)]">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste or type something to save…"
            aria-label="New text clip"
            className="field-text block max-h-52 min-h-20 w-full resize-none overflow-y-auto bg-transparent px-2 py-1.5 outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-2 px-0.5 pb-0.5">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <IconPaperclip size={14} />
              Image
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={(event) => { void onFiles(event.target.files); event.target.value = ''; }} />
            </label>
            <button
              type="button"
              disabled={!text.trim() || addText.isPending}
              onClick={() => addText.mutate()}
              className="cursor-pointer rounded-full bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
            >
              {addText.isPending ? 'Saving…' : 'Save clip'}
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2">
          {clipsQuery.isPending ? (
            <div className="grid place-items-center py-16 text-muted-foreground"><IconLoader2 size={20} className="animate-spin" /></div>
          ) : clips.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <IconClipboardText size={22} className="text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">The clip tray is empty.</p>
            </div>
          ) : (
            clips.map((clip) => (
              <article key={clip.id} className="group/clip rounded-xl bg-well p-3.5 shadow-[inset_0_0_0_1px_var(--well-outline)]">
                {clip.kind === 'image' ? (
                  <img src={clip.dataUrl} alt="Image clip" className="max-h-72 w-full rounded-xl object-contain" loading="lazy" />
                ) : (
                  <p className="text-[13px]/6 break-words whitespace-pre-wrap">{clip.text}</p>
                )}
                <div className="mt-2.5 flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {[clip.device, clip.created ? timeAgo(clip.created) : ''].filter(Boolean).join(' · ')}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {clip.kind === 'text' && (
                      <button
                        type="button"
                        aria-label="Copy clip"
                        onClick={() => {
                          navigator.clipboard.writeText(clip.text || '').then(() => {
                            setCopiedId(clip.id);
                            window.setTimeout(() => setCopiedId(undefined), 1400);
                          }).catch(() => onToast('Could not copy the clip.', true));
                        }}
                        className="grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {copiedId === clip.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Delete clip"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(clip.id)}
                      className="grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
