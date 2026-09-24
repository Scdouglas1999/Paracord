import { prefersReducedMotion } from './reducedMotion';
import { springEasing, springTokens, type SpringConfig } from './spring';
import { motionToken, ms } from './tokens';

/**
 * The engine's recipes (docs/lantern-stage-spec.md §5.1).
 *
 * Every one of these is Web Animations over the §5 tokens — no framework, no
 * a motion framework, nothing that owns the render loop. They obey three rules:
 *
 *   1. **Budget (§5.3).** `transform` and `opacity` only. Not a shadow, not a
 *      background, not a filter, and never a layout property: a light that
 *      comes on or goes out does it by crossfading still glows in opacity.
 *   2. **One switch (§5.3).** Under reduced motion every recipe lands its end
 *      state on the spot and returns a finished animation, so a caller that
 *      awaits `.finished` still resolves and a caller that cancels still can.
 *   3. **Interruptible.** Each returns the `Animation`, and each cancels the
 *      recipe it replaces on that element, so a second send cannot stack a
 *      second lift on the first.
 */

/** Something to animate: an element, in a renderer with WAAPI (jsdom has none). */
function animatable(el: Element | null | undefined): el is HTMLElement {
  return Boolean(el) && typeof (el as HTMLElement).animate === 'function';
}

/** The finished no-op a recipe returns under reduced motion. */
function landed(el: Element): Animation | null {
  if (!animatable(el)) return null;
  const animation = el.animate([], { duration: 0 });
  animation.finish();
  return animation;
}

/** Recipes tag their animations so a later one can cancel the earlier. */
const RECIPE = 'data-motion-recipe';

function cancelRecipe(el: Element, id: string): void {
  if (typeof el.getAnimations !== 'function') return;
  for (const running of el.getAnimations()) {
    if ((running as Animation & { id?: string }).id === `${RECIPE}:${id}`) running.cancel();
  }
}

function run(el: Element, id: string, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (!animatable(el)) return null;
  cancelRecipe(el, id);
  const animation = el.animate(keyframes, options);
  animation.id = `${RECIPE}:${id}`;
  return animation;
}

/* -------------------------------------------------------------------------- */
/* Light: bloom, dim, flicker                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Scale a computed `box-shadow` — every length by `spread`, every alpha by
 * `alpha`. Kept for callers that DRAW a brighter still glow (a layer they then
 * crossfade); no recipe here animates a shadow.
 */
export function scaleShadow(shadow: string, { spread = 1, alpha = 1 } = {}): string {
  if (!shadow || shadow === 'none') return shadow;
  return shadow
    .replace(/(-?\d*\.?\d+)px/g, (_, value: string) => `${Number((Number.parseFloat(value) * spread).toFixed(2))}px`)
    .replace(/rgba?\(([^)]*)\)/g, (whole: string, body: string) => {
      const parts = body.split(/\s*[,/]\s*/).filter(Boolean);
      if (parts.length < 4) return whole;
      const next = Math.min(1, Math.max(0, Number.parseFloat(parts[3]) * alpha));
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${Number(next.toFixed(3))})`;
    });
}

/**
 * A light coming on: it warms up from 55% to full over 220ms, `--ease-out`
 * (§5.1 "light has a source and a speed"). Opacity only — the glow itself is
 * a still layer the stylesheet already crossfaded in.
 */
export function bloom(el: Element | null | undefined, options: { delay?: number } = {}): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  return run(el, 'bloom', [{ opacity: 0.55 }, { opacity: 1 }], {
    duration: ms('--duration-warm-up'),
    easing: motionToken('--ease-out'),
    delay: options.delay ?? 0,
    fill: 'none',
  });
}

/**
 * A light going out. The stylesheet already fades a window's glow layer over
 * `--duration-dim` when it loses its lit class, and an avatar's rim is a
 * shadow that may not animate, so there is nothing left for script to do:
 * this lands on the spot. It stays in the engine's surface so the arrival
 * choreography reads the same either way.
 */
export function dim(el: Element | null | undefined, _from?: string): Animation | null {
  if (!animatable(el)) return null;
  return landed(el);
}

/**
 * Reading light flickers once when a message lands — two short opacity
 * pulses, 200ms in all (§5.1). The room's amber window is the only thing in
 * the product that does this.
 */
export function flicker(el: Element | null | undefined): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  // 200ms total: pulse (40) · rise (40) · pulse (50) · settle (70).
  return run(
    el,
    'flicker',
    [
      { opacity: 1, offset: 0 },
      { opacity: 0.55, offset: 0.2 },
      { opacity: 1, offset: 0.4 },
      { opacity: 0.7, offset: 0.65 },
      { opacity: 1, offset: 1 },
    ],
    { duration: 200, easing: motionToken('--ease-out'), fill: 'none' },
  );
}

/* -------------------------------------------------------------------------- */
/* Things that move: settle, stagger, press                                    */
/* -------------------------------------------------------------------------- */

export interface SettleOptions {
  /** Rise distance in px. 8 by default — nothing travels further (§5.2). */
  distance?: number;
  delay?: number;
  /** Override `--duration-slow`. */
  duration?: number;
  spring?: SpringConfig;
}

/**
 * A thing arriving: it rises `distance` px onto its mark on `--ease-out`,
 * fading in as it comes (§5.1 "plates settle").
 */
export function settleIn(el: Element | null | undefined, options: SettleOptions = {}): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  const distance = Math.min(8, options.distance ?? 8);
  const duration = options.duration ?? ms('--duration-slow');
  return run(
    el,
    'settle',
    [
      { transform: `translate3d(0, ${distance}px, 0)`, opacity: 0 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
    ],
    {
      duration,
      delay: options.delay ?? 0,
      easing: springEasing(options.spring ?? springTokens(), { durationMs: duration }),
      fill: 'backwards',
    },
  );
}

export interface StaggerOptions extends SettleOptions {
  /** Gap between neighbours. Defaults to `--stagger-light` (30ms). */
  step?: number;
}

/**
 * Neighbouring things arrive 30ms apart (§5.1). Returns one animation per
 * element, in order, so the caller can cancel the whole run.
 */
export function stagger(
  elements: Iterable<Element | null | undefined>,
  options: StaggerOptions = {},
): Array<Animation | null> {
  const step = options.step ?? ms('--stagger-light');
  const base = options.delay ?? 0;
  return [...elements].map((el, index) => settleIn(el, { ...options, delay: base + index * step }));
}

/** A control under a finger: 0.98 over 120ms, and back over 120ms (§5.1). */
export function press(el: Element | null | undefined): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  const step = ms('--duration-fast');
  return run(
    el,
    'press',
    [
      { transform: 'scale(1)', offset: 0 },
      { transform: 'scale(0.98)', offset: 0.5 },
      { transform: 'scale(1)', offset: 1 },
    ],
    { duration: step * 2, easing: motionToken('--ease-out'), fill: 'none' },
  );
}

/**
 * The send control catching the light for one beat (§5.1 "a message has mass").
 *
 * The light is written as INLINE STYLE, not a class: the control is a React
 * element whose `className` is recomputed on the very next render (the send
 * makes it busy), which would wipe a class the engine added microseconds
 * earlier. React does not own this element's `style`, so the beat survives. It
 * is removed after 80ms, or if the animation is cancelled.
 *
 * The light is a state, not an animation: it is on for the beat and off
 * after it. Only the press is animated, and only in transform.
 */
const FLASH_LIGHT: ReadonlyArray<readonly [string, string]> = [
  // A beat, not a fade: the control almost always carries a colour transition
  // for its hover state, and leaving it on turns the flash into a 140ms ramp
  // that never reaches the light. Removing the properties restores the
  // transition, so it comes ON like a light and goes off like one.
  ['transition', 'none'],
  ['background', 'var(--light-white)'],
  ['color', 'var(--text-on-light)'],
];

export function flash(el: Element | null | undefined): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  for (const [property, value] of FLASH_LIGHT) el.style.setProperty(property, value, 'important');
  const animation = run(el, 'flash', [{ transform: 'scale(0.98)' }, { transform: 'scale(1)' }], {
    duration: ms('--duration-normal'),
    easing: motionToken('--ease-out'),
    fill: 'none',
  });
  const unlight = () => {
    for (const [property] of FLASH_LIGHT) el.style.removeProperty(property);
  };
  if (animation) {
    window.setTimeout(unlight, 80);
    animation.addEventListener('cancel', unlight);
  } else unlight();
  return animation;
}

/**
 * A message leaving the composer: the words lift 8px and fade as the row
 * lands in the timeline — `--duration-exit-slow`, `--ease-out`, transform and
 * opacity only (§5.1).
 */
export function liftOut(
  el: Element | null | undefined,
  options: { distance?: number; duration?: number } = {},
): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  const distance = Math.min(8, options.distance ?? 8);
  return run(
    el,
    'lift',
    [
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      { transform: `translate3d(0, ${-distance}px, 0)`, opacity: 0 },
    ],
    {
      duration: options.duration ?? ms('--duration-exit-slow'),
      easing: motionToken('--ease-out'),
      fill: 'forwards',
    },
  );
}

/**
 * New content settling into a surface that stayed put — the channel you
 * switched to, a settings section, another panel mode. A crossfade with a 4px
 * rise over `--duration-slow`, never a slide (§5.2).
 */
export function contentIn(el: Element | null | undefined): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  return run(
    el,
    'content',
    [
      { transform: 'translate3d(0, 4px, 0)', opacity: 0 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
    ],
    { duration: ms('--duration-slow'), easing: motionToken('--ease-out'), fill: 'backwards' },
  );
}

/**
 * Something answering after the fact — a receipt once the server has spoken.
 * Opacity only, `--ease-out`, and it waits its turn behind the thing it
 * belongs to (§5.1: "receipts fade in only after the server answers").
 */
export function fadeIn(el: Element | null | undefined, options: { delay?: number; duration?: number } = {}): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  return run(el, 'fade', [{ opacity: 0 }, { opacity: 1 }], {
    duration: options.duration ?? ms('--duration-slow'),
    delay: options.delay ?? 0,
    easing: motionToken('--ease-out'),
    fill: 'backwards',
  });
}

/** The composer relaxing 0.8% under the send and springing back (§5.1). */
export function relax(el: Element | null | undefined): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  const duration = ms('--duration-slow');
  return run(
    el,
    'relax',
    [
      { transform: 'scale(1)', offset: 0 },
      { transform: 'scale(0.992)', offset: 0.3 },
      { transform: 'scale(1)', offset: 1 },
    ],
    { duration, easing: motionToken('--ease-out'), fill: 'none' },
  );
}

/* -------------------------------------------------------------------------- */
/* Walking through: recede, arrive, leave                                      */
/* -------------------------------------------------------------------------- */

/**
 * The room you are walking out of stepping back (§5.1 "the thing you click
 * becomes the thing you look at": the rest of the Lobby recedes while the card
 * you clicked travels).
 *
 * `fill: 'forwards'` on purpose — the element it is played on is usually about
 * to be unmounted by the route change, and a recede that snapped back for the
 * last frame before it went would read as a flinch.
 */
export function recede(el: Element | null | undefined, options: { duration?: number } = {}): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  return run(
    el,
    'recede',
    [
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(0.98)', opacity: 0 },
    ],
    {
      duration: options.duration ?? ms('--duration-move'),
      easing: motionToken('--ease-out'),
      fill: 'forwards',
    },
  );
}

/**
 * Somebody arriving into a strip of faces (§5.1 "arrivals travel one path":
 * they spring into the here-now strip).
 *
 * The study animates the slot's width; this does not. §5.3 puts no layout
 * property in a keyframe, so the newcomer springs in on transform and opacity
 * and everything the insertion displaced is carried by `captureFlip` — also
 * transform only. The two together are the study's motion with the budget
 * kept.
 */
export function arriveIn(
  el: Element | null | undefined,
  options: { delay?: number; distance?: number; spring?: SpringConfig } = {},
): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  const duration = ms('--duration-slow');
  const distance = Math.min(8, options.distance ?? 6);
  return run(
    el,
    'arrive',
    [
      { transform: `translate3d(${distance}px, 0, 0) scale(0.9)`, opacity: 0 },
      { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
    ],
    {
      duration,
      delay: options.delay ?? 0,
      easing: springEasing(options.spring ?? springTokens(), { durationMs: duration }),
      fill: 'backwards',
    },
  );
}

/**
 * The mirror: a face sliding out of the strip (§5.1 "leaving is the mirror").
 * `--ease-in`, like every other light going out — it lingers a beat, then goes.
 */
export function slideOut(
  el: Element | null | undefined,
  options: { delay?: number; distance?: number } = {},
): Animation | null {
  if (!animatable(el)) return null;
  if (prefersReducedMotion()) return landed(el);
  const distance = Math.min(8, options.distance ?? 6);
  return run(
    el,
    'leave',
    [
      { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
      { transform: `translate3d(${distance}px, 0, 0) scale(0.9)`, opacity: 0 },
    ],
    {
      duration: ms('--duration-exit-slow'),
      delay: options.delay ?? 0,
      easing: motionToken('--ease-in'),
      fill: 'forwards',
    },
  );
}

/* -------------------------------------------------------------------------- */
/* The ghost — animating something that is already gone                        */
/* -------------------------------------------------------------------------- */

/**
 * A copy of an element, parked over the real one, for the length of one exit.
 *
 * Somebody leaving a room is removed from the strip by the store update that
 * told us they left — by the time React has rendered, the face is not in the
 * document to animate. WP9a hit the same wall with the composer's lifting words
 * and answered it the same way: **the thing that moves is a ghost, not the
 * element**. The ghost is DOM the engine owns outright, so no re-render can
 * wipe it and no component has to hold a leaving person in its state.
 *
 * It is `aria-hidden` and `pointer-events: none`: it is a picture of something
 * that has already happened, and assistive tech is told about the change by the
 * live region on the count, not by a corpse in the tree.
 */
const GHOST_LAYER_ID = 'pc-motion-ghosts';

function ghostLayer(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const existing = document.getElementById(GHOST_LAYER_ID);
  if (existing) return existing;
  const layer = document.createElement('div');
  layer.id = GHOST_LAYER_ID;
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:var(--z-motion-ghost, 900);';
  document.body.append(layer);
  return layer;
}

/** Clone `el` where it stands and park the copy in the ghost layer. */
export function ghost(el: Element | null | undefined): HTMLElement | null {
  if (!animatable(el) || prefersReducedMotion()) return null;
  const layer = ghostLayer();
  if (!layer) return null;
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.style.position = 'fixed';
  copy.style.left = `${box.left}px`;
  copy.style.top = `${box.top}px`;
  copy.style.width = `${box.width}px`;
  copy.style.height = `${box.height}px`;
  copy.style.margin = '0';
  copy.style.pointerEvents = 'none';
  // A ghost is a picture, and the only thing that will ever happen to it is a
  // transform and an opacity. Saying so gives it its own compositor layer, so
  // receding a copy of a whole surface costs the compositor rather than the
  // main thread.
  copy.style.willChange = 'transform, opacity';
  copy.style.contain = 'layout paint';
  layer.append(copy);
  return copy;
}

/**
 * Clone `el` where it stands and hand the copy to `play`. The ghost is removed
 * when the animation finishes or is cancelled — and immediately if nothing
 * played, so a reduced-motion run leaves nothing behind.
 */
export function ghostOut(
  el: Element | null | undefined,
  play: (copy: HTMLElement) => Animation | null,
): Animation | null {
  const copy = ghost(el);
  if (!copy) return null;
  const remove = () => copy.remove();
  const animation = play(copy);
  if (!animation) {
    remove();
    return null;
  }
  animation.addEventListener('finish', remove);
  animation.addEventListener('cancel', remove);
  // A belt-and-braces sweep: an animation on a detached-then-reattached element
  // can lose its events, and a ghost that outlives its moment is litter.
  window.setTimeout(remove, 2_000);
  return animation;
}
