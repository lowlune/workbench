import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import {
  IconAlertTriangle,
  IconBinary,
  IconCopy,
  IconDownload,
  IconFile,
  IconFilePencil,
  IconFileText,
  IconLoader2,
  IconPhoto,
  IconX,
} from '@tabler/icons-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type FileStatus = 'read' | 'changed' | 'created' | 'deleted';

/** A reference to a file the viewer can open. `projectId` reads through the
 *  project file endpoint; `url`/`attachmentId` cover uploaded attachments. */
export interface FileRef {
  path: string;
  status: FileStatus;
  projectId?: string | null;
  additions?: number;
  deletions?: number;
  attachmentId?: string;
  url?: string;
  name?: string;
}

const MAX_LINES = 5000;

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cxx: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash',
  fish: 'bash', sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  diff: 'diff', patch: 'diff', lua: 'lua', r: 'r', pl: 'perl', makefile: 'makefile',
  dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql',
};

function languageFor(path: string) {
  const name = path.split('/').pop() || '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : name.toLowerCase();
  return LANGUAGES[ext] || '';
}

function baseName(path: string) {
  return path.split('/').filter(Boolean).pop() || path;
}

function mimeLooksText(mime: string) {
  if (!mime) return true;
  if (mime.startsWith('text/')) return true;
  return /json|xml|javascript|ecmascript|svg|csv|yaml|markdown|x-sh|toml|graphql/.test(mime);
}

function looksBinary(bytes: Uint8Array, mime: string) {
  if (mime.startsWith('image/')) return false;
  if (mime && !mimeLooksText(mime)) return true;
  const sample = Math.min(bytes.length, 8192);
  let suspicious = 0;
  for (let index = 0; index < sample; index += 1) {
    const byte = bytes[index];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample > 0 && suspicious / sample > 0.1;
}

function statusIcon(status: FileStatus): ReactNode {
  if (status === 'changed') return <IconFilePencil size={13} />;
  if (status === 'read') return <IconFileText size={13} />;
  return <IconFile size={13} />;
}

const STATUS_TONE: Record<FileStatus, string> = {
  read: 'text-muted-foreground',
  changed: 'text-amber-600 dark:text-amber-400',
  created: 'text-emerald-600 dark:text-emerald-400',
  deleted: 'text-destructive',
};

/** Inline, clickable file reference used across the thread. */
export function FileLink({ file, onOpen, className }: { file: FileRef; onOpen?: (file: FileRef) => void; className?: string }) {
  const name = file.name || baseName(file.path);
  const clickable = Boolean(onOpen);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => onOpen?.(file)}
      title={file.path}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[12px] transition-colors duration-100',
        clickable ? 'cursor-pointer hover:bg-accent' : 'cursor-default',
        className,
      )}
    >
      <span className={cn('shrink-0', STATUS_TONE[file.status])}>{statusIcon(file.status)}</span>
      <span className="truncate text-foreground">{name}</span>
      {(file.additions ?? 0) > 0 && <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
      {(file.deletions ?? 0) > 0 && <span className="shrink-0 tabular-nums text-destructive">-{file.deletions}</span>}
    </button>
  );
}

function resolveUrl(file: FileRef): string | null {
  if (file.url) return file.url;
  const path = file.path || '';
  if (path.startsWith('/api/') || /^https?:\/\//.test(path) || path.startsWith('blob:') || path.startsWith('data:')) return path;
  if (file.attachmentId) return `/api/v2/attachments/${encodeURIComponent(file.attachmentId)}`;
  if (file.projectId) return `/api/v2/projects/${encodeURIComponent(file.projectId)}/file?path=${encodeURIComponent(path)}`;
  return null;
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'text'; text: string; language: string; truncated: boolean; size: number; blobUrl: string }
  | { kind: 'image'; url: string; size: number; mime: string; blobUrl: string }
  | { kind: 'binary'; size: number; mime: string; blobUrl: string }
  | { kind: 'error'; message: string };

/** A full-screen-ish file peek: highlighted code with line numbers, image
 *  previews, and download fallbacks for anything binary. */
export function FileViewer({ open, file, onOpenChange, onToast }: {
  open: boolean;
  file?: FileRef | null;
  onOpenChange: (open: boolean) => void;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const blobRef = useRef('');
  const key = file ? `${file.projectId || ''}:${file.attachmentId || ''}:${file.url || ''}:${file.path}` : '';

  useEffect(() => {
    if (!open || !file) return;
    const controller = new AbortController();
    let current = '';
    setLoaded({ kind: 'loading' });
    (async () => {
      const url = resolveUrl(file);
      if (!url) {
        setLoaded({ kind: 'error', message: 'This file has no accessible source.' });
        return;
      }
      try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Could not open this file (${response.status}).`);
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
        const buffer = await response.arrayBuffer();
        const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
        current = URL.createObjectURL(blob);
        blobRef.current = current;
        const bytes = new Uint8Array(buffer);
        if (mime.startsWith('image/')) {
          setLoaded({ kind: 'image', url: current, size: buffer.byteLength, mime, blobUrl: current });
          return;
        }
        if (looksBinary(bytes, mime)) {
          setLoaded({ kind: 'binary', size: buffer.byteLength, mime: mime || 'application/octet-stream', blobUrl: current });
          return;
        }
        const text = new TextDecoder('utf-8').decode(bytes);
        const lines = text.split('\n');
        const truncated = lines.length > MAX_LINES;
        setLoaded({
          kind: 'text',
          text: truncated ? lines.slice(0, MAX_LINES).join('\n') : text,
          language: languageFor(file.path),
          truncated,
          size: buffer.byteLength,
          blobUrl: current,
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        setLoaded({ kind: 'error', message: error instanceof Error ? error.message : 'Could not open this file.' });
      }
    })();
    return () => {
      controller.abort();
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current);
        blobRef.current = '';
      }
    };
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = useCallback(() => {
    if (loaded.kind !== 'text') return;
    navigator.clipboard.writeText(loaded.text).then(() => onToast('File copied.')).catch(() => onToast('Clipboard access was refused.', true));
  }, [loaded, onToast]);

  const downloadName = file?.name || (file ? baseName(file.path) : 'file');
  const size = loaded.kind === 'text' || loaded.kind === 'image' || loaded.kind === 'binary' ? loaded.size : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[5vh] flex h-[85vh] w-[calc(100vw-1.5rem)] max-w-4xl flex-col overflow-hidden p-0">
        <DialogTitle className="sr-only">{file ? baseName(file.path) : 'File'}</DialogTitle>
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className={cn('shrink-0', file ? STATUS_TONE[file.status] : 'text-muted-foreground')}>
            {loaded.kind === 'image' ? <IconPhoto size={15} /> : loaded.kind === 'binary' ? <IconBinary size={15} /> : <IconFileText size={15} />}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={file?.path}>{file?.path}</span>
          {size > 0 && <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline">{formatBytes(size)}</span>}
          {loaded.kind === 'text' && (
            <button type="button" onClick={copy} className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Copy file" title="Copy">
              <IconCopy size={15} />
            </button>
          )}
          {(loaded.kind === 'text' || loaded.kind === 'image' || loaded.kind === 'binary') && (
            <a href={loaded.blobUrl} download={downloadName} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Download file" title="Download">
              <IconDownload size={15} />
            </a>
          )}
          <button type="button" onClick={() => onOpenChange(false)} className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Close" title="Close">
            <IconX size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 bg-well">
          {loaded.kind === 'loading' ? (
            <div className="grid h-full place-items-center text-muted-foreground"><IconLoader2 size={20} className="animate-spin" /></div>
          ) : loaded.kind === 'error' ? (
            <div className="grid h-full place-items-center p-6 text-center">
              <div className="max-w-sm">
                <IconAlertTriangle size={22} className="mx-auto text-destructive" />
                <p className="mt-2 text-[13px]/5 text-muted-foreground">{loaded.message}</p>
              </div>
            </div>
          ) : loaded.kind === 'image' ? (
            <div className="wb-scroll grid h-full place-items-center overflow-auto p-4">
              <img src={loaded.url} alt={downloadName} className="max-h-full max-w-full rounded-lg object-contain shadow-[inset_0_0_0_1px_var(--well-outline)]" />
            </div>
          ) : loaded.kind === 'binary' ? (
            <div className="grid h-full place-items-center p-6 text-center">
              <div className="max-w-sm">
                <IconBinary size={24} className="mx-auto text-muted-foreground" />
                <p className="mt-2 text-[13px] font-medium">Binary file</p>
                <p className="mt-1 text-[12px]/5 text-muted-foreground">{loaded.mime} · {formatBytes(loaded.size)}</p>
                <a href={loaded.blobUrl} download={downloadName} className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-(--primary-hover)">
                  <IconDownload size={15} /> Download
                </a>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              {loaded.truncated && (
                <p className="shrink-0 border-b border-border bg-well px-3 py-1.5 text-[11px] text-muted-foreground">Showing the first {MAX_LINES.toLocaleString()} lines.</p>
              )}
              <HighlightedCode text={loaded.text} language={loaded.language} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Code with a sticky line-number gutter. rehype-highlight paints through the
 *  shared `.hljs-*` classes; unknown languages stay plain. */
function HighlightedCode({ text, language }: { text: string; language: string }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <div className="wb-scroll h-full overflow-auto">
      <ReactMarkdown
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => (
            <div className="flex min-w-full items-start">
              <pre aria-hidden="true" className="sticky left-0 z-10 shrink-0 select-none border-r border-[var(--well-outline)] bg-well px-3 py-2 text-right font-mono text-[12px]/5 text-muted-foreground/60">
                {lines.map((_, index) => <div key={index}>{index + 1}</div>)}
              </pre>
              <pre className="min-w-0 flex-1 px-3 py-2 font-mono text-[12px]/5 whitespace-pre">{children}</pre>
            </div>
          ),
        }}
      >{`\`\`\`${language}\n${text}\n\`\`\``}</ReactMarkdown>
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
