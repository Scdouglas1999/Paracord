import * as React from 'react';

import { cn } from '../../../lib/utils';

export interface StageControlBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Phone controls are 50px on a 12px gap; desktop is 46px on 10px. */
  compact?: boolean;
}

/**
 * StageControlBar — the centred row of Stage controls
 * (docs/lantern-stage-spec.md §7.2, §8).
 *
 * Mic on is white light, leave is danger; the controls themselves are
 * `IconButton size="stage"`. This is only the row: it centres its children and
 * spaces them, and knows nothing about microphones.
 */
export const StageControlBar = React.forwardRef<HTMLDivElement, StageControlBarProps>(
  function StageControlBar({ compact = false, className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        role="group"
        aria-label="Call controls"
        className={cn(
          'flex shrink-0 flex-wrap items-center justify-center',
          compact ? 'gap-3' : 'gap-3 sm:gap-2.5',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
