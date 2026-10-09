import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IconChecklist,
  IconChevronRight,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconFileSearch,
  IconFileText,
  IconGitBranch,
  IconLoader2,
  IconTerminal2,
  IconTool,
} from '@tabler/icons-react';
import { FileLink, type FileRef } from '@/components/whirl/file-link';
import { v2 } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import type {
  CommandView,
  FileChangeView,
  FileReadView,
  FileSearchView,
  GenericView,
  GitView,
  TestView,
  TodoView,
  ToolStatus,
  ToolView,
} from '@/components/whirl/thread/tool-data';

type OpenFile = (file: FileRef) => void;

/* Quiet, single-line tool activity: no cards, no wells — the transcript stays
   the main readable thing. Details expand inline only when asked for. */

const ROW = 'flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-[12.5px] text-muted-foreground';
const ICON = 'shrink-0 text-muted-foreground/70';
const EXPANDED = 'wb-scroll mt-1 mb-1 ml-[7px] max-h-72 overflow-auto border-l border-border pl-3 font-mono text-[11px]/5 break-words whitespace-pre-wrap text-muted-foreground';

function isActive(status: ToolStatus) {
  return status === 'running' || status === 'pending' || status === 'starting';
}

function Spinner() {
  return <IconLoader2 size={12} className="ml-auto shrink-0 animate-spin text-muted-foreground/70" />;
}

export function ToolRenderer({ view, onOpenFile }: { view: ToolView; onOpenFile?: OpenFile }) {
  switch (view.kind) {
    case 'file-changed': return <FileChangedRow view={view} onOpenFile={onOpenFile} />;
    case 'file-read': return <FileReadRow view={view} />;
    case 'file-search': return <FileSearchRow view={view} />;
    case 'command': return <CommandRow view={view} />;
    case 'test': return <TestRow view={view} />;
    case 'git': return <GitRow view={view} onOpenFile={onOpenFile} />;
    case 'todo': return <TodoRow view={view} />;
    default: return <GenericRow view={view} />;
  }
}

function FileChangedRow({ view, onOpenFile }: { view: FileChangeView; onOpenFile?: OpenFile }) {
  const tone = view.change === 'created' ? 'text-emerald-600/80 dark:text-emerald-400/80'
    : view.change === 'deleted' ? 'text-destructive/80'
      : 'text-amber-600/80 dark:text-amber-400/80';
  const verb = view.change === 'created' ? 'Added' : view.change === 'deleted' ? 'Deleted' : 'Edited';
  return (
    <div className={ROW}>
      <IconFileText size={13} className={cn('shrink-0', tone)} />
      <span className="shrink-0">{verb}</span>
      <FileLink file={{ path: view.path, status: view.change === 'created' ? 'created' : view.change === 'deleted' ? 'deleted' : 'changed', additions: view.additions, deletions: view.deletions }} onOpen={onOpenFile} className="text-[12px]" />
      {isActive(view.status) && <Spinner />}
    </div>
  );
}

function FileReadRow({ view }: { view: FileReadView }) {
  return (
    <div className={ROW}>
      <IconFileText size={13} className={ICON} />
      <span className="truncate">{view.listing ? 'Listed' : 'Read'} <span className="font-mono text-foreground/70">{view.path}</span></span>
      {isActive(view.status) && <Spinner />}
    </div>
  );
}

function FileSearchRow({ view }: { view: FileSearchView }) {
  return (
    <div className={ROW}>
      <IconFileSearch size={13} className={ICON} />
      <span className="truncate">Searched <span className="font-mono text-foreground/70">{view.query}</span></span>
      {isActive(view.status) && <Spinner />}
    </div>
  );
}

function CommandRow({ view }: { view: CommandView }) {
  const [open, setOpen] = useState(false);
  const output = view.output || '';
  const exit = view.exitCode;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="wb-disclosure group/cmd min-w-0">
      <summary className={cn(ROW, 'cursor-pointer list-none marker:hidden tool-row [&::-webkit-details-marker]:hidden')}>
        <IconTerminal2 size={13} className={ICON} />
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/70">{view.command}</code>
        {isActive(view.status)
          ? <Spinner />
          : exit !== null && (
            <span className={cn('shrink-0 tabular-nums text-[11px]', exit === 0 ? 'text-muted-foreground/70' : 'text-destructive/80')}>
              {exit === 0 ? 'exit 0' : `exit ${exit}`}
            </span>
          )}
        {output && <IconChevronRight size={12} className="shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/cmd:rotate-90" />}
      </summary>
      {open && output && <pre className={EXPANDED}>{output}</pre>}
    </details>
  );
}

function TestRow({ view }: { view: TestView }) {
  const [open, setOpen] = useState(false);
  const failed = view.failed > 0;
  const total = view.passed + view.failed;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="wb-disclosure group/test min-w-0">
      <summary className={cn(ROW, 'cursor-pointer list-none marker:hidden tool-row [&::-webkit-details-marker]:hidden')}>
        <span className={cn('shrink-0', failed ? 'text-destructive/80' : 'text-emerald-600/80 dark:text-emerald-400/80')}>
          {isActive(view.status) ? <IconLoader2 size={13} className="animate-spin text-muted-foreground/70" /> : failed ? <IconCircleX size={13} /> : <IconCircleCheck size={13} />}
        </span>
        <span className="shrink-0 text-foreground/70">{failed ? 'Tests failed' : 'Tests passed'}</span>
        {total > 0 && <span className="min-w-0 flex-1 truncate text-[11.5px]">{view.passed} passed · {view.failed} failed</span>}
        {view.summary && !total && <span className="min-w-0 flex-1 truncate text-[11.5px]">{view.summary}</span>}
        {view.output && <IconChevronRight size={12} className="shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/test:rotate-90" />}
      </summary>
      {open && view.output && <pre className={EXPANDED}>{view.output}</pre>}
    </details>
  );
}

function GitRow({ view, onOpenFile }: { view: GitView; onOpenFile?: OpenFile }) {
  const [open, setOpen] = useState(false);
  const files = view.files;
  if (!files.length) {
    return (
      <div className={ROW}>
        <IconGitBranch size={13} className={ICON} />
        <span className="truncate">{view.summary || 'Git changes'}</span>
      </div>
    );
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="wb-disclosure group/git min-w-0">
      <summary className={cn(ROW, 'cursor-pointer list-none marker:hidden tool-row [&::-webkit-details-marker]:hidden')}>
        <IconGitBranch size={13} className={ICON} />
        <span className="shrink-0 text-foreground/70">Git changes</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px]">{files.length} file{files.length === 1 ? '' : 's'}</span>
        <IconChevronRight size={12} className="shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/git:rotate-90" />
      </summary>
      {open && (
        <ul className="mb-1 ml-[7px] border-l border-border pl-3">
          {files.map((file) => (
            <li key={file.path} className="flex min-w-0 items-center py-0.5">
              <FileLink file={{ path: file.path, status: 'changed', additions: file.additions, deletions: file.deletions }} onOpen={onOpenFile} className="text-[12px]" />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function TodoRow({ view }: { view: TodoView }) {
  const done = view.todos.filter((todo) => ['done', 'completed'].includes(String(todo.status || '').toLowerCase())).length;
  return (
    <div className="min-w-0 py-0.5">
      <div className={cn(ROW, 'hover:bg-transparent')}>
        <IconChecklist size={13} className={ICON} />
        <span className="shrink-0 text-foreground/70">Plan</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums">{done} / {view.todos.length}</span>
      </div>
      <ul className="mb-1 ml-[7px] border-l border-border pl-3">
        {view.todos.map((todo, index) => {
          const status = String(todo.status || '').toLowerCase();
          const complete = ['done', 'completed'].includes(status);
          return (
            <li key={todo.id || `${index}`} className="flex min-w-0 items-start gap-2 py-0.5 text-[12.5px]">
              <span className={cn('mt-0.5 shrink-0', complete ? 'text-emerald-600/70 dark:text-emerald-400/70' : 'text-muted-foreground/40')}>
                {complete ? <IconCircleCheck size={12} /> : <IconCircleDashed size={12} />}
              </span>
              <span className={cn('min-w-0 break-words', complete && 'text-muted-foreground/70 line-through')}>{todo.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GenericRow({ view }: { view: GenericView }) {
  const [open, setOpen] = useState(false);
  const artifact = useQuery({
    queryKey: ['artifact', view.artifactId],
    queryFn: () => v2<{ artifact: { input?: unknown; output?: string; error?: string } }>(`/artifacts/${view.artifactId}`),
    enabled: open && !!view.artifactId,
    staleTime: 30000,
  });
  const details = artifact.data?.artifact;
  const output = view.error || details?.error || view.output || details?.output || (details?.input ? JSON.stringify(details.input, null, 2) : view.input ? JSON.stringify(view.input, null, 2) : '');
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="wb-disclosure group/tool min-w-0">
      <summary className={cn(ROW, 'cursor-pointer list-none marker:hidden tool-row [&::-webkit-details-marker]:hidden')}>
        <IconTool size={13} className={ICON} />
        <span className="shrink-0 text-foreground/70">{view.tool}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px]">{view.title}</span>
        {isActive(view.status) && <Spinner />}
        {output && <IconChevronRight size={12} className="shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/tool:rotate-90" />}
      </summary>
      {open && (output || artifact.isPending || artifact.isError) && (
        <pre className={EXPANDED}>{artifact.isError ? artifact.error.message : output || 'Loading details…'}</pre>
      )}
    </details>
  );
}
