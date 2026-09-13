import * as React from 'react';

import { Lamp, Plate } from '../ui';
import { cn } from '../../lib/utils';
import type { BuildingLight } from '../../lib/attention/light';
import { LAMP_MARK, PLATE_MARK } from '../../lib/motion';
import { WindowMap } from './WindowMap';

export interface BuildingPlateProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  building: BuildingLight;
  /** 10×13 windows in the sidebar (default), 12×16 on Home (§3). */
  scale?: 'sidebar' | 'home';
  /** Override the caption — Home's plate says "24 in · 2 rooms lit". */
  caption?: string;
  /** Extra chrome inside the plate (the building's mark and name on Home). */
  children?: React.ReactNode;
}

/**
 * BuildingPlate — a building, seen from the street
 * (docs/lantern-stage-spec.md §7.1, §8).
 *
 * Plate + window map + caption. When a room inside is lit the plate gets the
 * lit ring and **one** lamp — the single permitted radial (§1.2), anchored to
 * the top-left. A dark building gets neither: no glow without a source (§6.1),
 * and it drops to the quiet tile highlight rather than carrying a deep plate
 * shadow it has not earned.
 */
export const BuildingPlate = React.forwardRef<HTMLElement, BuildingPlateProps>(
  function BuildingPlate({ building, scale = 'sidebar', caption, className, children, ...props }, ref) {
    const lit = building.roomsLit > 0 || building.readingCount > 0;
    return (
      <Plate
        ref={ref}
        bare
        lit={lit}
        // A plate settles when the street first renders, and its lamp fades in
        // behind its own first lit window (§5.1).
        {...{ [PLATE_MARK]: '' }}
        className={cn(
          'relative flex min-w-0 items-center gap-3 overflow-hidden rounded-[var(--radius-card)] px-3 py-2.5',
          !lit && 'shadow-[var(--shadow-tile)]',
          className,
        )}
        {...props}
      >
        {lit && <Lamp {...{ [LAMP_MARK]: '' }} />}
        {children}
        <WindowMap
          windows={building.windows}
          overflowCount={building.overflowCount}
          caption={caption ?? building.caption}
          scale={scale}
          className="relative flex-1"
        />
      </Plate>
    );
  },
);
