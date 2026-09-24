import { ghost, ghostOut, recede } from './animate';
import { RECEDE_MARK, markSelector } from './marks';
import { prefersReducedMotion } from './reducedMotion';
import { transitionWith, type SharedTransitionResult } from './sharedElement';
import { motionToken, ms } from './tokens';

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

/** Marks the branch that is traveling, so a clone can find it again. */
const TRAVELING = 'data-motion-traveling';

/**
 * The surface you are walking out of steps back 4% and fades (§5.1 "the rest
 * of the Lobby recedes"), **as a ghost**.
 *
 * The first frame strip of this moment showed the recede never happening: the
 * route change unmounts the Lobby on the same tick, so an animation on the live
 * elements had nothing left to play on and the screen simply went empty for a
 * beat. The View Transitions path never had the problem — the browser holds a
 * snapshot of the old frame for exactly this reason — so the fallback grows the
 * same thing by hand. One clone of the region, parked over the page, receding
 * while the room you are entering arrives underneath it.
 *
 * The branch the origin is on is hidden IN THE CLONE, because that branch is
 * not receding: it is traveling.
 */
export function recedeAround(origin: Element | null | undefined, root: ParentNode = document): Animation[] {
  const animations: Animation[] = [];
  for (const region of root.querySelectorAll<HTMLElement>(`[${RECEDE_MARK}]`)) {
    const inside = origin ? region.contains(origin) || region === origin : false;
    if (inside && origin) origin.setAttribute(TRAVELING, '');
    const animation = ghostOut(region, (copy) => {
      const traveling = copy.querySelector<HTMLElement>(`[${TRAVELING}]`);
      if (traveling) traveling.style.visibility = 'hidden';
      return recede(copy);
    });
    if (inside && origin) origin.removeAttribute(TRAVELING);
    if (animation) animations.push(animation);
  }
  return animations;
}

/** How long the held card waits for the room to arrive before giving up. */
const HOLD_MS = 900;

/**
 * Hold the thing you clicked on screen until the room you clicked it for is
 * there to take over from it.
 *
 * The route change unmounts the card on the same tick, and the room behind it
 * is a lazy chunk and a React render away — so on the Web Animations path the
 * traveling element simply vanished for ~200ms and reappeared at its
 * destination. The frame strip showed it; the budget did not, because dropping
 * an element is free.
 *
 * The View Transitions path never needed this: the browser holds a snapshot of
 * the whole old frame for exactly this reason. This is that, for one element.
 */
function holdOrigin(origin: Element, name: string, destinationRoot: string): void {
  if (prefersReducedMotion()) return;
  const copy = ghost(origin);
  if (!copy) return;
  const deadline = Date.now() + HOLD_MS;
  const selector = `${destinationRoot} ${markSelector('data-motion-shared', name)}`;
  // The surface being left is still in the document for a tick after the route
  // changes, so "has the room arrived?" has to mean something other than it.
  const arrived = () => {
    for (const candidate of document.querySelectorAll(selector)) {
      if (candidate !== origin) return true;
    }
    return false;
  };
  const release = () => {
    const out = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: ms('--duration-fast'),
      easing: motionToken('--ease-out'),
      fill: 'forwards',
    });
    out.addEventListener('finish', () => copy.remove());
    window.setTimeout(() => copy.remove(), 1_000);
  };
  const look = () => {
    if (arrived() || Date.now() > deadline) {
      release();
      return;
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/**
 * Walk into a room. The origin becomes the Stage's dominant tile; the rest of
 * the surface you left recedes; the Stage's chrome rises 80ms behind it.
 */
export function walkIntoRoom({ channelId, origin, go }: WalkOptions): Promise<SharedTransitionResult> {
  return transitionWith(go, {
    names: [roomSharedName(channelId)],
    origin,
    // A room lands in the main content area. Without this the card flew into
    // the sidebar row that carries the same name — see `destinationRoot`.
    destinationRoot: 'main',
    kind: 'walk-in',
    beforeUpdate: (engine) => {
      // On the View Transitions path the root snapshot carries the recede, in
      // CSS keyed to the stamp — the browser has already frozen the old frame
      // by the time an animation of ours could touch it.
      if (engine !== 'flip') return;
      recedeAround(origin);
      if (origin) holdOrigin(origin, roomSharedName(channelId), 'main');
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
