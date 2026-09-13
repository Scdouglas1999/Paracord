import { recede } from './animate';
import { RECEDE_MARK } from './marks';
import { transitionWith, type SharedTransitionResult } from './sharedElement';

/**
 * "Walk into a room / back to the pill"
 * (docs/lantern-stage-spec.md §5.1, study `MotionWalkIn.html`).
 *
 * You do not teleport into a room, you walk in: the thing you clicked becomes
 * the thing you look at. One shared element — `room-<channelId>` — is on the
 * Lobby card, the sidebar row, the inline "lit up" event, the Stage's dominant
 * tile and the on-air pill, so every door into a room and every door out of it
 * is the same journey played in a different direction.
 *
 * `transitionWith` owns both engines; this module owns the choreography around
 * them: which element is the origin, what recedes behind it, and the fact that
 * **the route changes first**. §5.3: motion never delays input. `navigate()`
 * runs inside the update callback with nothing awaited before it.
 */

/** The one name a room travels under, on every surface that draws it. */
export function roomSharedName(channelId: string): string {
  return `room-${channelId}`;
}

export interface WalkOptions {
  /** The room being walked into or out of. */
  channelId: string;
  /** The element the person actually clicked — the card, the row, the pill. */
  origin?: Element | null;
  /** Route now. Run synchronously inside the transition's update. */
  go: () => void;
}

/**
 * Everything in a marked region except the branch the origin is on steps back
 * 4% and fades (§5.1 "the rest of the Lobby recedes").
 *
 * It walks down the branch the origin is on and recedes that branch's
 * *siblings* at every level, rather than the region as a whole: the origin is
 * inside the region and is the one thing that must not recede — it is
 * travelling. A region with no origin in it recedes whole, which is what
 * happens to the sidebar and the header when you leave from a card.
 */
export function recedeAround(origin: Element | null | undefined, root: ParentNode = document): Animation[] {
  const animations: Animation[] = [];

  const descend = (branch: Element, depth: number) => {
    // A guard, not a rule: a pathological tree should cost a few frames of
    // work, not a stack overflow.
    if (depth > 12) return;
    for (const child of branch.children) {
      if (origin && (child.contains(origin) || child === origin)) {
        if (child !== origin) descend(child, depth + 1);
        continue;
      }
      const animation = recede(child);
      if (animation) animations.push(animation);
    }
  };

  for (const region of root.querySelectorAll<HTMLElement>(`[${RECEDE_MARK}]`)) {
    if (origin && (region.contains(origin) || region === origin)) {
      descend(region, 0);
      continue;
    }
    const animation = recede(region);
    if (animation) animations.push(animation);
  }
  return animations;
}

/**
 * Walk into a room. The origin becomes the Stage's dominant tile; the rest of
 * the surface you left recedes; the Stage's chrome rises 80ms behind it.
 */
export function walkIntoRoom({ channelId, origin, go }: WalkOptions): Promise<SharedTransitionResult> {
  return transitionWith(go, {
    names: [roomSharedName(channelId)],
    origin,
    kind: 'walk-in',
    beforeUpdate: (engine) => {
      // On the View Transitions path the root snapshot carries the recede, in
      // CSS keyed to the stamp — the browser has already frozen the old frame
      // by the time an animation of ours could touch it.
      if (engine === 'flip') recedeAround(origin);
    },
  });
}

/**
 * Walk back out. The dominant tile shrinks into the on-air pill when you are
 * still in the room, and simply dims out with the page when you are not —
 * there is no pill to shrink into, and inventing a destination would be a lie
 * about where the room went.
 */
export function walkOutOfRoom({ channelId, origin, go }: WalkOptions): Promise<SharedTransitionResult> {
  return transitionWith(go, {
    names: [roomSharedName(channelId)],
    origin,
    kind: 'walk-out',
  });
}
