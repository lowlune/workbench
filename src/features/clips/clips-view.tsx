import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardText, Copy, FileImage, Image, Plus, Trash } from '@phosphor-icons/react';
import { api, getClips, postJson } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { Clip } from '@/lib/types';
import { formatTime } from '@/lib/utils';

function deviceName() {
  const platform = navigator.platform || 'This device';
  return platform.slice(0, 40);
}

function fileToDataUrl(file: File) {
  const supported = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!supported.has(file.type)) return Promise.reject(new Error('Choose a JPEG, PNG, WebP, or GIF image.'));
  if (file.size > 5 * 1024 * 1024) return Promise.reject(new Error('Images must be 5 MB or smaller.'));
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
}

export function ClipsView({ onToast }: { onToast: (message: string, isError?: boolean) => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const clipsQuery = useQuery({
    queryKey: ['clips'],
    queryFn: getClips,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  });
  const saveText = useMutation({
    mutationFn: (value: string) => postJson<{ clip: Clip }>('/api/clips', { kind: 'text', text: value, device: deviceName() }),
    onSuccess: async () => {
      setText('');
      await queryClient.invalidateQueries({ queryKey: ['clips'] });
      onToast('Saved to your clip tray.');
    },
    onError: (error) => onToast(error.message, true),
  });
  const clips = clipsQuery.data?.clips || [];

  async function addImage(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      await postJson('/api/clips', { kind: 'image', dataUrl, device: deviceName() });
      await queryClient.invalidateQueries({ queryKey: ['clips'] });
      onToast('Image saved to your clip tray.');
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not save this image.', true);
    } finally { setBusy(false); }
  }

  async function pasteFromClipboard() {
    if (!window.isSecureContext) return onToast('System clipboard requires a secure HTTPS connection.', true);
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((itemType) => itemType.startsWith('image/'));
          if (type) {
            const blob = await item.getType(type);
            const ext = type.split('/')[1] || 'img';
            return void await addImage(new File([blob], `clipboard-${Date.now()}.${ext}`, { type }));
          }
          if (item.types.includes('text/plain')) {
            setText(await (await item.getType('text/plain')).text());
            return;
          }
        }
      }
      if (navigator.clipboard.readText) {
        const value = await navigator.clipboard.readText();
        if (value) setText(value);
        else onToast('The clipboard is empty.', true);
      } else onToast('Clipboard access is unavailable in this browser.', true);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Clipboard permission was not granted.', true);
    }
  }

  async function deleteClip(clip: Clip) {
    try {
      await api(`/api/clips/${encodeURIComponent(clip.id)}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['clips'] });
      onToast('Clip deleted.');
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not delete this clip.', true); }
  }

  async function copyClip(clip: Clip) {
    try {
      if (clip.kind === 'text') {
        await navigator.clipboard.writeText(clip.text || '');
      } else if (navigator.clipboard.write && clip.mime) {
        const response = await fetch(`/api/clips/${encodeURIComponent(clip.id)}/data`);
        if (!response.ok) throw new Error('Image is no longer available.');
        const blob = await response.blob();
        await navigator.clipboard.write([new ClipboardItem({ [clip.mime]: blob })]);
      } else throw new Error('This browser does not support copying images.');
      onToast('Copied to clipboard.');
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not copy this clip.', true); }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-7 px-4 py-7 sm:px-7 sm:py-9">
      <header>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">Across your devices</p>
        <h1 className="text-2xl font-semibold tracking-tight">Clip tray</h1>
        <p className="mt-2 text-sm text-muted-foreground">Keep a snippet or screenshot nearby, then copy it where you need it.</p>
      </header>

      <section className="rounded-2xl border border-border bg-panel p-3 shadow-sm sm:p-4" aria-labelledby="new-clip-title">
        <h2 id="new-clip-title" className="sr-only">Add a clip</h2>
        <label htmlFor="clip-text" className="sr-only">Text to save</label>
        <Textarea id="clip-text" value={text} onChange={(event) => setText(event.target.value)} maxLength={50_000} placeholder="Paste or write something to keep…" className="min-h-24 resize-y border-0 px-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0" onPaste={(event) => {
          const file = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile();
          if (file) { event.preventDefault(); void addImage(file); }
        }} />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => void pasteFromClipboard()}><ClipboardText aria-hidden="true" /> Paste</Button>
            <input ref={imageInput} className="sr-only" tabIndex={-1} type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="Choose image" onChange={(event) => { void addImage(event.target.files?.[0]); event.target.value = ''; }} />
            <Button type="button" variant="ghost" size="sm" onClick={() => imageInput.current?.click()} disabled={busy}><Image aria-hidden="true" /> Add image</Button>
          </div>
          <Button type="button" onClick={() => saveText.mutate(text)} disabled={!text.trim() || saveText.isPending || busy}>
            <Plus aria-hidden="true" />{saveText.isPending ? 'Saving…' : 'Save clip'}
          </Button>
        </div>
      </section>

      {clipsQuery.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm" role="alert">{clipsQuery.error.message}<Button size="sm" variant="outline" className="ml-3" onClick={() => void clipsQuery.refetch()}>Retry</Button></div>
      ) : clipsQuery.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading clips">{[0, 1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl bg-muted" />)}</div>
      ) : clips.length ? (
        <section aria-label="Saved clips" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clips.map((clip) => (
            <article key={clip.id} className="group overflow-hidden rounded-2xl border border-border bg-panel">
              {clip.kind === 'image' ? (
                <img src={`/api/clips/${encodeURIComponent(clip.id)}/data`} alt={clip.filename || 'Saved image'} loading="lazy" className="h-44 w-full border-b border-border bg-muted object-contain" />
              ) : (
                <div className="max-h-44 min-h-28 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5">{clip.text}</div>
              )}
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{clip.device || 'This device'}</p>
                  <time className="text-[11px] text-muted-foreground" dateTime={clip.created ? new Date(Number(clip.created)).toISOString() : undefined}>{formatTime(clip.created, true)}</time>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => void copyClip(clip)} aria-label={`Copy ${clip.kind === 'image' ? 'image' : 'text'} clip`}><Copy aria-hidden="true" size={16} /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => void deleteClip(clip)} aria-label="Delete clip"><Trash aria-hidden="true" size={16} /></Button>
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-panel p-9 text-center">
          <FileImage aria-hidden="true" size={28} className="mx-auto text-muted-foreground" />
          <h2 className="mt-3 text-sm font-semibold">Nothing in your clip tray yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">Paste a snippet or add a screenshot to move it between devices.</p>
        </div>
      )}
    </div>
  );
}
