import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { settleIn, type SettleOptions } from './animate';
import { prefersReducedMotion, useReducedMotion } from './reducedMotion';
import { ms } from './tokens';

/**
 * Staying mounted for the exit (docs/lantern-stage-spec.md §5.1, §5.3).
 *
 * CSS can describe an element arriving and an element leaving, but it cannot
 * keep a React node in the tree for the 120ms a leave takes. That is the one
 * job of this hook: `open` drops, the element keeps rendering with
 * `exiting = true` for `--duration-fast`, then it unmounts. Enter and exit are
 * the shared `pc-enter` / `pc-exit` classes — this hook owns only the timing.
 *
 * It obeys the engine's three rules: the leave is interruptible (flipping back
 * to `open` mid-exit cancels it and the element re-enters), under reduced
 * motion it unmounts on the spot, and the first render never plays a leave.
 *
 * **Opening is synchronous.** `mounted` goes true during the render that sets
 * `open`, never one effect later: consumers measure themselves in a layout
 * effect keyed on `open` (a popover placing itself against its anchor, a menu
 * clamping itself to the viewport), and a node that arrives a commit after
 * that effect has already run is measured as nothing and never placed.
 * Only the *leave* is deferred, and a leave has nothing to measure.
 */
export interface Presence {
  /** Keep rendering the element while this is true. */
  mounted: boolean;
  /** The leave is in flight — apply the exit class. */
  exiting: boolean;
  /**
   * Spread onto the leaving element.
   *
   * A surface that has been dismissed is scenery for the beat it takes to
   * leave: out of the accessibility tree and out of the tab order. Without
   * this, a "closed" menu is still announced and still focusable for
   * `--duration-fast` after the click that closed it — which is the price of
   * animating an exit at all, and has to be paid here rather than at each of
   * the dozen call sites. (`.pc-exit` takes the pointer out of it in CSS.)
   */
  scenery: { 'aria-hidden'?: true; inert?: true };
}

const PRESENT = {} as const;
const LEAVING = { 'aria-hidden': true, inert: true } as const;

export function usePresence(open: boolean): Presence {
  const reduce = useReducedMotion();
  const [state, setState] = useState<{ mounted: boolean; exiting: boolean }>(() => ({
    mounted: open,
    exiting: false,
  }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React's "adjusting state during render" escape hatch: the element is in
  // the tree on the same commit that opened it, so a consumer's layout effect
  // has something to measure. React re-runs this render before touching the
  // DOM; the guard makes it run exactly once.
  if (open && (!state.mounted || state.exiting)) {
    setState({ mounted: true, exiting: false });
  }

  useEffect(() => {
    if (open) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      return;
    }
    if (prefersReducedMotion()) {
      setState((current) =>
        current.mounted || current.exiting ? { mounted: false, exiting: false } : current,
      );
      return;
    }
    // The leave runs for --duration-fast, then the element is gone.
    setState((current) => (current.mounted ? { mounted: true, exiting: true } : current));
    timer.current = setTimeout(() => {
      timer.current = null;
      setState({ mounted: false, exiting: false });
    }, ms('--duration-fast'));
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, reduce]);

  return state.exiting
    ? { mounted: state.mounted, exiting: true, scenery: LEAVING }
    : { mounted: state.mounted, exiting: false, scenery: PRESENT };
}

/* -------------------------------------------------------------------------- */
/* The street                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * "A plate entering the street rises 14px" — but never on the first paint of
 * the whole app (§5.1; WP9b owns the lights-on sequence). The flag flips after
 * the first painted frame: a mount before it is first paint, a mount after it
 * is into an already-rendered street.
 */
let streetPainted = false;

if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
  // Two frames deep: the first rAF fires *before* the first paint, so the flag
  // lands only once something real is on screen.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      streetPainted = true;
    });
  });
}

/** Has the street painted at least one frame? */
export function streetIsPainted(): boolean {
  return streetPainted;
}

/** Test seam: pretend the app is already up (or back to first paint). */
export function setStreetPaintedForTests(painted: boolean): void {
  streetPainted = painted;
}

/**
 * A plate settling onto the street (§5.1): 14px on the spring-settle curve,
 * once, on mount — and only when the street it is joining was already there.
 * Returns a ref; attach it to the plate's element.
 */
export function useSettleIn<T extends HTMLElement = HTMLElement>(
  options: SettleOptions = {},
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const distance = options.distance;
  const played = useRef(false);
  useLayoutEffect(() => {
    if (played.current) return;
    played.current = true;
    if (!streetIsPainted()) return;
    settleIn(ref.current, { ...options, distance });
    // options intentionally read once: this is a mount recipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}
