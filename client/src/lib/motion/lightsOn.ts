import { bloom, fadeIn, settleIn } from './animate';
import {
  LAMP_MARK,
  LIT_MARK,
  PERSON_MARK,
  PLATE_MARK,
  RIM_MARK,
  ROOM_MARK,
  WINDOW_MARK,
} from './marks';
import { prefersReducedMotion } from './reducedMotion';
import { ms } from './tokens';

/**
 * "Lights on" — the building waking up (docs/lantern-stage-spec.md §5.1,
 * study `output/design-reference/motion/MotionLightsOn.html`).
 *
 * One sequence, played over whatever is on screen when presence arrives:
 *
 *   plates settle from 8px below, 120ms apart, as the street first renders
 *   → each lit window blooms, `--stagger-light` after its neighbour
 *   → a plate's lamp fades in once its own first window is lit
 *   → a person's rim catches 120ms after the room they are in
 *
 * **Why the engine sweeps the DOM instead of each component animating itself.**
 * A building waking up is one event with one clock: the lamp has to know when
 * its first window lit, and a rim has to know when its room did. Spread across
 * `WindowMap`, `BuildingPlate` and `LitAvatar` that is three components sharing
 * a timeline through props, re-derived on every render — and WP9a's first
 * lesson was that a React re-render in the middle of a moment wipes it. Web
 * Animations are not React's to wipe, and the marks (`marks.ts`) are a
 * component's only contribution: *what* it is holding, never *when* it moves.
 *
 * `when` is decided somewhere else entirely — `lib/attention/lightsOn.ts` owns
 * the edge, so this never fires on a re-render, a route change or data that was
 * already there.
 */

/** §5.3: "the lights-on stagger (whole sequence ≤ 1.6s)". */
export const LIGHTS_ON_BUDGET_MS = 1_600;

/** A rim catches 120ms after the room it is in (§5.1, and the study). */
const RIM_AFTER_ROOM_MS = 120;
/** A plate's lamp fades in just behind its own first lit window. */
const LAMP_AFTER_WINDOW_MS = 60;

export interface LightsOnOptions {
  /** Where to look. Defaults to the document. */
  root?: ParentNode;
  /** Override the §5.3 ceiling (the gate uses the default). */
  budgetMs?: number;
  /**
   * The plates this sequence is for. Omit for every plate on screen.
   *
   * WP9d: a gateway coming back is not the app opening — only the buildings
   * that actually went dark have any lights to turn on, and a building served
   * by a connection that never dropped must not re-wake over the top of a
   * conversation somebody is reading. The connection director records the
   * plates it dimmed and hands exactly those back here.
   */
  plates?: readonly HTMLElement[];
  /**
   * Whether the street ARRIVES — plates settling from 8px below (§5.1).
   *
   * True when the building is being seen for the first time in this run. False
   * when the plates are already on screen and only their light changed: the
   * theme changing, or the power coming back. Moving a plate that never went
   * anywhere would say something untrue (§0).
   */
  settle?: boolean;
}

export interface LightsOnSequence {
  animations: Animation[];
  /** How many windows the sweep found lit. */
  windows: number;
  /** The stagger actually used — compressed when the map is large. */
  stepMs: number;
  /** When the last thing in the sequence finishes, from time zero. */
  endsAtMs: number;
}

const NOTHING: LightsOnSequence = { animations: [], windows: 0, stepMs: 0, endsAtMs: 0 };

/**
 * The gap between neighbouring lights, compressed so the WHOLE sequence still
 * lands inside the budget on a large map.
 *
 * The last thing to move is a rim: the street's settle, then its room's window
 * delay, then 120ms, then the 220ms bloom. Solving that for the delay of the
 * last window is the only honest way to keep §5.3 — capping the number of
 * windows instead would mean a big building's lights simply never came on.
 */
export function lightsOnStep(count: number, budgetMs = LIGHTS_ON_BUDGET_MS, reservedMs = 0): number {
  const preferred = ms('--stagger-light');
  if (count <= 1) return preferred;
  const tail = ms('--duration-warm-up') + RIM_AFTER_ROOM_MS;
  const room = Math.max(0, budgetMs - tail - reservedMs);
  return Math.max(1, Math.min(preferred, Math.floor(room / (count - 1))));
}

/** The plate stagger, compressed the same way. */
function plateStep(count: number, budgetMs: number): number {
  const preferred = ms('--duration-fast');
  if (count <= 1) return preferred;
  const room = Math.max(0, budgetMs - ms('--duration-slow'));
  return Math.max(1, Math.min(preferred, Math.floor(room / (count - 1))));
}

function closestPlate(el: Element): Element | null {
  return el.closest(`[${PLATE_MARK}]`);
}

/**
 * Play the sequence. Returns what it started, so a caller (and the gate) can
 * see the shape of it; under reduced motion it plays nothing at all, because
 * nothing here is hidden beforehand — every element is already at rest, and
 * "everything lands at once" is what not moving looks like.
 */
export function playLightsOn(options: LightsOnOptions = {}): LightsOnSequence {
  if (typeof document === 'undefined' || prefersReducedMotion()) return NOTHING;
  const root = options.root ?? document;
  const budget = options.budgetMs ?? LIGHTS_ON_BUDGET_MS;

  // The windows that are actually lit, in the order the building put them —
  // which is the order presence resolved them: `buildingLight` orders rooms
  // voice-first then by activity, and a room only has a window's worth of
  // light once its occupants or readers have arrived.
  const scoped = options.plates != null;
  const plates = scoped
    ? options.plates!.filter((plate) => plate.isConnected)
    : [...root.querySelectorAll<HTMLElement>(`[${PLATE_MARK}]`)];
  // A scoped sweep lights the windows inside its own plates, plus the ones that
  // belong to no plate at all (a row's 8px dot in a flat list) — never another
  // building's.
  const inScope = new Set<Element>(plates);
  const scopedTo = (el: Element) => {
    if (!scoped) return true;
    const plate = closestPlate(el);
    return plate == null || inScope.has(plate);
  };
  const windows = [...root.querySelectorAll<HTMLElement>(`[${WINDOW_MARK}][${LIT_MARK}]`)].filter(scopedTo);
  const rims = [...root.querySelectorAll<HTMLElement>(`[${PERSON_MARK}][${LIT_MARK}]`)];
  if (windows.length === 0 && plates.length === 0 && rims.length === 0) return NOTHING;

  const animations: Animation[] = [];
  let endsAt = 0;
  const ends = (delay: number, duration: number) => {
    endsAt = Math.max(endsAt, delay + duration);
  };

  // 1. The street arrives: plates settle from 8px below, 120ms apart. Not when
  //    the plates are already standing there and only their light changed.
  const settles = options.settle !== false;
  const pStep = plateStep(plates.length, budget);
  const plateDelay = new Map<Element, number>();
  plates.forEach((plate, index) => {
    const delay = settles ? index * pStep : 0;
    plateDelay.set(plate, delay);
    if (!settles) return;
    const animation = settleIn(plate, { delay });
    if (animation) animations.push(animation);
    ends(delay, ms('--duration-slow'));
  });

  // 2. The windows bloom — a window inside a plate waits for its plate to
  //    arrive, because a bloom inside something still fading in cannot be seen.
  const platesEndAt = settles && plates.length > 0 ? (plates.length - 1) * pStep + ms('--duration-fast') : 0;
  const step = lightsOnStep(windows.length, budget, platesEndAt);
  const firstWindowInPlate = new Map<Element, number>();
  const windowDelayByRoom = new Map<string, number>();
  windows.forEach((win, index) => {
    const plateOf = closestPlate(win);
    const base = (plateOf ? plateDelay.get(plateOf) : undefined) ?? 0;
    const delay = base + (settles ? ms('--duration-fast') : 0) + index * step;
    const animation = bloom(win, { delay });
    if (animation) animations.push(animation);
    ends(delay, ms('--duration-warm-up'));
    const room = win.getAttribute(WINDOW_MARK);
    // A room can own more than one window (the map cell and the 8px row dot):
    // the first one to bloom is the one a rim follows.
    if (room && !windowDelayByRoom.has(room)) windowDelayByRoom.set(room, delay);
    if (plateOf && !firstWindowInPlate.has(plateOf)) firstWindowInPlate.set(plateOf, delay);
  });

  // 3. A lamp fades in once the first window in its plate is lit.
  for (const lamp of [...root.querySelectorAll<HTMLElement>(`[${LAMP_MARK}]`)].filter(scopedTo)) {
    const plate = closestPlate(lamp);
    const after = (plate ? firstWindowInPlate.get(plate) : undefined) ?? 0;
    const delay = after + LAMP_AFTER_WINDOW_MS;
    const animation = fadeIn(lamp, { delay });
    if (animation) animations.push(animation);
    ends(delay, ms('--duration-slow'));
  }

  // 4. People's rims follow their room, 120ms behind it. A face whose room the
  //    surface did not name follows the last window rather than guessing at one.
  const lastWindowDelay = windows.length > 0
    ? platesEndAt + (windows.length - 1) * step
    : 0;
  for (const person of rims) {
    const room = person.getAttribute(ROOM_MARK);
    const after = (room != null ? windowDelayByRoom.get(room) : undefined) ?? lastWindowDelay;
    const delay = after + RIM_AFTER_ROOM_MS;
    const rim = person.querySelector<HTMLElement>(`[${RIM_MARK}]`) ?? person;
    const animation = bloom(rim, { delay });
    if (animation) animations.push(animation);
    ends(delay, ms('--duration-warm-up'));
  }

  return { animations, windows: windows.length, stepMs: step, endsAtMs: endsAt };
}

/**
 * The same sequence, minus the street arriving (WP9d).
 *
 * The lights changing — a theme swapped, or the power coming back after the
 * gateway was away — happens to a building that is already standing there. Its
 * windows, lamps and rims come back on exactly as they do when it wakes up;
 * its plates do not travel, because nothing moved them.
 */
export function playRelight(options: LightsOnOptions = {}): LightsOnSequence {
  return playLightsOn({ ...options, settle: false });
}
