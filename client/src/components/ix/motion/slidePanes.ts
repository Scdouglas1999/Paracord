import { IX_EASE, IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from './curves';

/**
 * Switch place: the sidebar panes (docs/index-spec.md §5.1).
 *
 *   old pane  translateX(-dir × 40%), opacity 1 → 0, 205ms spring, then removed
 *   new pane  from translateX(dir × 60%), opacity 0 → 1, 250ms spring
 *
 * `dir` is the sign of the dock index change (+1: the new place is to the right
 * of the old one in the dock). 0 (unknown order: a server that just appeared)
 * crossfades in place. Reduced motion: a 100ms crossfade in place.
 *
 * The outgoing pane holds its end state (`fill: 'forwards'`) until the caller
 * removes it from the DOM on settle; the incoming pane rests at its CSS state,
 * so nothing is left running (or filling) on an element that stays.
 */

export const PANE_OUT_MS = 205;
export const PANE_IN_MS = 250;
/** How far each pane travels, as a share of its width. */
export const PANE_OUT_SHIFT = 40;
export const PANE_IN_SHIFT = 60;

export type SlideDirection = -1 | 0 | 1;

export interface SlidePanesResult {
  outgoing: Animation | null;
  incoming: Animation | null;
}

export function slidePanes(
  outgoing: HTMLElement | null,
  incoming: HTMLElement | null,
  dir: SlideDirection,
  { reduced = ixReduced() }: { reduced?: boolean } = {},
): SlidePanesResult {
  const fade = reduced || dir === 0;
  const fadeMs = reduced ? IX_REDUCED_MS : 135;
  const out = canAnimate(outgoing)
    ? outgoing.animate(
        fade
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { transform: 'none', opacity: 1 },
              { transform: `translateX(${-dir * PANE_OUT_SHIFT}%)`, opacity: 0 },
            ],
        { duration: fade ? fadeMs : PANE_OUT_MS, easing: fade ? IX_EASE : IX_SPRING, fill: 'forwards' },
      )
    : null;
  const into = canAnimate(incoming)
    ? incoming.animate(
        fade
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { transform: `translateX(${dir * PANE_IN_SHIFT}%)`, opacity: 0 },
              { transform: 'none', opacity: 1 },
            ],
        { duration: fade ? fadeMs : PANE_IN_MS, easing: fade ? IX_EASE : IX_SPRING },
      )
    : null;
  if (out) out.id = 'ix-pane:out';
  if (into) into.id = 'ix-pane:in';
  return { outgoing: out, incoming: into };
}
