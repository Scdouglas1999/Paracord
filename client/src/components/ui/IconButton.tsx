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
  sm: 'h-[var(--h-control-sm)] w-[var(--h-control-sm)]',
  md: 'h-9 w-9',
  lg: 'h-[var(--h-control-phone)] w-[var(--h-control-phone)]',
  stage: 'h-[var(--h-stage-control)] w-[var(--h-stage-control)]',
};

// An icon-only control is a circle (§1.5, GlassButton `icon`). Hover is one
// step lighter, press one step darker, and a pressed toggle is the "on" fill.
const TONES: Record<IconButtonTone, string> = {
  ghost:
    'bg-transparent text-text-secondary hover:bg-[var(--wash-hover)] hover:text-text-primary active:bg-[var(--wash-press)]',
  raised:
    'bg-[var(--glass-fill)] text-text-primary shadow-[var(--glass-edge)] hover:bg-[var(--glass-fill-hover)] active:bg-[var(--glass-fill-press)]',
  light:
    'bg-accent-primary text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active',
  danger:
    'bg-danger-well text-accent-danger hover:bg-danger-well-hover active:[background-image:linear-gradient(var(--wash-press),var(--wash-press))]',
};

/**
 * IconButton: an icon-only circle (docs/glass-spec.md §1.5, §9), 28 / 36 / 44,
 * and 46 for a stage control. Pass the icon as the child and its name as
 * `label`. Hover is one step lighter, press one step darker, 120ms ease-out;
 * nothing scales.
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
          'pc-focusable inline-flex shrink-0 select-none items-center justify-center rounded-[var(--r-capsule)]',
          'transition-[background-color,color] duration-[var(--glass-ms)] ease-[var(--glass-ease)]',
          'disabled:pointer-events-none disabled:opacity-40',
          SIZES[size],
          TONES[tone],
          active &&
            (tone === 'ghost' || tone === 'raised') &&
            'bg-[var(--glass-fill-on)] text-text-primary hover:bg-[var(--glass-fill-on)]',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
