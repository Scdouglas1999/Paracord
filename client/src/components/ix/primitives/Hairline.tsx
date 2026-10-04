import type { CSSProperties } from 'react';

import { cn } from '../../../lib/utils';

export interface HairlineProps {
  orientation?: 'horizontal' | 'vertical';
  /** A vertical hairline's length in px. Default 24 (the dock's separator). */
  length?: number;
  /** Purely visual: hidden from assistive technology. Default false (a separator role). */
  decorative?: boolean;
  className?: string;
}

/** A 1px hairline in `--ix-line` (docs/index-spec.md §3.1): the dock's separator is a vertical one, 24px. */
export function Hairline({ orientation = 'horizontal', length, decorative = false, className }: HairlineProps) {
  const style = orientation === 'vertical' && length !== undefined ? ({ '--ix-hairline-length': `${length}px` } as CSSProperties) : undefined;
  return (
    <div
      role={decorative ? undefined : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      aria-hidden={decorative ? true : undefined}
      className={cn('ix-hairline', orientation === 'vertical' && 'ix-hairline--vertical', className)}
      style={style}
    />
  );
}
