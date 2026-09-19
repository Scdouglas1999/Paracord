import { Plus } from 'lucide-react';

import { cn } from '../../lib/utils';
import { ADD_BUILDING_LABEL } from './homeCaptions';

export interface HomeAddBuildingProps {
  onClick: () => void;
}

/**
 * The add-a-building row (docs/lantern-stage-spec.md §7.5).
 *
 * A quiet text action that stays visible whether the person has twelve
 * servers or none. Empty states retain a clear way to join or create one.
 */
export function HomeAddBuilding({ onClick }: HomeAddBuildingProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The visible sentence IS the name; stating it also satisfies the static
      // audit, which cannot tell this leading glyph from an icon-only control.
      aria-label={ADD_BUILDING_LABEL}
      className={cn(
        'pc-focusable flex min-h-11 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-2',
        'text-left text-[13px] text-text-muted',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'hover:bg-bg-mod-subtle hover:text-text-secondary',
      )}
    >
      <Plus size={16} aria-hidden className="shrink-0" />
      <span className="min-w-0">{ADD_BUILDING_LABEL}</span>
    </button>
  );
}
