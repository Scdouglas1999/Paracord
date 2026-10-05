import { prefersReducedMotion } from './reducedMotion';
import { ms, motionToken, rawToken } from './tokens';

/**
 * The theme changes (docs/lantern-stage-spec.md §5.1, WP9d).
 *
 * Somebody moves the whole app from one theme to the other (Glass and High
 * contrast). §5: the base is allowed to cross over, and it crosses over
 * `--duration-dim`. This is a scrim the engine owns outright, animated on
 * opacity alone.
 *
 * **Why a scrim and not the shell's own opacity.** Dimming `#root` would put an
 * opacity on an ancestor of every dialog, popover and toast in the app, and an
 * element with opacity is a containing block for `position: fixed` descendants:
 * the change would visibly move furniture. The scrim is one fixed rectangle
 * that nothing is inside of, it is `pointer-events: none`, and it is DOM no
 * React render can wipe (WP9a's first lesson).
 */

const SCRIM_ID = 'pc-motion-lights';

/**
 * Above everything, including the connection banner: the lights going down are
 * the lights going down. It cannot swallow a click — nothing here is
 * interactive and the layer never takes pointer events.
 */
const SCRIM_Z = 'var(--z-motion-lights, 9500)';

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
}

export interface LightsChangeOptions {
  /** Polled until the change has reached the DOM (see `waitApplied`). */
  applied?: () => boolean;
  /** Override `--duration-dim`. */
  duration?: number;
  /** Force one engine. `/design-tokens` offers both so they can be compared. */
  engine?: 'auto' | 'crossfade' | 'view-transition';
}

/**
 * Run `apply` and cross the whole shell over to what it did (§5.1).
 *
 * Two engines, one shape — the base crosses over `--duration-dim`:
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
    return { engine: 'none' };
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
    return { engine: 'view-transition' };
  }

  const layer = scrim();
  if (!layer) {
    apply();
    unstamp();
    return { engine: 'none' };
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
  return { engine: 'crossfade' };
}
