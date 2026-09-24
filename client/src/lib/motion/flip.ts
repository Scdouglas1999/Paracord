import { prefersReducedMotion } from './reducedMotion';
import { springEasing, springTokens } from './spring';
import { ms } from './tokens';

/**
 * FLIP for the things an arrival pushed out of the way
 * (docs/lantern-stage-spec.md §5.1: "lists that change order animate layout
 * (FLIP) on the same curve").
 *
 * `sharedElement.ts` FLIPs one *named* element across a route change. This is
 * the smaller, unnamed case: a face is inserted into a here-now strip and the
 * faces after it — and the sentence beside them — are 18px further right than
 * they were. §5.1 says nothing else on screen moves, and a row of avatars
 * jumping sideways is very much something moving.
 *
 * The capture has to happen **before** React renders the arrival, which is why
 * the arrival director subscribes to the store rather than to a hook: a Zustand
 * subscriber runs synchronously inside `setState`, while the DOM is still the
 * old one. `play()` is then called after the render and animates the delta on
 * `transform` alone, so no layout property is ever in a keyframe (§5.3).
 */

export interface FlipCapture {
  /** Measure again and play every element back from where it was. */
  play(options?: { duration?: number }): Animation[];
  /** How many elements were measured — nothing to play is not a failure. */
  readonly size: number;
}

const EMPTY: FlipCapture = { play: () => [], size: 0 };

/** Below this the move is a rounding error and playing it is noise. */
const MIN_DELTA_PX = 0.5;

/**
 * Measure `elements` where they are now. Returns a capture whose `play()`
 * measures them again and animates each from its old box to its new one.
 */
export function captureFlip(elements: Iterable<Element | null | undefined>): FlipCapture {
  if (prefersReducedMotion()) return EMPTY;
  const first = new Map<Element, DOMRect>();
  for (const el of elements) {
    if (!el || typeof (el as HTMLElement).animate !== 'function') continue;
    first.set(el, el.getBoundingClientRect());
  }
  if (first.size === 0) return EMPTY;

  return {
    size: first.size,
    play({ duration = ms('--duration-slow') } = {}) {
      if (prefersReducedMotion()) return [];
      const easing = springEasing(springTokens(), { durationMs: duration });
      const animations: Animation[] = [];
      for (const [el, from] of first) {
        // An element React removed has no box any more; there is nothing to
        // move it from and the ghost (`ghostOut`) is what carries its exit.
        if (!el.isConnected) continue;
        const to = el.getBoundingClientRect();
        if (to.width === 0 && to.height === 0) continue;
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (Math.abs(dx) < MIN_DELTA_PX && Math.abs(dy) < MIN_DELTA_PX) continue;
        const animation = (el as HTMLElement).animate(
          [
            { transform: `translate3d(${dx}px, ${dy}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          { duration, easing, fill: 'none' },
        );
        animation.id = 'data-motion-recipe:flip';
        animations.push(animation);
      }
      return animations;
    },
  };
}
