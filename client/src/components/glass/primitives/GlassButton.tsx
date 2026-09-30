import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * The Glass button (docs/glass-spec.md §1.4, §1.5, §9), by role:
 *
 *   primary  cream Join, dark ink. The ONE filled button on a screen.
 *   glass    a control you press over content; icon + label for product verbs
 *            that need learning (Listen, Clip). `pressed` lights it; with
 *            `tone="amber"` it lights amber ("Listening").
 *   text     a decision: Watch, Leave, Stop watching, Post to General, Mark read.
 *   icon     a circle, icon only, so it MUST carry an accessible name.
 *
 * Hover is one token step lighter, press one step darker, 120ms ease-out
 * (glass.css). Nothing scales. The focus ring is the §9 one.
 */
export type GlassButtonVariant = 'primary' | 'glass' | 'text' | 'icon';
export type GlassButtonSize = 'sm' | 'md';

interface GlassButtonBaseProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> {
  variant?: GlassButtonVariant;
  /** `sm` is 36px (in the call pill); `md` is 44px (stage controls, phone). */
  size?: GlassButtonSize;
  /** Toggle state for glass and icon buttons; sets `aria-pressed`. */
  pressed?: boolean;
  tone?: 'default' | 'amber';
}

export type GlassButtonProps = GlassButtonBaseProps &
  (
    | { variant: 'icon'; 'aria-label': string }
    | { variant?: Exclude<GlassButtonVariant, 'icon'> }
  );

export const GlassButton = React.forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton(
  { variant = 'glass', size = 'sm', pressed, tone = 'default', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      data-tone={tone === 'amber' ? 'amber' : undefined}
      className={cn(
        'glass-btn glass-focusable',
        `glass-btn--${variant}`,
        size === 'md' && 'glass-btn--md',
        className,
      )}
      {...rest}
    />
  );
});

/** Join: cream, dark text. */
export const JoinButton = React.forwardRef<HTMLButtonElement, Omit<GlassButtonProps, 'variant'>>(
  function JoinButton(props, ref) {
    return <GlassButton ref={ref} variant="primary" {...(props as GlassButtonProps)} />;
  },
);
