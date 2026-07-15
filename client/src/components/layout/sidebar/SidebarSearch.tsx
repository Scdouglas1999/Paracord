import { Search } from 'lucide-react';
import { formatModShortcut } from '../../../lib/keyboardShortcuts';
import { useUIStore } from '../../../stores/uiStore';

/**
 * Sidebar search field (layout-spec §1, design-spec §7 Input recipe). This IS the
 * ⌘K entry — not a separate search implementation: focus/click opens the Command
 * Palette (`uiStore.setCommandPaletteOpen(true)`), which owns all fuzzy nav/search.
 *
 * Rendered as a button styled to the Input recipe (inset bg `--bg-tertiary`, 1px
 * `--border-subtle`, `--radius-sm`, focus `--focus-ring-input`) rather than a real
 * text input so it can never trap focus in a reopen loop with the palette it summons.
 * A trailing ⌘K hint advertises the canonical shortcut (kill-list clean — tokens only).
 */
export function SidebarSearch() {
  const openPalette = () => useUIStore.getState().setCommandPaletteOpen(true);

  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Search — open command palette"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-9 w-full items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 text-left text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)]"
    >
      <Search size={16} aria-hidden className="shrink-0" />
      <span className="flex-1 truncate text-label">Search or jump to…</span>
      <kbd className="shrink-0 rounded-xs border border-border-subtle bg-bg-mod-subtle px-1.5 py-0.5 text-meta font-semibold text-text-secondary">
        {formatModShortcut('K')}
      </kbd>
    </button>
  );
}
