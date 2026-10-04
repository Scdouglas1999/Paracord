import { prefersReducedMotion } from '../../../lib/motion/reducedMotion';

/**
 * The two Index curves and the reduced-motion rule (docs/index-spec.md §5).
 *
 * The same values are CSS tokens (`--ix-spring`, `--ix-ease` in tokens.css) for
 * transitions; Web Animations need them as strings, so they live here too. A
 * test pins the two copies together.
 */

/** `cubic-bezier(.32,.72,0,1)`: every move (slides, FLIPs, lifts). */
export const IX_SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** `cubic-bezier(.2,.8,.2,1)`: fades and color (tint crossfade, leaving rows). */
export const IX_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** Reduced motion replaces every move with an opacity crossfade of this length (§5). */
export const IX_REDUCED_MS = 150;

/**
 * Whether motion is reduced right now: the app's one switch (OS setting folded
 * with Settings › Appearance › Motion, `lib/motion/reducedMotion.ts`). Never ask
 * `matchMedia` yourself (the motion lint forbids it).
 */
export function ixReduced(): boolean {
  return prefersReducedMotion();
}

/** True when the element can play a Web Animation (jsdom has no `animate`). */
export function canAnimate(element: Element | null | undefined): element is HTMLElement {
  return element != null && typeof (element as HTMLElement).animate === 'function';
}
