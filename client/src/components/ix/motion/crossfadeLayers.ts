import { IX_EASE, IX_REDUCED_MS, canAnimate, ixReduced } from './curves';

/**
 * A crossfade of stacked layers (docs/index-spec.md §5.1 "Window tint").
 *
 * The new layer is drawn ABOVE the old one and fades in from opacity 0; the old
 * one stays fully opaque underneath and is removed when the fade settles. Only
 * the new layer animates, and only its opacity: no custom property, gradient or
 * color is interpolated (a registered `--hue` transition, the prototype's way,
 * repaints the whole window every frame on WebKitGTK).
 *
 * Both layers must be opaque for this to read as a crossfade (the Index tint
 * layers are: the main glow is painted over `--ix-main`, the sidebar gradient
 * ends on `--ix-side-end`).
 */

/** The window tint crossfade, 410ms ease (§5.1). */
export const TINT_FADE_MS = 410;

export interface CrossfadeOptions {
  /** Default 410ms (the tint). Reduced motion always uses 100ms. */
  duration?: number;
  easing?: string;
  reduced?: boolean;
  id?: string;
}

/** Fade `incoming` in over whatever is beneath it. Returns null when nothing can play. */
export function crossfadeLayers(
  incoming: HTMLElement | null,
  { duration = TINT_FADE_MS, easing = IX_EASE, reduced = ixReduced(), id = 'ix-crossfade' }: CrossfadeOptions = {},
): Animation | null {
  if (!canAnimate(incoming)) return null;
  const animation = incoming.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: reduced ? IX_REDUCED_MS : duration,
    easing: reduced ? 'ease-out' : easing,
  });
  animation.id = id;
  return animation;
}
