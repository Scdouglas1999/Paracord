import { IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from './curves';

/**
 * FLIP from a rect (docs/index-spec.md §5.4–5.9): "this element was THERE a
 * moment ago". Measure the old rect, let the layout change, then play the
 * element from the old rect to where it now is, as a transform only.
 *
 *   const from = measureRect(card);            // before the change
 *   commitTheChange();                          // React commits, in a layout effect:
 *   flipFromRect(surface, from, { duration: 600, opacityFrom: 0.3 });
 *
 * `scale`:
 *   'xy'       translate + non-uniform scale, origin 0 0 (the call surface out of
 *              the card, §5.8; a draft event card out of an action card, §5.6)
 *   'uniform'  translate + one scale from the widths (your row out of the
 *              toolbar avatar, §5.7)
 *   'none'     translate only (content pushed by an arrival, the pinned card
 *              between its two positions, §5.4, §5.5)
 *
 * Reduced motion (§5): a move becomes a 100ms opacity fade in place
 * (`reduced: 'fade'`, the default: for something appearing or travelling), or
 * nothing at all (`reduced: 'none'`: for content that was merely displaced,
 * which would otherwise flash).
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FlipFromRectOptions {
  duration: number;
  easing?: string;
  scale?: 'xy' | 'uniform' | 'none';
  /** Opacity at the start of the move (ends at 1, the element's resting opacity). */
  opacityFrom?: number;
  /** Default '0 0' (the math assumes it for scaled moves). */
  origin?: string;
  reduced?: 'fade' | 'none';
  /** Forces the reduced path (tests); default: the app's switch. */
  reducedMotion?: boolean;
  /** Delay before the move starts, ms. */
  delay?: number;
  id?: string;
}

/** The element's rect right now, or null when it is not in the document. */
export function measureRect(element: Element | null | undefined): DOMRect | null {
  if (!element || !element.isConnected) return null;
  return element.getBoundingClientRect();
}

/**
 * The keyframe transform that puts an element whose rect is `to` at `from`.
 * Exported for tests and for callers that build their own keyframes (a counter-
 * layer that only fades while its parent scales, §5.8).
 */
export function invertTransform(from: RectLike, to: RectLike, scale: 'xy' | 'uniform' | 'none' = 'xy'): string | null {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (scale === 'none') {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
    return `translate(${round(dx)}px, ${round(dy)}px)`;
  }
  if (!(to.width > 0) || !(to.height > 0)) return null;
  const sx = from.width / to.width;
  const sy = scale === 'uniform' ? sx : from.height / to.height;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return null;
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(sx, 4)}, ${round(sy, 4)})`;
}

function round(value: number, places = 2): number {
  const k = 10 ** places;
  return Math.round(value * k) / k;
}

/** Play `element` from `from` to its current rect. Returns null when there is nothing to play. */
export function flipFromRect(
  element: HTMLElement | null,
  from: RectLike | null,
  options: FlipFromRectOptions,
): Animation | null {
  if (!from || !canAnimate(element) || !element.isConnected) return null;
  const { duration, easing = IX_SPRING, scale = 'xy', opacityFrom, origin = '0 0', delay = 0, id = 'ix-flip' } = options;
  const reducedMotion = options.reducedMotion ?? ixReduced();
  if (reducedMotion) {
    if ((options.reduced ?? 'fade') === 'none') return null;
    const fade = element.animate([{ opacity: opacityFrom ?? 0 }, { opacity: 1 }], {
      duration: IX_REDUCED_MS,
      easing: 'ease-out',
    });
    fade.id = id;
    return fade;
  }
  const transform = invertTransform(from, element.getBoundingClientRect(), scale);
  if (!transform && opacityFrom === undefined) return null;
  const first: Keyframe = { transform: transform ?? 'none', transformOrigin: origin };
  const last: Keyframe = { transform: 'none', transformOrigin: origin };
  if (opacityFrom !== undefined) {
    first.opacity = opacityFrom;
    last.opacity = 1;
  }
  const animation = element.animate([first, last], { duration, easing, delay, fill: delay > 0 ? 'backwards' : 'none' });
  animation.id = id;
  return animation;
}

/** Rects of several elements, keyed by element (before a change). */
export function measureRects(elements: Iterable<Element>): Map<Element, DOMRect> {
  const rects = new Map<Element, DOMRect>();
  for (const element of elements) {
    const rect = measureRect(element);
    if (rect) rects.set(element, rect);
  }
  return rects;
}

/**
 * Translate every element that is still in the document from its old rect to
 * its new one (content pushed down by a card entering, rows closing up after a
 * leave, the sidebar under a collapsing category). Translate only; reduced
 * motion snaps (`reduced: 'none'`).
 */
export function flipMoved(
  before: Map<Element, DOMRect>,
  options: Omit<FlipFromRectOptions, 'scale' | 'reduced'>,
): Animation[] {
  const played: Animation[] = [];
  for (const [element, rect] of before) {
    const animation = flipFromRect(element as HTMLElement, rect, { ...options, scale: 'none', reduced: 'none' });
    if (animation) played.push(animation);
  }
  return played;
}
