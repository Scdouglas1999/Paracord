/**
 * The decisions behind {@link CordMark}, kept apart from React so they can be
 * tested on their own: which drawing a size gets, which motion actually runs,
 * and which art files it needs.
 */

/**
 * - `none`: the still mark.
 * - `draw`: draws itself on once, about a second, easing out: up the stem,
 *   around the bowl, under the stem.
 * - `loading`: pulls out through its tail and draws back in, on a loop
 *   (about 1.7 s a cycle). It starts whole, so a still mark can hand over to it.
 * - `working`: the mark stays whole while a soft highlight runs along the cord,
 *   as if it were being pulled through. For long waits (connecting, setup).
 */
export type CordMotion = 'none' | 'draw' | 'loading' | 'working';

/**
 * The level of detail. `full`: the whole braid. `mid`: a coarser braid that
 * stays crisp at dock and section-loader size. `flat`: plain cord with fused
 * ends and the crossing gap, on a thicker cord, for tab, tray and button size.
 */
export type CordLevel = 'full' | 'mid' | 'flat';

/** `ember` is the brand's colors; `mono` is the flat mark in `currentColor`. */
export type CordTone = 'ember' | 'mono';

export const CORD_MOTIONS: readonly CordMotion[] = ['none', 'draw', 'loading', 'working'];

/** The full braid from this size up; below it, the coarser braid. */
export const CORD_FULL_FROM = 64;
/** The coarser braid from this size up; below it, the flat mark. */
export const CORD_MID_FROM = 24;

/** The drawing for a mark of `size` px (its box is square). */
export function cordLevel(size: number): CordLevel {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`CordMark needs a positive size in px, got ${size}`);
  }
  if (size >= CORD_FULL_FROM) return 'full';
  if (size >= CORD_MID_FROM) return 'mid';
  return 'flat';
}

/** The motion that runs: none at all when the app or the OS asks for reduced motion. */
export function cordMotion(motion: CordMotion, reducedMotion: boolean): CordMotion {
  return reducedMotion ? 'none' : motion;
}

/** Motions that never end, and so pause while the mark is offscreen. */
export function cordLoops(motion: CordMotion): boolean {
  return motion === 'loading' || motion === 'working';
}

/** The static art (public/brand, rendered by client/brand/render.mjs). */
export function cordArtSrc(level: CordLevel, part: 'whole' | 'under' = 'whole'): string {
  return `/brand/cord-${level}${part === 'under' ? '-under' : ''}.svg`;
}
