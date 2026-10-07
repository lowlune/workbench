import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-md bg-well px-3 text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--well-outline)] outline-none transition-shadow placeholder:text-muted-foreground focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--foreground)_6%,transparent)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
