import { useLayoutEffect, useRef, type RefObject } from 'react';
import { IX_SPRING, canAnimate, ixReduced } from '../ix/motion';

/**
 * The message box's shape (docs/index-spec.md §4.12, §5.12; WP IX-12).
 *
 * The box is drawn as three slices, a top cap, a stretchable middle and a
 * bottom cap, so its 24px corners never distort while it changes height. The
 * layout height changes once, at the start; the slices then play the change
 * back from the old height, transform only:
 *
 *   top cap + head   translateY(old top - new top) -> none
 *   middle           scaleY(old middle / new middle) -> none, from its bottom
 *   tools (closing)  translateY(0) -> translateY(old height - new height), inside
 *                    a clip at the box's foot, so the row is pushed out of the
 *                    bottom edge as the box closes over it, never under the text
 *
 * The bottom cap never moves: the box is anchored at its foot (it sits on the
 * conversation's bottom edge), so growing and shrinking happen at the top.
 * Growing (open, a new line, an attachment) runs 500ms on the spring; shrinking
 * (close, a line removed) 350ms (§5.12 "closing reverses in 350ms"). A change
 * mid-move starts from where the shape is on screen, not from where it was
 * going (§5 "canceled and committed if a newer event of the same kind starts").
 *
 * The change is caught by a ResizeObserver, whose callbacks run after layout
 * and before paint, so the first frame the new layout paints is already the
 * first frame of the move: nothing jumps. Reduced motion snaps.
 */

/** The corner radius of the box, and so the height of each cap. */
export const COMPOSER_RADIUS = 24;
/** Opening, or any growth. */
export const COMPOSER_GROW_MS = 500;
/** Closing, or any shrink. */
export const COMPOSER_SHRINK_MS = 350;

export interface ComposerShapeMove {
  /** Where the top edge starts, relative to its new place (px; positive = lower). */
  offset: number;
  /** The middle slice's starting scale. */
  midFrom: number;
  duration: number;
}

/**
 * The move from a box that LOOKS `from` px tall to one laid out `to` px tall.
 * Null when there is nothing to play.
 */
export function composerShapeMove(from: number, to: number, radius = COMPOSER_RADIUS): ComposerShapeMove | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const offset = to - from;
  if (Math.abs(offset) < 0.5) return null;
  const span = to - 2 * radius;
  if (span <= 0) return null;
  const midFrom = Math.max(0, from - 2 * radius) / span;
  return { offset, midFrom, duration: offset > 0 ? COMPOSER_GROW_MS : COMPOSER_SHRINK_MS };
}

/** The vertical translation an element is drawn at right now (0 when none). */
function drawnOffset(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === 'none') return 0;
  const match = /^matrix(3d)?\((.+)\)$/.exec(transform);
  if (!match) return 0;
  const values = match[2].split(',').map((value) => Number.parseFloat(value));
  const y = match[1] ? values[13] : values[5];
  return Number.isFinite(y) ? y : 0;
}

export interface ComposerShapeRefs {
  box: RefObject<HTMLElement | null>;
  /** The top caps (the fill's and the edge's), the first of which is read for where the shape is. */
  top: ReadonlyArray<RefObject<HTMLElement | null>>;
  /** The middles (the fill's and the edge's). */
  mid: ReadonlyArray<RefObject<HTMLElement | null>>;
  head: RefObject<HTMLElement | null>;
  tools: RefObject<HTMLElement | null>;
}

export interface ComposerShapeOptions {
  /** Read on every change: whether the tools row is showing (the box is open). */
  open: RefObject<boolean>;
  /** Read on every change: true while a send is closing the box up. That change snaps. */
  hold: RefObject<boolean>;
  /** False while the box is not on the page (a read-only channel): nothing to watch. */
  active: boolean;
}

/**
 * Play every height change of the box as the three-slice move. Returns nothing:
 * the animations are ids `ix-composer:shape:*`, cut short by the next change
 * and never filled forwards.
 */
export function useComposerShape(refs: ComposerShapeRefs, options: ComposerShapeOptions): void {
  const { box, top, mid, head, tools } = refs;
  const { open, hold, active } = options;
  const running = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!active || !element || typeof ResizeObserver === 'undefined') return;
    let laidOut = element.offsetHeight;
    let wasOpen = Boolean(open.current);
    // A ResizeObserver reports the box once as soon as it is observed: that is
    // the box as it mounted, not a change.
    let first = true;

    const stop = () => {
      for (const animation of running.current) animation.cancel();
      running.current = [];
    };

    const observer = new ResizeObserver(() => {
      const next = element.offsetHeight;
      const nowOpen = Boolean(open.current);
      const closing = wasOpen && !nowOpen;
      wasOpen = nowOpen;
      if (first) {
        first = false;
        laidOut = next;
        return;
      }
      if (next === laidOut) return;
      const cap = top[0]?.current ?? null;
      // Where the top edge is on screen now: mid-move it is not where the old
      // layout put it.
      const drawn = cap && running.current.length > 0 ? laidOut - drawnOffset(cap) : laidOut;
      laidOut = next;
      stop();
      if (hold.current || ixReduced()) return;
      const move = composerShapeMove(drawn, next);
      if (!move) return;
      const timing: KeyframeAnimationOptions = { duration: move.duration, easing: IX_SPRING, fill: 'none' };
      const play = (target: HTMLElement | null, keyframes: Keyframe[], part: string) => {
        if (!canAnimate(target)) return;
        const animation = target.animate(keyframes, timing);
        animation.id = `ix-composer:shape:${part}`;
        running.current.push(animation);
      };
      const lift = [{ transform: `translateY(${move.offset}px)` }, { transform: 'none' }];
      for (const ref of top) play(ref.current, lift, 'top');
      play(head.current, lift, 'head');
      for (const ref of mid) play(ref.current, [{ transform: `scaleY(${move.midFrom})` }, { transform: 'none' }], 'mid');
      // Closing: the tools row rides down with the input row and out of the
      // box's foot, where its clip hides it. (Opening, it rises in place: §5.12.)
      if (closing) play(tools.current, [{ transform: 'none' }, { transform: `translateY(${-move.offset}px)` }], 'tools');
      const mine = [...running.current];
      for (const animation of mine) {
        void animation.finished.then(
          () => {
            running.current = running.current.filter((entry) => entry !== animation);
          },
          () => {},
        );
      }
    });
    // The border box: opening adds padding (the tools row's 46px), which the
    // default content box never reports.
    observer.observe(element, { box: 'border-box' });
    return () => {
      observer.disconnect();
      stop();
    };
    // The refs are stable objects; the observer reads them on every change.
  }, [box, top, mid, head, tools, open, hold, active]);
}
