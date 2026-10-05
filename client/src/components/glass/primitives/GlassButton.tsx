import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * The button the sheets' panels, the forum and a stage channel's panel still
 * use (docs/glass-spec.md §1.4, §9), by role:
 *
 *   primary  cream, dark ink. The ONE filled button on a screen.
 *   glass    a control you press; `pressed` lights it; with `tone="amber"` it
 *            lights amber.
 *   text     a decision: Leave, Post to General, Mark read.
 *
 * Hover is one token step lighter, press one step darker, 55ms ease-out
 * (glass.css). Nothing scales. The focus ring is the §9 one. The Index
 * buttons are `components/ix/primitives`.
 */
export type GlassButtonVariant = 'primary' | 'glass' | 'text';

export interface GlassButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> {
  variant?: GlassButtonVariant;
  /** Toggle state for glass buttons; sets `aria-pressed`. */
  pressed?: boolean;
  tone?: 'default' | 'amber';
}

export const GlassButton = React.forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton(
  { variant = 'glass', pressed, tone = 'default', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      data-tone={tone === 'amber' ? 'amber' : undefined}
      className={cn('glass-btn glass-focusable', `glass-btn--${variant}`, className)}
      {...rest}
    />
  );
});
