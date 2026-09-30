import { prefersReducedMotion } from '../../../lib/motion';

/**
 * The pill's grow and shrink (docs/glass-spec.md §5, §9: "grows to exactly the
 * column's width and about 222px tall (spring, 550ms)").
 *
 * The layout changes at once (the capsule is at its new size and place from the
 * first frame) and this plays the difference back, FLIP style, on transform:
 *
 *   surface  scaled from where it was to where it is, from its top right corner.
 *            Its border-radius rides the same curve, counter-scaled, so a
 *            capsule scaled to a different aspect keeps round ends instead of
 *            squashing them (§9: "position, size and radius animate together").
 *            It paints a flat fill and a hairline, so repainting it is cheap.
 *   glow     the soft shadow and the amber glow beneath, on a layer of their own
 *            that only scales (transform, nothing to repaint): a 50px blur is
 *            the one thing that must not be painted every frame on WebKitGTK.
 *   faces    the group of faces and the name slides by the distance the capsule's
 *            left edge moved; the controls, at the right edge, stay put.
 *
 * Nothing else moves: the roster fades in behind it (CSS). Reduced motion plays
 * nothing here; the roster's crossfade is CSS (`data-motion='reduced'`).
 */

export const PILL_SPRING_MS = 550;

/** The prototype's spring: a little overshoot, then rest. */
export const PILL_SPRING = 'cubic-bezier(0.3, 1.25, 0.5, 1)';

/** How long the words take to fade before the capsule shrinks. */
export const PILL_FADE_MS = 120;
export const PILL_FADE_REDUCED_MS = 150;

export interface PillGeometry {
  /** The capsule (the surface's box). */
  box: { left: number; right: number; top: number; width: number; height: number };
  /** Left edge of the faces-and-name group. */
  whoLeft: number;
  /** The capsule's corner radius, px. */
  radius: number;
}

/** Where the capsule and its faces are now, transforms included. */
export function measurePill(surface: HTMLElement | null, who: HTMLElement | null): PillGeometry | null {
  if (!surface || !who) return null;
  const rect = surface.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const radius = Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0;
  return {
    box: { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height },
    whoLeft: who.getBoundingClientRect().left,
    radius,
  };
}

/** Stop whatever is still playing, so the next measurement is the layout's own. */
export function settlePill(...elements: Array<HTMLElement | null>): void {
  for (const element of elements) {
    if (!element || typeof element.getAnimations !== 'function') continue;
    for (const animation of element.getAnimations()) {
      if (animation.id.startsWith('glass-pill:')) animation.cancel();
    }
  }
}

const MIN_DELTA = 0.5;

/**
 * Play the move from `first` to `last`. Returns the animations (none when there
 * is nothing to move, no Web Animations, or reduced motion).
 */
export function playPillResize(
  surface: HTMLElement,
  glow: HTMLElement | null,
  who: HTMLElement,
  first: PillGeometry,
  last: PillGeometry,
  duration: number = PILL_SPRING_MS,
): Animation[] {
  if (prefersReducedMotion()) return [];
  if (typeof surface.animate !== 'function') return [];
  const animations: Animation[] = [];
  const scaleX = first.box.width / Math.max(1, last.box.width);
  const scaleY = first.box.height / Math.max(1, last.box.height);
  const dx = first.box.right - last.box.right;
  const dy = first.box.top - last.box.top;
  const options = { duration, easing: PILL_SPRING, fill: 'both' as const };

  if (
    Math.abs(scaleX - 1) > 0.002
    || Math.abs(scaleY - 1) > 0.002
    || Math.abs(dx) > MIN_DELTA
    || Math.abs(dy) > MIN_DELTA
  ) {
    // The first frame must look like the old capsule, so its rendered radius is
    // the old one: divide it by the scale it is drawn under.
    const start = `${(first.radius / scaleX).toFixed(2)}px / ${(first.radius / scaleY).toFixed(2)}px`;
    const end = `${last.radius}px`;
    const animation = surface.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, borderRadius: start },
        { transform: 'translate(0, 0) scale(1, 1)', borderRadius: end },
      ],
      options,
    );
    animation.id = 'glass-pill:surface';
    animations.push(animation);
    if (glow && typeof glow.animate === 'function') {
      const shadow = glow.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})` },
          { transform: 'translate(0, 0) scale(1, 1)' },
        ],
        options,
      );
      shadow.id = 'glass-pill:glow';
      animations.push(shadow);
    }
  }

  const shift = first.whoLeft - last.whoLeft;
  if (Math.abs(shift) > MIN_DELTA && typeof who.animate === 'function') {
    const animation = who.animate(
      [{ transform: `translateX(${shift}px)` }, { transform: 'translateX(0)' }],
      options,
    );
    animation.id = 'glass-pill:who';
    animations.push(animation);
  }

  // `fill: both` holds the last frame, which is the resting one; drop it when
  // the move is over so nothing keeps a transform layer alive.
  for (const animation of animations) {
    void animation.finished.then(
      () => animation.cancel(),
      () => {
        /* canceled by the next move */
      },
    );
  }
  return animations;
}
