import { Plus } from 'lucide-react';

import { cn } from '../../lib/utils';
import { ADD_BUILDING_LABEL } from './homeCaptions';

export interface HomeAddBuildingProps {
  onClick: () => void;
}

/**
 * The add-a-building row (docs/lantern-stage-spec.md §7.5).
 *
 * An outline tile, never a card: it is the one thing in the column that is not
 * a building, and it stays visible whether you have twelve buildings or none —
 * an empty street should still have a door in it (lantern-stage-spec §6, empty states
 * are left-aligned with an action).
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
        'pc-focusable flex min-h-11 w-full items-center gap-2.5 rounded-[var(--radius-card)] px-4 py-3',
        'text-left text-[13.5px] text-text-muted',
        'shadow-[inset_0_0_0_1px_var(--border-subtle)]',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'hover:bg-bg-mod-subtle hover:text-text-secondary',
      )}
    >
      <Plus size={16} aria-hidden className="shrink-0" />
      <span className="min-w-0">{ADD_BUILDING_LABEL}</span>
    </button>
  );
}
