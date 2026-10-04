import type { ComponentPropsWithRef } from 'react';

import { cn } from '../../../lib/utils';

export interface ControlProps extends Omit<ComponentPropsWithRef<'button'>, 'aria-label' | 'aria-pressed'> {
  /** The accessible name: an icon-only control has no other. It matches the tooltip. */
  label: string;
  /** `danger`: Leave. The one danger color on its quiet fill. */
  tone?: 'default' | 'danger';
  /** A toggle's state (mic live, listening): sets `aria-pressed` and the amber glyph. Omit for a plain button. */
  pressed?: boolean;
}

/**
 * An icon control (docs/index-spec.md §3.1): a 36x36 tile, radius 11, a quiet
 * fill that lifts on hover, the glyph in the secondary ink. Put an `IxGlyph`
 * (16px) in it. 40px on phone via `--ix-ctl-size`.
 */
export function Control({ label, tone = 'default', pressed, type = 'button', className, ...rest }: ControlProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      className={cn('ix-ctl', tone === 'danger' && 'ix-ctl--danger', className)}
      {...rest}
    />
  );
}
