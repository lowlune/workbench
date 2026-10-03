import { useMemo, useState } from 'react';
import { ArrowRight, ChatCenteredText, ClipboardText, House, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { AppView } from '@/components/app-sidebar';

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: Exclude<AppView, 'chat'>) => void;
  onNewTask: () => void;
  shortcutLabel: string;
}

export function CommandMenu({ open, onOpenChange, onNavigate, onNewTask, shortcutLabel }: CommandMenuProps) {
  const [search, setSearch] = useState('');
  const commands = useMemo(() => [
    { label: 'Start a new task', detail: 'Create a task for an agent', Icon: Plus, action: () => { onOpenChange(false); onNewTask(); } },
    { label: 'Go to Home', detail: 'See active agents and recent conversations', Icon: House, action: () => { onOpenChange(false); onNavigate('home'); } },
    { label: 'Search conversations', detail: 'Find a conversation in history', Icon: MagnifyingGlass, action: () => { onOpenChange(false); onNavigate('history'); } },
    { label: 'Open clip tray', detail: 'Copy text and images between devices', Icon: ClipboardText, action: () => { onOpenChange(false); onNavigate('clips'); } },
  ], [onNavigate, onNewTask, onOpenChange]);
  const filtered = commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={(value) => { onOpenChange(value); if (!value) setSearch(''); }}>
      <DialogContent className="command-dialog top-[18vh] max-h-[min(70dvh,560px)] -translate-y-0 gap-0 overflow-hidden p-0 sm:top-[18vh]">
        <DialogHeader className="border-b border-border px-4 py-4">
          <DialogTitle className="text-base">Quick actions</DialogTitle>
          <DialogDescription className="sr-only">Search for a page or action.</DialogDescription>
        </DialogHeader>
        <label htmlFor="command-search" className="sr-only">Search actions</label>
        <div className="relative border-b border-border px-4 py-3">
          <MagnifyingGlass aria-hidden="true" size={18} className="absolute left-7 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input id="command-search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="What would you like to do?" className="border-0 pl-10 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0" />
        </div>
        <div className="max-h-[min(46dvh,360px)] overflow-y-auto p-2" aria-label="Actions">
          {filtered.length ? filtered.map(({ label, detail, Icon, action }) => (
            <button key={label} type="button" onClick={action} className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-accent focus-visible:bg-accent">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground group-hover:text-foreground"><Icon aria-hidden="true" size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{label}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
              </span>
              <ArrowRight aria-hidden="true" size={16} className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          )) : <p className="px-3 py-8 text-center text-sm text-muted-foreground">No matching actions.</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-[11px] text-muted-foreground"><ChatCenteredText aria-hidden="true" size={15} />Shortcut <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">{shortcutLabel}</kbd></div>
      </DialogContent>
    </Dialog>
  );
}
