import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', {
  variants: {
    variant: {
      default: 'border-border bg-muted text-muted-foreground',
      working: 'border-success/25 bg-success/10 text-success',
      blocked: 'border-warning/25 bg-warning/10 text-warning',
      destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
