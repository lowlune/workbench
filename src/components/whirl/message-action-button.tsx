import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/* Whirl's hover-revealed message action: a quiet round icon button that
   surfaces a tooltip the moment the pointer lands. */
export function MessageActionButton({
  label,
  tooltip,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className="grid size-7 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
          >
            {children}
          </button>
        }
      />
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
