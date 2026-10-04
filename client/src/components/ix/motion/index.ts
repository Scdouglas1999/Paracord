/**
 * Index motion helpers (docs/index-spec.md §5; owner IX-4, then IX-18).
 *
 * Index-only, so they never collide with `feat/send-flight`'s edits to
 * `lib/motion` (docs/design/index-plan.md §2.1). Every helper plays Web
 * Animations on `transform` and `opacity` only, honors the app's one reduced-
 * motion switch, and returns its `Animation`s (or null) so the caller can
 * `onSettle` a cleanup and `commit` them when a newer event of the same kind
 * starts.
 *
 *   curves .......... IX_SPRING, IX_EASE, IX_REDUCED_MS, ixReduced(), canAnimate()
 *   onSettle ........ onSettle(animations, done) -> dispose; commit(animations)
 *   slidePanes ...... the sidebar's place switch (§5.1)
 *   crossfadeLayers . a new layer fading in over an old one (the tint, §5.1)
 *   flipFromRect .... FLIP from a rect: measureRect, flipFromRect, invertTransform,
 *                     measureRects + flipMoved (displaced content)
 */
export { IX_EASE, IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from './curves';
export { commit, onSettle } from './onSettle';
export { PANE_IN_MS, PANE_IN_SHIFT, PANE_OUT_MS, PANE_OUT_SHIFT, slidePanes } from './slidePanes';
export type { SlideDirection, SlidePanesResult } from './slidePanes';
export { TINT_FADE_MS, crossfadeLayers } from './crossfadeLayers';
export type { CrossfadeOptions } from './crossfadeLayers';
export { flipFromRect, flipMoved, invertTransform, measureRect, measureRects } from './flipFromRect';
export type { FlipFromRectOptions, RectLike } from './flipFromRect';
