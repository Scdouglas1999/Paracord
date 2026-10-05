import * as React from 'react';
import { cn } from '../../lib/utils';

export type IconButtonSize = 'sm' | 'md' | 'lg' | 'stage';
export type IconButtonTone = 'ghost' | 'raised' | 'light' | 'danger';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Required. An icon-only control has no visible text, so its name has to come
   * from here (spec §9 — and every light state needs a text equivalent anyway).
   */
  label: string;
  /** 28 / 36 / 44 / 46 (the Stage control). Phone surfaces use `lg` or `stage`. */
  size?: IconButtonSize;
  /**
   * `light` is the cream fill (Join) and means it is for you / your mic is
   * live: state, never emphasis (§1.3). `raised` is the glass circle.
   */
  tone?: IconButtonTone;
  /** Pressed/selected state; also sets `aria-pressed`. */
  active?: boolean;
}

const SIZES: Record<IconButtonSize, string> = {
  sm: 'h-[var(--h-control-sm)] w-[var(--h-control-sm)] rounded-[9px]',
  md: 'h-9 w-9 rounded-[11px]',
  lg: 'h-[var(--h-control-phone)] w-[var(--h-control-phone)] rounded-[12px]',
  // The call view's controls are 46 tall at radius 23 (§3.1): a circle.
  stage: 'h-[var(--h-stage-control)] w-[var(--h-stage-control)] rounded-full',
};

// An icon-only control is a quiet tile (§3.1: 36x36, radius 11): transparent
// until you reach for it, a control fill when it is the raised kind. Hover is one
// step lighter, press one step darker, and a pressed toggle is the lit fill.
const TONES: Record<IconButtonTone, string> = {
  ghost:
    'bg-transparent text-[var(--ix-ink-2)] hover:bg-[var(--ix-fill)] hover:text-[var(--ix-ink)] active:bg-[var(--ix-fill-2)]',
  raised:
    'bg-[var(--ix-fill-ctl)] text-[var(--ix-ink-2)] hover:bg-[var(--ix-fill-ctl-hover)] hover:text-[var(--ix-ink)] active:bg-[var(--ix-fill-2)]',
  light:
    'bg-accent-primary text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active',
  danger:
    'bg-[var(--ix-danger-fill)] text-[var(--ix-danger-ink)] hover:bg-[var(--ix-danger-fill-call)] active:bg-[var(--ix-danger-fill-call)]',
};

/**
 * IconButton: an icon-only control (docs/index-spec.md §3.1), 28 / 36 / 44, and
 * 46 for a call control. Pass the icon as the child and its name as `label`.
 * Hover is one step lighter, press one step darker, 40ms; nothing scales.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { label, size = 'md', tone = 'ghost', active = false, className, children, type = 'button', ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        aria-pressed={active || undefined}
        className={cn(
          'pc-focusable inline-flex shrink-0 select-none items-center justify-center',
          'transition-[background-color,color] duration-[40ms] ease-[var(--ix-ease)]',
          'disabled:pointer-events-none disabled:opacity-[.45]',
          SIZES[size],
          TONES[tone],
          active &&
            (tone === 'ghost' || tone === 'raised') &&
            'bg-[var(--ix-fill-2)] text-[var(--ix-ink)] hover:bg-[var(--ix-fill-2)]',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
