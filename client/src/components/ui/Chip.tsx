import * as React from 'react';
import { cn } from '../../lib/utils';

export type ChipTone = 'neutral' | 'accent' | 'talking' | 'reading' | 'danger';

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 24px (default) or the 20px inline variant used inside rows and wells. */
  size?: 'sm' | 'md';
  /**
   * `talking` / `reading` carry a light token and therefore an assertion: a
   * person is in that room right now (spec §0). Never pick them for emphasis.
   */
  tone?: ChipTone;
  /** Render as a button — for a dismissible or selectable chip. */
  as?: 'span' | 'button';
}

const TONES: Record<ChipTone, string> = {
  neutral: 'text-text-secondary',
  accent: 'text-accent-primary',
  talking: 'text-light-white',
  reading: 'text-light-amber',
  danger: 'text-accent-danger',
};

/**
 * Chip — a small raised pill for a count, a shortcut, a filter or a label
 * (spec §3: radius 7, height 24). Depth is one warm inset highlight.
 */
export const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { size = 'md', tone = 'neutral', as = 'span', className, children, ...props },
  ref,
) {
  const Tag = as as React.ElementType;
  return (
    <Tag
      ref={ref}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap',
        'rounded-[var(--radius-chip)] bg-bg-raised shadow-[var(--shadow-chip)]',
        'font-medium tabular-nums',
        size === 'sm'
          ? 'h-[var(--h-chip-sm)] px-1.5 text-[11px]'
          : 'h-[var(--h-chip)] px-2 text-meta',
        TONES[tone],
        as === 'button' &&
          // No `transition-colors` beside `pc-pressable`: the recipe's list
          // already covers color and carries the §5.1 press with it.
          'pc-focusable pc-pressable hover:bg-bg-mod-strong hover:text-text-primary',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
});
