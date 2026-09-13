import { Search } from 'lucide-react';

import { Kbd } from '../../ui';
import { formatModShortcut } from '../../../lib/keyboardShortcuts';
import { useUIStore } from '../../../stores/uiStore';

/**
 * The search well at the top of the Buildings column
 * (docs/lantern-stage-spec.md §7.1, §8 SearchWell).
 *
 * This IS the ⌘K entry — not a second search implementation: activating it opens
 * the Command Palette, which owns all fuzzy navigation and search.
 *
 * It is rendered as a `<button>` wearing the well recipe rather than WP0's
 * `SearchWell` input, because a real input inside the column would trap focus in
 * a reopen loop with the palette it summons (the palette takes focus, returns it
 * on close, and the input opens it again).
 */
export function SidebarSearch() {
  const openPalette = () => useUIStore.getState().setCommandPaletteOpen(true);

  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Search — open command palette"
      aria-keyshortcuts="Meta+K Control+K"
      className={
        'pc-well pc-focusable flex h-[var(--h-search-well)] w-full items-center gap-2.5 px-3 text-left ' +
        'text-text-faint transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] ' +
        'hover:text-text-secondary'
      }
    >
      <Search size={16} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-label">Search</span>
      <Kbd>{formatModShortcut('K')}</Kbd>
    </button>
  );
}
