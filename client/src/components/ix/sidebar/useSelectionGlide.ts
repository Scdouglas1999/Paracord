import { useLayoutEffect, useRef, type RefObject } from 'react';

import { IX_REDUCED_MS, IX_SPRING, canAnimate, commit, ixReduced } from '../motion';

/**
 * The selection's glide (docs/index-spec.md §5.2): one highlight element for the
 * whole list, moved to the selected row by a `translateY`, 205ms spring. Rows have
 * a fixed height, so nothing but a translate is ever needed (no height animation).
 *
 * The element is positioned in the list's own coordinate space (`offsetTop` of the
 * row against the positioned container), so it follows the rows when a category
 * closes and they FLIP up: both run 205ms on the same curve and arrive together.
 *
 * - First placement, and a pane that is sliding out: put in place, no motion.
 * - Selection appears from nothing: fades in at the row (CSS opacity transition).
 * - Reduced motion: put in place and crossfade 100ms.
 */

export const GLIDE_MS = 205;
export const SELECTED_ATTRIBUTE = 'data-ix-selected';

export function useSelectionGlide(
  containerRef: RefObject<HTMLElement | null>,
  suspended: boolean,
): RefObject<HTMLSpanElement | null> {
  const selection = useRef<HTMLSpanElement>(null);
  const lastY = useRef<number | null>(null);
  const running = useRef<Animation[]>([]);

  // After every render: rows move for reasons other than the selection (a group
  // closes, previews arrive, a row is added), and the selection must follow.
  useLayoutEffect(() => {
    const element = selection.current;
    const container = containerRef.current;
    if (!element || !container) return;
    const row = container.querySelector<HTMLElement>(`[${SELECTED_ATTRIBUTE}]`);
    if (!row) {
      element.dataset.on = 'false';
      lastY.current = null;
      return;
    }
    const y = row.offsetTop;
    const previous = lastY.current;
    lastY.current = y;
    element.dataset.on = 'true';
    if (previous === y) return;
    commit(running.current);
    running.current = [];
    element.style.transform = `translateY(${y}px)`;
    if (previous === null || suspended || !canAnimate(element)) return;
    if (ixReduced()) {
      const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IX_REDUCED_MS, easing: 'ease-out' });
      fade.id = 'ix-select:fade';
      running.current = [fade];
      return;
    }
    const glide = element.animate(
      [{ transform: `translateY(${previous}px)` }, { transform: `translateY(${y}px)` }],
      { duration: GLIDE_MS, easing: IX_SPRING },
    );
    glide.id = 'ix-select:glide';
    running.current = [glide];
  });

  useLayoutEffect(
    () => () => {
      for (const animation of running.current) animation.cancel();
      running.current = [];
    },
    [],
  );

  return selection;
}
