import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { contentIn, settleIn, type SettleOptions } from './animate';
import { useReducedMotion } from './reducedMotion';
import { ms } from './tokens';

/**
 * Staying mounted for the exit (docs/lantern-stage-spec.md §5.1, §5.3).
 *
 * CSS can describe an element arriving and an element leaving, but it cannot
 * keep a React node in the tree for the beat a leave takes. That is the one
 * job of this hook: `open` drops, the element keeps rendering with
 * `exiting = true` for `--duration-exit-slow` (170ms, the longest leave in the
 * choreography — a small surface's 130ms leave simply finishes first and holds
 * its end state), then it unmounts. Enter and exit are
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
   * `--duration-exit-slow` after the click that closed it — which is the price of
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

  // React's "adjusting state during render" escape hatch, for BOTH edges.
  //
  // Opening: the element is in the tree on the same commit that opened it, so
  // a consumer's layout effect has something to measure. Closing: the exit
  // class is on the element on the same commit that closed it, so the leave
  // starts on that frame rather than one render later. Deciding either in an
  // effect costs a frame, and a 120ms leave has seven of them. React re-runs
  // this render before touching the DOM, and each guard clears itself, so each
  // branch runs exactly once.
  if (open) {
    if (!state.mounted || state.exiting) setState({ mounted: true, exiting: false });
  } else if (reduce) {
    // Reduced motion has no leave at all: it is gone on the spot.
    if (state.mounted || state.exiting) setState({ mounted: false, exiting: false });
  } else if (state.mounted && !state.exiting) {
    setState({ mounted: true, exiting: true });
  }

  // The only thing left for an effect is the clock: the element is dropped
  // --duration-exit-slow after the leave began, and re-opening cancels it.
  useEffect(() => {
    if (!state.exiting) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setState({ mounted: false, exiting: false });
    }, ms('--duration-exit-slow'));
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [state.exiting]);

  return state.exiting
    ? { mounted: state.mounted, exiting: true, scenery: LEAVING }
    : { mounted: state.mounted, exiting: false, scenery: PRESENT };
}

/* -------------------------------------------------------------------------- */
/* The street                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * "A plate entering the street rises 8px" — but never on the first paint of
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
 * The plates that have stood through a painted frame.
 *
 * The app's first paint is not the only street that arrives all at once: a
 * route change lands a whole surface of plates in one commit, and so does the
 * moment the guild's data finishes loading under a screen that is already up.
 * A street rising at once is §5.1's **lights on** — WP9b's sequence, which
 * fires for presence and not for a click, and which §5.3 does not want played
 * twice. What WP9c owns is the other half of that sentence: a plate joining a
 * street that is ALREADY THERE.
 *
 * So the question a mounting plate asks is about its neighbors, not the
 * clock: does anything beside me in this container predate this commit? The
 * mark lands two frames after mount, so plates that arrive together never see
 * each other and none of them settles; one that arrives later sees them all
 * and rises onto them.
 */
const standing = new WeakSet<Element>();

function standAfterPaint(el: Element | null): void {
  if (!el) return;
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    standing.add(el);
    return;
  }
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => standing.add(el));
  });
}

/** Is this plate joining a street that was already standing? */
function joiningStandingStreet(el: Element | null): boolean {
  const parent = el?.parentElement;
  if (!parent) return false;
  for (const sibling of parent.children) {
    if (sibling !== el && standing.has(sibling)) return true;
  }
  return false;
}

/**
 * A plate settling onto the street (§5.1): 8px on `--ease-out`,
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
    const el = ref.current;
    // Whatever happens, this plate is part of the street from the next painted
    // frame on — including when it did not settle, because the plate that
    // joins it later is rising onto it.
    standAfterPaint(el);
    if (!streetIsPainted()) return;
    if (!joiningStandingStreet(el)) return;
    settleIn(el, { ...options, distance });
    // options intentionally read once: this is a mount recipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/* -------------------------------------------------------------------------- */
/* Small surfaces grow out of their anchor                                     */
/* -------------------------------------------------------------------------- */

export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';
export type AnchorAlign = 'start' | 'center' | 'end';

/**
 * The `transform-origin` a menu, popover or tooltip scales from (`.pc-pop-in`
 * reads it as `--pc-origin`): the point on the surface nearest the thing that
 * opened it. A surface below its anchor grows down from its top edge; one
 * aligned to the anchor's start grows from that corner.
 */
export function anchorOrigin(side: AnchorSide, align: AnchorAlign = 'center'): string {
  const along = align === 'start' ? '0%' : align === 'end' ? '100%' : '50%';
  switch (side) {
    case 'bottom':
      return `${along} 0%`;
    case 'top':
      return `${along} 100%`;
    case 'right':
      return `0% ${along}`;
    case 'left':
      return `100% ${along}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Content swapping inside a surface that stays                                */
/* -------------------------------------------------------------------------- */

/**
 * The surface stays; what is in it changes — the channel you switched to, a
 * settings section, the context panel moving from members to search. Attach the
 * returned ref to the element that holds the content and pass the thing that
 * identifies it: when `key` changes after the first commit, the new content
 * crossfades in with a 4px rise (`contentIn`). The first commit never plays.
 *
 * It stands down in two cases, both about something else owning the frame: a
 * shared-element journey is in flight (`data-motion-transition`), which is
 * already the transition; and a native video underlay is live
 * (`data-native-underlay`, Linux), where fading the content would let the
 * video beneath the webview show through it for the length of the fade.
 */
export function useContentSwap<T extends HTMLElement = HTMLElement>(key: unknown): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const last = useRef<unknown>(key);
  useLayoutEffect(() => {
    if (Object.is(last.current, key)) return;
    const previous = last.current;
    last.current = key;
    // Opening from nothing or closing to nothing is the surface's own enter or
    // leave, not a swap of what is in it.
    if (previous == null || key == null) return;
    const el = ref.current;
    if (!el || typeof document === 'undefined') return;
    const root = document.documentElement;
    if (root.hasAttribute('data-motion-transition') || root.hasAttribute('data-native-underlay')) return;
    contentIn(el);
  }, [key]);
  return ref;
}

/**
 * `usePresence` for a surface whose content is keyed on a value that is gone
 * the moment it closes — `{picker && <Picker at={picker.position} />}`. It
 * keeps the last value it saw for the length of the leave, so the caller can
 * keep rendering the surface where it was while it plays its exit:
 *
 *   const picker = useLingering(pickerFor);
 *   {picker.value && <EmojiPicker position={picker.value.position} leaving={picker.leaving} />}
 */
export function useLingering<T>(value: T | null | undefined | false): { value: T | null; leaving: boolean } {
  const open = value !== null && value !== undefined && value !== false;
  const { mounted, exiting } = usePresence(open);
  const [kept, setKept] = useState<T | null>(open ? (value as T) : null);
  // Adjusted during render, like `usePresence`: the surface must carry the new
  // value on the very commit that opened it.
  if (open && !Object.is(kept, value)) setKept(value as T);
  return { value: mounted ? (open ? (value as T) : kept) : null, leaving: exiting };
}
