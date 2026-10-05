import { IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from '../../ix/motion';
import type { PhoneScreen } from './phoneNav';

/**
 * The phone's push and pop (docs/index-spec.md §9; IX-16, which owns this file
 * now): a page slides in from the right over the screen it was opened from,
 * 165ms on the spring, while that screen moves 30% to the left beneath it and
 * dims; going back is the same move reversed. Reduced motion: a 100ms
 * crossfade in place.
 *
 * One model serves every push on a phone:
 *
 *   top     the page that is pushed (main over the sidebar; a sheet over main)
 *   under   the screen it covers
 *   shade   a dim layer inside `under` (`.ix-phone-shade`), so the screen
 *           beneath reads as behind without a filter
 *
 * and one number places all three: `x`, how far the top page has been pushed
 * away. `x = 0` is the top page covering everything (pushed); `x = 1` is the
 * top page gone off the right edge (the screen beneath is in front). The edge
 * swipe drives `x` with a finger and hands the rest of the move to these
 * functions, so a gesture and a tap end in the same frames.
 *
 * Only `transform` and `opacity` move (the motion lint). The resting states are
 * CSS (ix-phone.css): the screen in front at rest, the one behind at -30% with
 * its shade up. These play the way from one resting state to the other, so the
 * first frame is what was on screen and the last is what the CSS now says, and
 * nothing fills forwards.
 */

/** The push, in ms (§9). */
export const PHONE_SLIDE_MS = 165;
/** The reduced-motion crossfade. */
export const PHONE_FADE_MS = IX_REDUCED_MS;
/** How far the screen beneath moves while a page covers it (§9: "the root moves -30% beneath"). */
export const UNDER_SHIFT = 30;
/** The shortest finish a released swipe plays: anything less reads as a snap. */
export const PHONE_MIN_FINISH_MS = 65;

export interface PushLayers {
  top: HTMLElement | null;
  under: HTMLElement | null;
  shade: HTMLElement | null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The top page's transform at `x`. */
export function topTransform(x: number): string {
  return x <= 0 ? 'none' : `translateX(${round(x * 100)}%)`;
}

/** The covered screen's transform at `x`. */
export function underTransform(x: number): string {
  return x >= 1 ? 'none' : `translateX(${round(-UNDER_SHIFT * (1 - x))}%)`;
}

/** The shade's opacity at `x`. */
export function shadeOpacity(x: number): number {
  return round(Math.min(1, Math.max(0, 1 - x)));
}

/** Write `x` straight onto the layers (a finger is moving them). */
export function paintPush(layers: PushLayers, x: number): void {
  const clamped = Math.min(1, Math.max(0, x));
  if (layers.top) layers.top.style.transform = topTransform(clamped);
  if (layers.under) layers.under.style.transform = underTransform(clamped);
  if (layers.shade) layers.shade.style.opacity = String(shadeOpacity(clamped));
}

/** Take the finger's writes off again (the CSS resting state is in charge). */
export function clearPush(layers: PushLayers): void {
  if (layers.top) layers.top.style.transform = '';
  if (layers.under) layers.under.style.transform = '';
  if (layers.shade) layers.shade.style.opacity = '';
}

export interface PushMoveOptions {
  /** Ms; default `PHONE_SLIDE_MS`, scaled by the distance left when `from` is given. */
  duration?: number;
  /** An id prefix; the animations are `<id>:top`, `<id>:under`, `<id>:shade`. */
  id?: string;
}

/**
 * Move the layers from `from` to `to` (both `x`). With no finger involved that
 * is 1 -> 0 (push) or 0 -> 1 (pop); after a swipe it is wherever the finger
 * let go to the end it was going to. Reduced motion: the screen that ends in
 * front fades in over 150ms, the other fades out, both where they rest.
 */
export function playPush(layers: PushLayers, from: number, to: number, options: PushMoveOptions = {}): Animation[] {
  const id = options.id ?? 'ix-phone';
  const started: Animation[] = [];
  const play = (el: HTMLElement | null, frames: Keyframe[], part: string, duration: number, easing: string) => {
    if (!canAnimate(el)) return;
    const animation = el.animate(frames, { duration, easing });
    animation.id = `${id}:${part}`;
    started.push(animation);
  };

  if (ixReduced()) {
    const pushing = to < from;
    // The page that ends in front fades in; the one leaving fades out, both
    // held where they rest (the leaving one at its old place until it is gone).
    play(layers.top, pushing ? [{ opacity: 0 }, { opacity: 1 }] : [
      { opacity: 1, transform: topTransform(from) },
      { opacity: 0, transform: topTransform(from) },
    ], 'top', PHONE_FADE_MS, 'ease-out');
    play(layers.under, pushing ? [
      { opacity: 1, transform: underTransform(from) },
      { opacity: 0, transform: underTransform(from) },
    ] : [{ opacity: 0 }, { opacity: 1 }], 'under', PHONE_FADE_MS, 'ease-out');
    return started;
  }

  const distance = Math.abs(to - from);
  const duration =
    options.duration ?? (distance >= 1 ? PHONE_SLIDE_MS : Math.max(PHONE_MIN_FINISH_MS, Math.round(PHONE_SLIDE_MS * distance)));
  play(layers.top, [{ transform: topTransform(from) }, { transform: topTransform(to) }], 'top', duration, IX_SPRING);
  play(layers.under, [{ transform: underTransform(from) }, { transform: underTransform(to) }], 'under', duration, IX_SPRING);
  play(layers.shade, [{ opacity: shadeOpacity(from) }, { opacity: shadeOpacity(to) }], 'shade', duration, IX_SPRING);
  return started;
}

/** The shade inside a screen (`.ix-phone-shade`), if it has one. */
export function shadeOf(screen: HTMLElement | null): HTMLElement | null {
  return screen?.querySelector<HTMLElement>(':scope > .ix-phone-shade') ?? null;
}

/**
 * The frame's own push: main over the sidebar (to `conversation`) or back (to
 * `places`). `from` is where a swipe let go (`x`); without one the whole move
 * plays. Returns the animations so the caller can cancel them.
 */
export function playPhoneScreens(
  places: HTMLElement | null,
  conversation: HTMLElement | null,
  to: PhoneScreen,
  from?: number,
): Animation[] {
  const target = to === 'conversation' ? 0 : 1;
  const start = from ?? (to === 'conversation' ? 1 : 0);
  return playPush({ top: conversation, under: places, shade: shadeOf(places) }, start, target, { id: 'ix-phone' });
}
