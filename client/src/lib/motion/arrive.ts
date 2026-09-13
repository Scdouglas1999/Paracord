import { arriveIn, bloom, dim, fadeIn, ghostOut, slideOut } from './animate';
import { captureFlip, type FlipCapture } from './flip';
import {
  EVENT_MARK,
  PERSON_MARK,
  RIM_MARK,
  STRIP_MARK,
  WINDOW_MARK,
  markSelector,
} from './marks';
import { prefersReducedMotion } from './reducedMotion';
import { ms } from './tokens';

/**
 * "Someone arrives / leaves" — arrivals travel one path
 * (docs/lantern-stage-spec.md §5.1, study `MotionArrives.html`).
 *
 *   their window blooms
 *   → their rim catches 120ms later, wherever a `LitAvatar` is drawn for them
 *   → they spring into the here-now strip / avatar stack
 *   → every count that changed re-rolls (`RollingNumber` does that itself)
 *   → the inline room event fades in last
 *
 * Leaving is the mirror: the rim dims over 400ms, the face slides out (as a
 * ghost — see `ghostOut`, because the store update that told us has already
 * taken the real face out of the tree), and the window cools if the room went
 * dark with them.
 *
 * **Nothing else on screen moves.** An avatar stack growing by one pushes the
 * faces after it — and the sentence beside them — 18px sideways. That is
 * something moving, so it is carried: `captureArrival()` measures before React
 * renders and `play()` FLIPs the displaced elements on transform alone.
 */

/** A rim catches 120ms after the room (§5.1). */
export const RIM_AFTER_ROOM_MS = 120;
/** The inline room event is last, behind the face that caused it. */
const EVENT_AFTER_MS = 260;
/**
 * A burst is one choreography, not five. Anybody arriving within this of the
 * first arrival joins the sequence that is already running, staggered behind
 * whoever is already in it.
 */
export const BURST_WINDOW_MS = 300;

/** One person, arriving in or leaving one room. */
export interface RoomPersonEvent {
  userId: string;
  /** The room's channel id — what `data-motion-window` carries. */
  roomId: string;
  /** The room has no one left in it: its window goes out with them. */
  roomWentDark?: boolean;
}

/** Everything an insertion into a strip can displace. */
const DISPLACEABLE = `[${STRIP_MARK}] *, [${STRIP_MARK}] ~ *`;

function all(root: ParentNode, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

function rimOf(person: Element): Element {
  return person.querySelector(`[${RIM_MARK}]`) ?? person;
}

/**
 * Measure what an arrival is about to push out of the way.
 *
 * Called from the store subscription, synchronously, while the DOM is still the
 * one without the newcomer in it. The returned capture's `play()` runs after
 * React has rendered.
 */
export function captureArrival(root: ParentNode | Document = document): FlipCapture {
  if (prefersReducedMotion()) return { play: () => [], size: 0 };
  return captureFlip(all(root as ParentNode, DISPLACEABLE));
}

/**
 * Play the arrival of `people`, staggered `--stagger-light` apart — one
 * sequence for the whole burst.
 *
 * `flip` is the capture taken before the render; pass it and the faces the
 * newcomer displaced travel with them instead of jumping.
 */
export function playArrivals(
  people: readonly RoomPersonEvent[],
  options: { root?: ParentNode; flip?: FlipCapture | null; startIndex?: number } = {},
): Animation[] {
  if (typeof document === 'undefined' || prefersReducedMotion() || people.length === 0) return [];
  const root = options.root ?? document;
  const step = ms('--stagger-light');
  const start = options.startIndex ?? 0;
  const animations: Animation[] = [];

  // Whatever the insertion displaced moves with the newcomer, not after them.
  if (options.flip) animations.push(...options.flip.play());

  people.forEach((person, order) => {
    // `startIndex` continues a burst already in flight, so the sixth person to
    // arrive is staggered behind the fifth rather than restarting the sequence.
    const base = (start + order) * step;

    // 1. Their window blooms.
    for (const win of all(root, markSelector(WINDOW_MARK, person.roomId))) {
      const animation = bloom(win, { delay: base });
      if (animation) animations.push(animation);
    }

    // 2. Their rim catches 120ms later — every LitAvatar drawn for them.
    const faces = all(root, markSelector(PERSON_MARK, person.userId));
    for (const face of faces) {
      const animation = bloom(rimOf(face), { delay: base + RIM_AFTER_ROOM_MS });
      if (animation) animations.push(animation);
    }

    // 3. And they spring into the strips — only the strips: a face already
    //    standing in a timeline row is not arriving anywhere.
    for (const face of faces) {
      if (!face.closest(`[${STRIP_MARK}]`)) continue;
      const animation = arriveIn(face, { delay: base + RIM_AFTER_ROOM_MS });
      if (animation) animations.push(animation);
    }

    // 4. The inline room event fades in last.
    for (const event of all(root, markSelector(EVENT_MARK, person.roomId))) {
      const animation = fadeIn(event, { delay: base + EVENT_AFTER_MS });
      if (animation) animations.push(animation);
    }
  });

  return animations;
}

/**
 * The mirror. `faces` are the elements as they were **before** the render took
 * them away — each is ghosted where it stood and slid out; pass none and only
 * the rim and the window play.
 */
export function playDepartures(
  people: readonly RoomPersonEvent[],
  options: {
    root?: ParentNode;
    ghosts?: ReadonlyMap<string, Element[]>;
    flip?: FlipCapture | null;
    startIndex?: number;
  } = {},
): Animation[] {
  if (typeof document === 'undefined' || prefersReducedMotion() || people.length === 0) return [];
  const root = options.root ?? document;
  const step = ms('--stagger-light');
  const start = options.startIndex ?? 0;
  const animations: Animation[] = [];

  people.forEach((person, order) => {
    const base = (start + order) * step;

    // The rim dims: 400ms, `--ease-in`. A face still on screen somewhere else
    // (a timeline row) keeps its own light; this is the one leaving a room.
    for (const face of all(root, markSelector(PERSON_MARK, person.userId))) {
      const animation = dim(rimOf(face));
      if (animation) animations.push(animation);
    }

    // The face slides out of the strip — as a ghost, because the real one is
    // already gone.
    for (const gone of options.ghosts?.get(person.userId) ?? []) {
      const animation = ghostOut(gone, (copy) => slideOut(copy, { delay: base }));
      if (animation) animations.push(animation);
    }

    // And the window cools, but only if the room actually went dark: a room
    // with three people still in it is still lit, and dimming it would say
    // something untrue (§0, every glow has a source).
    if (person.roomWentDark) {
      for (const win of all(root, markSelector(WINDOW_MARK, person.roomId))) {
        const animation = dim(win);
        if (animation) animations.push(animation);
      }
    }
  });

  // The gap the departure left closes on the same curve.
  if (options.flip) animations.push(...options.flip.play());

  return animations;
}

/** The faces on screen for these people right now, for the ghosts above. */
export function facesFor(
  people: readonly RoomPersonEvent[],
  root: ParentNode | Document = document,
): Map<string, Element[]> {
  const found = new Map<string, Element[]>();
  for (const person of people) {
    const faces = all(root as ParentNode, markSelector(PERSON_MARK, person.userId)).filter((face) =>
      face.closest(`[${STRIP_MARK}]`),
    );
    if (faces.length > 0) found.set(person.userId, faces);
  }
  return found;
}
