import * as React from 'react';
import { cn } from '../../lib/utils';

export type ChipTone = 'neutral' | 'accent' | 'talking' | 'reading' | 'danger';

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 24px (default) or the 20px inline variant used inside rows and wells. */
  size?: 'sm' | 'md';
  /**
   * `talking` / `reading` are amber and therefore an assertion: somebody is
   * live right now ("amber means live", §1.4). Never pick them for emphasis.
   */
  tone?: ChipTone;
  /** Render as a button — for a dismissible or selectable chip. */
  as?: 'span' | 'button';
}

const TONES: Record<ChipTone, string> = {
  neutral: 'text-[var(--ix-ink-2)]',
  accent: 'text-[var(--ix-ink)]',
  talking: 'text-[var(--ix-amber)]',
  reading: 'text-[var(--ix-amber)]',
  danger: 'text-[var(--ix-danger-ink)]',
};

/**
 * Chip: a small flat chip for a count, a shortcut, a filter or a label
 * (docs/index-spec.md §3.1 tool chips: radius 8, the quiet fill, 12.5 ink-2),
 * with no outline. Counts and durations in it are tabular figures.
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
        'rounded-[8px] bg-[var(--ix-fill)]',
        'font-medium tabular-nums',
        size === 'sm'
          ? 'h-[var(--h-chip-sm)] px-1.5 text-[11px] font-bold'
          : 'h-[var(--h-chip)] px-2 text-[12.5px]',
        TONES[tone],
        as === 'button' &&
          'pc-focusable cursor-pointer transition-[background-color,color] duration-[40ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-2)] hover:text-[var(--ix-ink)]',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
});
