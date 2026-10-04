import { IxGlyph } from '../glyphs';
import { isMacOS } from '../../../lib/keyboardShortcuts';
import { useUIStore } from '../../../stores/uiStore';

/** "Ctrl K", or "⌘K" on macOS. */
export function searchShortcut(): string {
  return isMacOS() ? '⌘K' : 'Ctrl K';
}

export interface SearchFieldProps {
  /** "Fuel": the field says "Search Fuel". */
  name: string;
}

/**
 * The search field (docs/index-spec.md §4.2): a button styled as a field. Click
 * (or Ctrl K, which the app already binds) opens the quick switcher, scoped first
 * to this server. The switcher itself is `CommandPalette` (IX-9 restyles it).
 */
export function SearchField({ name }: SearchFieldProps) {
  return (
    <button
      type="button"
      className="ix-search"
      data-testid="ix-search-field"
      aria-haspopup="dialog"
      aria-keyshortcuts={isMacOS() ? 'Meta+K' : 'Control+K'}
      onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
    >
      <IxGlyph name="search" size={15} />
      <span className="ix-search__text">Search {name}</span>
      <kbd>{searchShortcut()}</kbd>
    </button>
  );
}
