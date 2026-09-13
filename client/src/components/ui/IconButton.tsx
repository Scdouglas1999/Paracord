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
  /** 28 / 32 / 44 / 46 (the Stage control). Phone surfaces use `lg` or `stage`. */
  size?: IconButtonSize;
  /**
   * `light` is a white-light fill and means somebody is there / your mic is
   * live — state, never emphasis (§0, §6.3).
   */
  tone?: IconButtonTone;
  /** Pressed/selected state; also sets `aria-pressed`. */
  active?: boolean;
}

const SIZES: Record<IconButtonSize, string> = {
  sm: 'h-[var(--h-control-sm)] w-[var(--h-control-sm)] rounded-[var(--radius-control)]',
  md: 'h-[var(--h-control)] w-[var(--h-control)] rounded-[var(--radius-control)]',
  lg: 'h-[var(--h-control-phone)] w-[var(--h-control-phone)] rounded-[var(--radius-control)]',
  stage:
    'h-[var(--h-stage-control)] w-[var(--h-stage-control)] rounded-[var(--radius-stage-control)]',
};

const TONES: Record<IconButtonTone, string> = {
  ghost: 'bg-transparent text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
  raised: 'bg-bg-raised text-text-primary shadow-[var(--shadow-lifted)] hover:bg-bg-mod-strong',
  light: 'bg-light-white text-text-on-light shadow-[var(--glow-control-on)]',
  danger: 'bg-danger-well text-accent-danger hover:brightness-125',
};

/**
 * IconButton — a square, icon-only control (spec §3 heights, §9 hit targets and
 * focus ring). Pass the icon as the child; pass its name as `label`.
 *
 * The Stage control bar (WP3) composes this at `size="stage"`: mic-on is
 * `tone="light"`, leave is `tone="danger"`.
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
          'transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          'disabled:pointer-events-none disabled:opacity-60',
          SIZES[size],
          TONES[tone],
          active && tone === 'ghost' && 'bg-bg-mod-strong text-text-primary',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
