import * as React from 'react';

import { cn } from '../../lib/utils';
import {
  WINDOWS_PER_ROW,
  type BuildingWindow,
} from '../../lib/attention/light';
import { LIT_MARK, WINDOW_MARK } from '../../lib/motion';

export interface WindowMapProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  windows: readonly BuildingWindow[];
  /** Rooms that did not fit — folded into the caption, never into a third row. */
  overflowCount?: number;
  /** "4 in voice · 3 here". Rendered at the end of the map. */
  caption?: string;
  /** 10×13 in the sidebar (default), 12×16 on Home (§3). */
  scale?: 'sidebar' | 'home';
  /** Columns per row. Capped at eight — the map is a building, not a chart. */
  columns?: number;
}

const CELL = {
  sidebar: { width: 10, height: 13, gap: 5, large: false },
  home: { width: 12, height: 16, gap: 6, large: true },
} as const;

/**
 * WindowMap — one window per room (docs/lantern-stage-spec.md §3, §8).
 *
 * White = somebody is in the voice channel, amber = somebody is in the text
 * channel, dark = empty. Rooms are already ordered by `buildingLight` (voice first, then text
 * by activity); **at most two rows of eight**, and everything past the
 * sixteenth window collapses into the caption. A window map that scrolls is a
 * chart, not a building.
 *
 * The whole map carries one `sr-only` sentence and each cell carries its own
 * title, so the light is never the only cue (§9).
 */
export const WindowMap = React.forwardRef<HTMLDivElement, WindowMapProps>(function WindowMap(
  { windows, overflowCount = 0, caption, scale = 'sidebar', columns = WINDOWS_PER_ROW, className, ...props },
  ref,
) {
  const cell = CELL[scale];
  const perRow = Math.max(1, Math.min(columns, WINDOWS_PER_ROW));
  const lit = windows.filter((window) => window.state !== 'dark');

  return (
    <div ref={ref} className={cn('flex min-w-0 items-center gap-3', className)} {...props}>
      <div
        className="relative grid shrink-0"
        style={{
          gridTemplateColumns: `repeat(${perRow}, ${cell.width}px)`,
          gap: cell.gap,
        }}
        aria-hidden
      >
        {windows.map((window) => (
          <span
            key={window.key}
            title={window.label}
            // The engine's marks (§5.1): which room this window is, and whether
            // it is lit. "Lights on" and an arrival both bloom exactly these.
            {...{ [WINDOW_MARK]: window.channelId }}
            {...(window.state !== 'dark' ? { [LIT_MARK]: '' } : null)}
            className={cn(
              'pc-window',
              cell.large && 'is-large',
              window.state === 'on' && 'is-talking',
              window.state === 'warm' && 'is-reading',
            )}
            style={{ width: cell.width, height: cell.height }}
          />
        ))}
      </div>
      {/* The caption may shrink; the map may not. A window map is a fixed grid
          — half a window is not a window — so when the row runs out the words
          are the half that can give way. Without `min-w-0` the caption keeps
          its full width, overflows, and the plate's `overflow-hidden` cuts it
          mid-word with no ellipsis to say that it did. */}
      {caption && (
        <span className="relative ml-auto min-w-0 truncate text-meta text-text-faint">
          {caption}
        </span>
      )}
      <span className="sr-only">
        {windows.length === 0
          ? // With no windows the caption is the only honest thing to say —
            // "No rooms yet" is a claim, and a building whose rooms have not
            // been fetched has not earned it.
            (caption ?? 'No channels yet')
          : `${lit.length} of ${windows.length + overflowCount} channels active${
              overflowCount > 0 ? `, ${overflowCount} more not shown` : ''
            }${caption ? `. ${caption}` : ''}`}
      </span>
    </div>
  );
});
