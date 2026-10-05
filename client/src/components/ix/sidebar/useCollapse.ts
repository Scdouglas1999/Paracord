import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { IX_SPRING, canAnimate, flipMoved, measureRects, onSettle } from '../motion';

/**
 * Closing and opening a category (docs/index-spec.md §4.5, §5.20).
 *
 * Closing: the rows fade (70ms) while the rest of the sidebar FLIPs up (205ms
 * spring); the chevron's quarter turn is the label's own transition (90ms).
 * Opening is the same in reverse: the rows fade in as what is below them FLIPs
 * down. A closed category still shows the rows that matter (unread, mention, the
 * open one: `data-keep`).
 *
 * The FLIP is every element the list marked `data-ix-flip`, measured before the
 * change and played after it (one layout effect, so nothing paints in between).
 * A row that is going away is cloned into the ghost layer and faded there, because
 * React removes the real one at once.
 */

export const COLLAPSE_FADE_MS = 70;
export const COLLAPSE_MOVE_MS = 205;
export const FLIP_ATTRIBUTE = 'data-ix-flip';
export const GROUP_ATTRIBUTE = 'data-ix-group';

const storageKey = (guildId: string) => `paracord:ix-collapsed:${guildId}`;

function readCollapsed(guildId: string): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(storageKey(guildId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(guildId: string, collapsed: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(storageKey(guildId), JSON.stringify([...collapsed]));
  } catch {
    // A convenience only: closed groups reopen next session when storage is blocked.
  }
}

interface Pending {
  before: Map<Element, DOMRect>;
  group: string;
  closing: boolean;
  ghosts: HTMLElement[];
}

/** A copy of a row to fade out in its place, with nothing on it a test or a screen reader could mistake for the row. */
function ghostOf(row: HTMLElement, container: HTMLElement, layer: HTMLElement): HTMLElement {
  const rect = row.getBoundingClientRect();
  const origin = container.getBoundingClientRect();
  const ghost = row.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>('*'))]) {
    node.removeAttribute('data-testid');
    node.removeAttribute('data-place-row');
    node.removeAttribute(FLIP_ATTRIBUTE);
    node.removeAttribute('id');
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  ghost.tabIndex = -1;
  ghost.style.cssText = `position:absolute;left:0;top:${rect.top - origin.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;`;
  layer.appendChild(ghost);
  return ghost;
}

export function useCollapse(
  guildId: string,
  containerRef: RefObject<HTMLElement | null>,
  ghostLayerRef: RefObject<HTMLElement | null>,
  suspended: boolean,
) {
  const [state, setState] = useState(() => ({ guildId, collapsed: readCollapsed(guildId) }));
  // A pane belongs to one place; if it is handed another, read that one's.
  const collapsed = state.guildId === guildId ? state.collapsed : readCollapsed(guildId);
  if (state.guildId !== guildId) setState({ guildId, collapsed });
  const pending = useRef<Pending | null>(null);

  const toggle = useCallback(
    (group: string) => {
      const container = containerRef.current;
      const closing = !collapsed.has(group);
      if (container && !suspended) {
        const before = measureRects(container.querySelectorAll(`[${FLIP_ATTRIBUTE}]`));
        const layer = ghostLayerRef.current;
        const ghosts =
          closing && layer
            ? Array.from(container.querySelectorAll<HTMLElement>(`[${GROUP_ATTRIBUTE}="${CSS.escape(group)}"]:not([data-keep])`)).map((row) =>
                ghostOf(row, container, layer),
              )
            : [];
        pending.current = { before, group, closing, ghosts };
      }
      const next = new Set(collapsed);
      if (closing) next.add(group);
      else next.delete(group);
      writeCollapsed(guildId, next);
      setState({ guildId, collapsed: next });
    },
    [collapsed, containerRef, ghostLayerRef, guildId, suspended],
  );

  useLayoutEffect(() => {
    const move = pending.current;
    pending.current = null;
    const container = containerRef.current;
    if (!move || !container) return;
    for (const ghost of move.ghosts) {
      if (typeof ghost.animate !== 'function') {
        ghost.remove();
        continue;
      }
      const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: COLLAPSE_FADE_MS, easing: 'ease-out' });
      fade.id = 'ix-collapse:fade';
      onSettle([fade], () => ghost.remove());
    }
    if (!move.closing) {
      // Rows that were not there a moment ago.
      for (const row of container.querySelectorAll<HTMLElement>(`[${GROUP_ATTRIBUTE}="${CSS.escape(move.group)}"]:not([data-keep])`)) {
        if (!canAnimate(row)) continue;
        const fade = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: COLLAPSE_FADE_MS, easing: 'ease-out' });
        fade.id = 'ix-collapse:fade';
      }
    }
    flipMoved(move.before, { duration: COLLAPSE_MOVE_MS, easing: IX_SPRING, id: 'ix-collapse:move' });
  }, [collapsed, containerRef]);

  return { collapsed, toggle };
}
