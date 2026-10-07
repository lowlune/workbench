import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconTerminal2,
} from '@tabler/icons-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChatRow } from '@/components/whirl/chat-row';
import { Composer } from '@/components/whirl/composer';
import { HomeGreeting, HomeSuggestions } from '@/components/whirl/home-intro';
import type { Attachment } from '@/lib/attachments';
import type { Agent, Overview, Session } from '@/lib/types';
import { cn, shortDirectory } from '@/lib/utils';

/* The home face: greeting over the composer (Whirl's centered dock), then
   Workbench's live agents and recent conversations right underneath. */
export function HomeView({
  overview,
  draft,
  attachments,
  sending,
  onDraftChange,
  onAttachmentsChange,
  onNewTask,
  onOpenSession,
  onOpenAgent,
  onHistory,
  onToast,
  onContextMenu,
  onMenuAt,
  focusSignal,
  onStart,
}: {
  overview: Overview;
  draft: string;
  attachments: Attachment[];
  sending: boolean;
  onDraftChange: (value: string) => void;
  onAttachmentsChange: (value: Attachment[]) => void;
  onStart: (input: { directory: string; kind: 'opencode' | 'pi' }) => Promise<void>;
  onNewTask: () => void;
  onOpenSession: (session: Session) => void;
  onOpenAgent: (agent: Agent) => void;
  onOutput?: (agent: Agent) => void;
  onHistory: () => void;
  onToast: (message: string, isError?: boolean) => void;
  onContextMenu?: (event: ReactMouseEvent, session: Session) => void;
  onMenuAt?: (x: number, y: number, session: Session) => void;
  focusSignal?: number;
}) {
  const agents = (overview.agents || []).filter((agent) => agent.status !== 'unknown');
  const sessions = (overview.sessions || []).slice(0, 6);
  const directories = overview.directories || [];
  /* ChatGPT-style: the project is a chip on the composer, defaulting to the
     one last used. No dialog in the way of typing the first message. */
  const [directory, setDirectory] = useState('');
  const [kind, setKind] = useState<'opencode' | 'pi'>('opencode');
  useEffect(() => {
    if (!directories.length) return;
    setDirectory((current) => {
      if (current && directories.some((item) => item.directory === current)) return current;
      try {
        const saved = localStorage.getItem('workbench-last-directory') || '';
        if (saved && directories.some((item) => item.directory === saved)) return saved;
      } catch { /* No saved preference. */ }
      return directories[0].directory;
    });
  }, [directories]);

  return (
    <div className="wb-scroll h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col px-3 pt-[max(3rem,env(safe-area-inset-top))] pb-16 md:px-6">
        <HomeGreeting />
        <div className="mb-2 flex items-center gap-1.5 px-1">
          <ProjectChip directories={directories} value={directory} onChange={setDirectory} />
          <KindChip value={kind} onChange={setKind} />
          {sending && <span className="ml-auto text-[11px] text-muted-foreground">Starting…</span>}
        </div>
        <Composer
          draft={draft}
          attachments={attachments}
          onDraftChange={onDraftChange}
          onAttachmentsChange={onAttachmentsChange}
          onSend={() => onStart({ directory, kind })}
          isGenerating={sending}
          disabled={sending || !directory}
          placeholder={directory ? 'Describe a task for your agents…' : 'Add a project first…'}
          focusSignal={focusSignal}
          onToast={onToast}
        />
        <HomeSuggestions onPick={onDraftChange} />

        {agents.length > 0 && (
          <section className="mt-10 flex flex-col gap-2">
            <SectionHead title="Live agents" />
            <div className="grid gap-2 sm:grid-cols-2">
              {agents.map((agent) => (
                <article key={agent.paneId} className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-well p-3.5 shadow-[inset_0_0_0_1px_var(--well-outline),inset_0_1px_0_0_var(--well-highlight)]">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span aria-hidden="true" className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      agent.status === 'working' ? 'animate-pulse bg-foreground'
                        : agent.status === 'blocked' ? 'bg-destructive'
                          : 'bg-muted-foreground/50',
                    )} />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{agent.sessionTitle || agent.title || agent.agent}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {agent.agent}
                        {agent.cwd ? ` · ${shortDirectory(agent.cwd)}` : ''}
                        {agent.status === 'working' ? ' · thinking' : agent.status === 'blocked' ? ' · needs approval' : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenAgent(agent)}
                      className="cursor-pointer rounded-full bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96]"
                    >
                      Open chat
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="mt-10 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <SectionHead title="Recent conversations" />
            <button
              type="button"
              onClick={onHistory}
              className="inline-flex cursor-pointer items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              View all
              <IconArrowUpRight size={13} />
            </button>
          </div>
          {sessions.length === 0 ? (
            <p className="px-1 text-[13px] text-muted-foreground">Nothing yet — start a task above.</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {sessions.map((session) => (
                <ChatRow
                  key={session.id}
                  session={session}
                  onOpen={onOpenSession}
                  onContextMenu={onContextMenu}
                  onMenuAt={onMenuAt}
                />
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onNewTask}
            className="mt-2 w-fit cursor-pointer rounded-full bg-well px-3.5 py-2 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--well-outline)] transition-colors duration-150 hover:bg-accent"
          >
            Start a new task
          </button>
        </section>
      </div>
    </div>
  );
}

function SectionHead({ title }: { title: string }) {
  return <h2 className="flex h-5 items-center px-1 text-[10.5px]/4 font-medium text-muted-foreground/55">{title}</h2>;
}

const CHIP_CLASS =
  'inline-flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-full bg-well px-2.5 text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--well-outline)] transition-colors duration-150 hover:bg-accent hover:text-foreground';

/* The project the task will run in — a chip, not a dialog step. */
function ProjectChip({
  directories,
  value,
  onChange,
}: {
  directories: Overview['directories'];
  value: string;
  onChange: (directory: string) => void;
}) {
  const current = directories.find((item) => item.directory === value);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" className={CHIP_CLASS} aria-label="Choose project" />
        }
      >
        <IconFolder size={13} className="shrink-0" />
        <span className="truncate">{current?.name || shortDirectory(value) || 'Choose project'}</span>
        <IconChevronDown size={12} className="shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="max-h-72 w-64 overflow-y-auto p-1">
        {directories.map((item) => (
          <button
            key={item.directory}
            type="button"
            onClick={() => onChange(item.directory)}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors duration-75 hover:bg-accent"
          >
            <IconFolder size={14} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.directory === value && <IconCheck size={14} className="shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function KindChip({ value, onChange }: { value: 'opencode' | 'pi'; onChange: (kind: 'opencode' | 'pi') => void }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" className={CHIP_CLASS} aria-label="Choose agent" />
        }
      >
        <IconTerminal2 size={13} className="shrink-0" />
        <span>{value === 'pi' ? 'Pi' : 'OpenCode'}</span>
        <IconChevronDown size={12} className="shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-48 p-1">
        {(['opencode', 'pi'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors duration-75 hover:bg-accent"
          >
            <span className="min-w-0 flex-1">{option === 'pi' ? 'Pi' : 'OpenCode'}</span>
            {value === option && <IconCheck size={14} className="shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
