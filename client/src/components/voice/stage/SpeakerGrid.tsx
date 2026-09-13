import * as React from 'react';

import { cn } from '../../../lib/utils';

export type SpeakerArrangement = 'strip' | 'grid';

export interface SpeakerGridProps extends React.HTMLAttributes<HTMLUListElement> {
  /**
   * `strip` is the row under the dominant tile: equal columns, one row.
   * `grid` is the speakers-only Stage: the VideoGrid rules — one tile fills,
   * two sit side by side, three or four make a 2×2, more go three across.
   */
  arrangement?: SpeakerArrangement;
  /** Phone: two columns whatever the count. */
  compact?: boolean;
  /** How many tiles are inside, so the grid can choose its columns. */
  count: number;
}

/** The column count for the speakers-only Stage (the VideoGrid rules). */
export function speakerColumns(count: number, compact: boolean): number {
  if (compact) return count <= 1 ? 1 : 2;
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

/**
 * SpeakerGrid — the speaker tiles on the Stage
 * (docs/lantern-stage-spec.md §7.2).
 *
 * Equal columns, never a ragged last row: the strip beneath a share divides the
 * width between everybody, and with nobody sharing the same tiles spread into
 * the speakers-only grid.
 */
export const SpeakerGrid = React.forwardRef<HTMLUListElement, SpeakerGridProps>(
  function SpeakerGrid(
    { arrangement = 'strip', compact = false, count, className, style, children, ...props },
    ref,
  ) {
    const columns =
      arrangement === 'strip'
        ? compact
          ? Math.min(2, Math.max(1, count))
          : Math.max(1, count)
        : speakerColumns(count, compact);

    return (
      <ul
        ref={ref}
        className={cn(
          'grid min-h-0 list-none',
          compact ? 'gap-2.5' : 'gap-3',
          arrangement === 'grid' && 'auto-rows-fr',
          // The phone strip sits under a fixed-height share, so its rows carry
          // their own height instead of dividing a flexible one (§7.2 phone).
          arrangement === 'strip' && compact && 'auto-rows-[96px]',
          className,
        )}
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, ...style }}
        {...props}
      >
        {children}
      </ul>
    );
  },
);
