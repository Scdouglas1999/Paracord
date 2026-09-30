import { prefersReducedMotion } from '../../../lib/motion/reducedMotion';
import { GLASS_LAYOUT_CURVE } from '../../../lib/motion/sharedElement';
import type { PhoneScreen } from './phoneNav';

/**
 * The phone's screen change (docs/glass-spec.md §9): the conversation slides in
 * over places from the right, and places steps back a little and fades; going
 * back is the same move reversed. Reduced motion: a 150ms crossfade in place.
 *
 * Only `transform` and `opacity` move (the motion lint). The resting states are
 * CSS (glass-phone.css): the screen in front is at rest, the one behind is off to
 * its side and inert. This plays the way from one to the other, so the first
 * frame is exactly what was on screen and the last is what the CSS now says.
 * Web Animations rather than a CSS transition so that reduced motion can have
 * its own 150ms: the global switch zeroes every CSS duration (utilities.css).
 */

/** The slide, in ms. Shorter than the 650ms layout moves: it is a navigation, not a scene change. */
export const PHONE_SLIDE_MS = 360;
/** The reduced-motion crossfade (`--glass-ms-reduced`). */
export const PHONE_FADE_MS = 150;

const EASING = `cubic-bezier(${GLASS_LAYOUT_CURVE.join(', ')})`;
/** How far places steps back while the conversation covers it. */
const PLACES_SHIFT = 'translateX(-22%)';

type Frame = Keyframe[];

function animatable(el: HTMLElement | null): el is HTMLElement {
  return el !== null && typeof el.animate === 'function';
}

/** Play the change from `from` to `to`. Returns the animations so the caller can cancel them. */
export function playPhoneScreens(
  places: HTMLElement | null,
  conversation: HTMLElement | null,
  to: PhoneScreen,
): Animation[] {
  const reduced = prefersReducedMotion();
  const toConversation = to === 'conversation';
  const duration = reduced ? PHONE_FADE_MS : PHONE_SLIDE_MS;
  const options: KeyframeAnimationOptions = { duration, easing: reduced ? 'ease-out' : EASING };

  // The conversation has no surface of its own (it sits on the room), so places
  // shows through it while the two overlap. Places therefore leaves early and
  // arrives late: it is gone before the conversation has covered much of it, and
  // it comes back once the conversation has mostly left.
  // The screen coming in.
  const incoming: Frame = reduced
    ? [{ opacity: 0, transform: 'none' }, { opacity: 1, transform: 'none' }]
    : toConversation
      ? [{ transform: 'translateX(100%)' }, { transform: 'none' }]
      : [
          { opacity: 0, transform: PLACES_SHIFT, offset: 0 },
          { opacity: 0, offset: 0.4 },
          { opacity: 1, transform: 'none', offset: 1 },
        ];
  // The screen going out.
  const outgoing: Frame = reduced
    ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'none' }]
    : toConversation
      ? [
          { opacity: 1, transform: 'none', offset: 0 },
          { opacity: 0, offset: 0.7 },
          { opacity: 0, transform: PLACES_SHIFT, offset: 1 },
        ]
      : [{ transform: 'none' }, { transform: 'translateX(100%)' }];

  const started: Animation[] = [];
  const play = (el: HTMLElement | null, frames: Frame, name: string) => {
    if (!animatable(el)) return;
    const animation = el.animate(frames, options);
    animation.id = `glass-phone:${name}`;
    started.push(animation);
  };
  play(toConversation ? conversation : places, incoming, 'in');
  play(toConversation ? places : conversation, outgoing, 'out');
  return started;
}
