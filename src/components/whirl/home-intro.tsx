import {
  IconBug,
  IconChecklist,
  IconGitCompare,
  IconMap2,
} from '@tabler/icons-react';

const SUGGESTIONS = [
  { prompt: 'Review my latest changes and flag anything risky', Icon: IconGitCompare },
  { prompt: 'Explain how this project is structured', Icon: IconMap2 },
  { prompt: 'Fix the failing tests and summarise what broke', Icon: IconBug },
  { prompt: 'Draft a plan for the next feature', Icon: IconChecklist },
];

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/* Whirl's home header: the mark beside the greeting in a fixed 40px slot.
   No personalization here — Workbench signs in with a shared key. */
export function HomeGreeting() {
  return (
    <div className="mb-7 flex h-10 items-center justify-center gap-3">
      <img src="/icon.svg" alt="" className="size-8 shrink-0" />
      <h1 className="min-w-0 truncate text-[22px]/8 font-medium tracking-tight md:text-[28px]/9">
        {greeting()}
      </h1>
    </div>
  );
}

/* The starters, Whirl-shaped: one slim capsule per line, an icon at the
   left and the prompt in muted ink that brightens under the pointer.
   Picking one fills the composer rather than sending it. */
export function HomeSuggestions({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mt-3 flex flex-col gap-1">
      {SUGGESTIONS.map(({ prompt, Icon }) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          className="group flex h-9 w-full cursor-pointer items-center gap-2 rounded-full bg-well px-3.5 text-left shadow-[inset_0_0_0_1px_var(--well-outline),inset_0_1px_0_0_var(--well-highlight)] transition-[background-color] duration-150 hover:bg-[color-mix(in_oklch,var(--well),var(--foreground)_5%)]"
        >
          <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
            <Icon size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]/[18px] text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
            {prompt}
          </span>
        </button>
      ))}
    </div>
  );
}
