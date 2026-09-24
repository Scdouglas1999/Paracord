import { playRelight } from './lightsOn';
import { PLATE_MARK } from './marks';
import { prefersReducedMotion } from './reducedMotion';
import { ms, motionToken, rawToken } from './tokens';

/**
 * The lights changing — the two moments that happen to the building itself
 * (docs/lantern-stage-spec.md §5.1, WP9d).
 *
 * Every other moment in this engine happens to something *in* the building: a
 * message, a person, a room. These two happen to the building:
 *
 *   **The theme changes.** Somebody moves the whole street from Night to
 *   Daylight. §5: "only light and the things people do animate" — and this is
 *   both at once, so it is the one time the base is allowed to cross over. It
 *   crosses over `--duration-dim`, and then the light elements re-bloom, so the
 *   windows and rims are the last thing to arrive in the new light rather than
 *   simply being repainted with everything else.
 *
 *   **The power goes.** The gateway is away, so nothing on screen is answerable
 *   for any more: the whole building dims 30% and holds there until it is back.
 *   §5.1's "lights on" then replays over exactly the plates that went dark.
 *
 * Both are the same physical idea and share one mechanism — a scrim the engine
 * owns outright, animated on opacity alone.
 *
 * **Why a scrim and not the shell's own opacity.** Dimming `#root` would put an
 * opacity on an ancestor of every dialog, popover and toast in the app, and an
 * element with opacity is a containing block for `position: fixed` descendants:
 * the reconnect would visibly move furniture. The scrim is one fixed rectangle
 * that nothing is inside of, it is `pointer-events: none` so you can keep
 * typing through an outage, and it is DOM no React render can wipe (WP9a's
 * first lesson).
 */

const SCRIM_ID = 'pc-motion-lights';

/**
 * Above everything, including the connection banner: the lights going down are
 * the lights going down. It cannot swallow a click — nothing here is
 * interactive and the layer never takes pointer events.
 */
const SCRIM_Z = 'var(--z-motion-lights, 9500)';

/** §5.1, and the brief: an outage takes the building to 70% of its light. */
export const OUTAGE_DIM = 0.3;

function scrim(): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const existing = document.getElementById(SCRIM_ID);
  if (existing) return existing;
  const layer = document.createElement('div');
  layer.id = SCRIM_ID;
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText =
    `position:fixed;inset:0;pointer-events:none;opacity:0;z-index:${SCRIM_Z};`
    // One flat rectangle whose only property will ever be opacity. Saying so
    // hands the whole thing to the compositor instead of repainting the
    // viewport every frame on a machine with no GPU.
    + 'will-change:opacity;contain:strict;';
  document.body.append(layer);
  return layer;
}

/** The street's own color, right now — read, never invented (§0). */
function ground(): string {
  const value = rawToken('--bg-base');
  return value || 'transparent';
}

function play(
  el: HTMLElement,
  id: string,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (typeof el.animate !== 'function') return null;
  const animation = el.animate(keyframes, options);
  animation.id = `data-motion-recipe:${id}`;
  return animation;
}

/** One macrotask — never a frame inside a View Transition (WP9a's hang). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait until the change has actually reached the DOM.
 *
 * A theme is applied by a React effect two ticks after the store is written, so
 * "swap it inside the update callback" is a promise the caller cannot keep on
 * its own. Bounded: a change that never lands must not hold the transition (or
 * the page's rendering, on the View Transitions path) open.
 */
const APPLY_WAIT_MS = 400;

async function waitApplied(applied: (() => boolean) | undefined): Promise<void> {
  await nextTask();
  if (!applied) return;
  const deadline = Date.now() + APPLY_WAIT_MS;
  while (!applied() && Date.now() < deadline) await nextTask();
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => {
    finished: Promise<void>;
    ready: Promise<void>;
  };
};

/* -------------------------------------------------------------------------- */
/* The theme changes                                                          */
/* -------------------------------------------------------------------------- */

export type LightsChangeEngine = 'view-transition' | 'crossfade' | 'none';

export interface LightsChangeResult {
  /** Which engine carried the base over. The demo and the gate assert on it. */
  engine: LightsChangeEngine;
  /** Everything the moment started, including the relight. */
  animations: Animation[];
}

export interface LightsChangeOptions {
  /** Polled until the change has reached the DOM (see `waitApplied`). */
  applied?: () => boolean;
  /** Override `--duration-dim`. */
  duration?: number;
  /** Force one engine. `/design-tokens` offers both so they can be compared. */
  engine?: 'auto' | 'crossfade' | 'view-transition';
  /** Where the lights that re-bloom are looked for. Defaults to the document. */
  root?: ParentNode;
  /** Skip the relight (the gate measures the crossfade on its own). */
  relight?: boolean;
}

/**
 * Run `apply` and cross the whole shell over to what it did (§5.1).
 *
 * Two engines, one shape — the base crosses over `--duration-dim` and the light
 * elements re-bloom behind it:
 *
 *   - **View Transitions**, where the webview has them: the browser holds a
 *     snapshot of the old building and crosses it with the new one, so what you
 *     see is genuinely the old theme fading into the new one.
 *   - **The crossfade**, everywhere else: there is no snapshot to cross with,
 *     so the lights go down to the street's own color and come back up in the
 *     new one. A dip, over the same 400ms, on the same two curves.
 *
 * Under reduced motion the change simply happens. §5.3: "everything lands
 * instantly".
 */
export async function changeLights(
  apply: () => void,
  options: LightsChangeOptions = {},
): Promise<LightsChangeResult> {
  if (typeof document === 'undefined' || prefersReducedMotion()) {
    apply();
    return { engine: 'none', animations: [] };
  }

  const duration = options.duration ?? ms('--duration-dim');
  const doc = document as ViewTransitionDocument;
  const root = document.documentElement;
  const useTransition =
    options.engine !== 'crossfade' && typeof doc.startViewTransition === 'function';

  root.setAttribute('data-motion-transition', 'lights-change');
  const unstamp = () => root.removeAttribute('data-motion-transition');

  if (useTransition) {
    const transition = doc.startViewTransition!(async () => {
      apply();
      await waitApplied(options.applied);
    });
    // Both of these reject in ordinary use (WP9b §7.1): the browser skips a
    // transition whenever a second starts over it or the document goes away,
    // and a skipped transition means the theme changed and the crossfade did
    // not — which is the right degradation, not an error anybody needs to hear.
    const ready = await transition.ready.then(
      () => true,
      () => false,
    );
    if (ready) await transition.finished.catch(() => {});
    unstamp();
    return { engine: 'view-transition', animations: relight(options) };
  }

  const layer = scrim();
  if (!layer) {
    apply();
    unstamp();
    return { engine: 'none', animations: [] };
  }
  layer.style.background = ground();
  const half = Math.round(duration / 2);

  // Down on `--ease-in`, like every other light going out.
  const out = play(layer, 'lights-out', [{ opacity: 0 }, { opacity: 1 }], {
    duration: half,
    easing: motionToken('--ease-in'),
    fill: 'forwards',
  });
  await (out?.finished.catch(() => {}) ?? nextTask());

  apply();
  await waitApplied(options.applied);
  // The ground is the new theme's now, so the dip does not end on a color that
  // is no longer anywhere on screen.
  layer.style.background = ground();

  const back = play(layer, 'lights-in', [{ opacity: 1 }, { opacity: 0 }], {
    duration: half,
    easing: motionToken('--ease-out'),
    fill: 'forwards',
  });
  await (back?.finished.catch(() => {}) ?? nextTask());
  layer.remove();
  unstamp();
  return { engine: 'crossfade', animations: relight(options) };
}

/** The windows, lamps and rims coming back on in the new light. */
function relight(options: LightsChangeOptions): Animation[] {
  if (options.relight === false) return [];
  return playRelight({ root: options.root }).animations;
}

/* -------------------------------------------------------------------------- */
/* The power goes                                                             */
/* -------------------------------------------------------------------------- */

/** The plates that were on screen when the lights went down. */
let dimmedPlates: HTMLElement[] = [];
let dimming: Animation | null = null;

export interface OutageResult {
  animations: Animation[];
  /** How many plates the outage was over — the ones that relight. */
  plates: number;
}

/**
 * The gateway is away: the whole building dims 30% and stays there (§5.1's
 * dim — it lingers a beat, then goes, `--duration-dim` on `--ease-in`).
 *
 * It is deliberately not a spinner, and deliberately not a modal: the app is
 * still yours while it is dark. The plates under the scrim are recorded here,
 * because they are the ones "lights on" replays for when the power comes back —
 * a building served by a connection that never dropped has nothing to turn on.
 */
export function dimBuilding(root: ParentNode = document): OutageResult {
  if (typeof document === 'undefined' || prefersReducedMotion()) return { animations: [], plates: 0 };
  const layer = scrim();
  if (!layer) return { animations: [], plates: 0 };
  dimmedPlates = [...root.querySelectorAll<HTMLElement>(`[${PLATE_MARK}]`)];
  layer.style.background = ground();
  dimming?.cancel();
  dimming = play(layer, 'outage-dim', [{ opacity: 0 }, { opacity: OUTAGE_DIM }], {
    duration: ms('--duration-dim'),
    easing: motionToken('--ease-in'),
    fill: 'forwards',
  });
  return { animations: dimming ? [dimming] : [], plates: dimmedPlates.length };
}

/**
 * The power is back: the scrim lifts on `--ease-out`.
 *
 * It does NOT turn the lights on. A gateway coming back is already §5.1's
 * second "lights on" trigger, and that path waits for presence to actually be
 * re-delivered before it sweeps — firing here would light the building up over
 * the stale picture that is still on screen, which is the exact mistake
 * `lib/attention/lightsOn.ts` exists to prevent. What the outage owns is the
 * SCOPE: `takeDimmedPlates` hands the sweep the plates that were dark, so a
 * building whose connection never dropped is left alone.
 */
export async function relightBuilding(): Promise<OutageResult> {
  const layer = typeof document === 'undefined' ? null : document.getElementById(SCRIM_ID);
  const plates = dimmedPlates.filter((plate) => plate.isConnected).length;
  if (!layer) return { animations: [], plates };
  dimming?.cancel();
  dimming = null;
  const back = play(layer, 'outage-relight', [{ opacity: OUTAGE_DIM }, { opacity: 0 }], {
    duration: ms('--duration-dim'),
    easing: motionToken('--ease-out'),
    fill: 'forwards',
  });
  await (back?.finished.catch(() => {}) ?? nextTask());
  layer.remove();
  return { animations: back ? [back] : [], plates };
}

/**
 * The plates that were under the scrim, handed over once.
 *
 * Empty when no outage dimmed anything — a reconnect too short to notice is not
 * a building that went dark, and the lights-on sweep then does what it has
 * always done, over the whole street.
 */
export function takeDimmedPlates(): HTMLElement[] {
  const plates = dimmedPlates.filter((plate) => plate.isConnected);
  dimmedPlates = [];
  return plates;
}

/** Is the building dark right now? The gate and the demo both ask. */
export function buildingIsDim(): boolean {
  return typeof document !== 'undefined' && document.getElementById(SCRIM_ID) !== null;
}

/** For tests, and for a session teardown: no scrim outlives its outage. */
export function clearLightsForTests(): void {
  dimming?.cancel();
  dimming = null;
  dimmedPlates = [];
  if (typeof document !== 'undefined') document.getElementById(SCRIM_ID)?.remove();
}
