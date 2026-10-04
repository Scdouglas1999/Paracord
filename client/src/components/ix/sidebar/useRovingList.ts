import { useCallback, useState, type KeyboardEvent } from 'react';

/**
 * The sidebar's list is one Tab stop and its rows are reached with the arrow
 * keys (the roving tabindex): Up and Down move, Home and End jump, Space opens a
 * link the way it opens a button. Header, search field and "…" are ordinary stops
 * before it.
 *
 * Rows are found in the DOM (`[data-place-row]`), so a row that appears later (an
 * add-on that finished loading, a category that opened) is on the path at once,
 * and a row a collapsed category hides is not.
 */

export interface RowFocus {
  /** Roving tabindex: 0 for the one stop, -1 for the rest. */
  tabIndex: 0 | -1;
  onFocus: () => void;
}

/** One roving stop over a set of ids: the one last focused, else the preferred one, else the first. */
export function useRovingList(ids: readonly string[], preferred: string | null) {
  const [stop, setStop] = useState<string | null>(null);
  const effective = stop && ids.includes(stop) ? stop : preferred && ids.includes(preferred) ? preferred : (ids[0] ?? '');
  const focusOf = useCallback(
    (id: string): RowFocus => ({ tabIndex: effective === id ? 0 : -1, onFocus: () => setStop(id) }),
    [effective],
  );
  return { stop: effective, focusOf };
}

export const ROW_SELECTOR = '[data-place-row]';

/** Where an arrow key goes from `at` among `count` rows (wrapping), or null for a key that is not ours. */
export function nextRowIndex(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowUp':
      return at <= 0 ? last : at - 1;
    case 'ArrowDown':
      return at >= last ? 0 : at + 1;
    default:
      return null;
  }
}

/** The keydown handler for the container that holds the rows. */
export function rovingKeyDown(root: HTMLElement | null, event: KeyboardEvent<HTMLElement>): void {
  if (!root || event.altKey || event.ctrlKey || event.metaKey) return;
  const active = document.activeElement as HTMLElement | null;
  // Menus and popovers portal out of the list but bubble through React: only keys
  // pressed on a row of this list are the list's.
  if (!active || !root.contains(active) || !active.matches(ROW_SELECTOR)) return;
  if (event.key === ' ' && active.tagName === 'A') {
    event.preventDefault();
    active.click();
    return;
  }
  if (event.shiftKey) return;
  const rows = Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const next = nextRowIndex(event.key, rows.indexOf(active), rows.length);
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}
