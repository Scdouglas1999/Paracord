import { prefersReducedMotion } from './reducedMotion';
import { springEasing, springTokens } from './spring';
import { ms } from './tokens';

/**
 * "The thing you click becomes the thing you look at" (§5.1).
 *
 * Navigating into a room, a thread, a settings section or a dialog moves ONE
 * shared element from where it was to where it will be, and the chrome that
 * supports it rises 80ms later, staggered. Two engines, one choreography:
 *
 *   - **View Transitions** where the webview has `document.startViewTransition`
 *     (Chromium ≥ 111, WebKit ≥ 18): each participant is given a
 *     `view-transition-name` for the length of the transition and the browser
 *     tweens it, driven by the same `--duration-move` and spring easing.
 *   - **FLIP** everywhere else: measure before, let the update run, measure
 *     after, and play the delta back with Web Animations on transform only.
 *
 * Participants opt in by marking the element on BOTH sides of the update:
 *
 *     <div data-motion-shared="room:2001">…
 *
 * Supporting chrome opts in with `data-motion-chrome`. Under reduced motion the
 * update simply runs.
 */

/**
 * The View Transitions API is typed in lib.dom but not present on every webview
 * we ship to, so the call site asks the object, not the type.
 */
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void>; ready: Promise<void> };
};

export interface SharedTransitionOptions {
  /** The `data-motion-shared` names taking part. Omit for every marked element. */
  names?: readonly string[];
  /** The root to search. Defaults to the document. */
  root?: ParentNode;
  /** Override `--duration-move`. */
  duration?: number;
  /** Animate `[data-motion-chrome]` in after the shared element. Default true. */
  chrome?: boolean;
  /** Force the FLIP path (the demo on /design-tokens shows both). */
  engine?: 'auto' | 'flip' | 'view-transition';
}

const SHARED_ATTR = 'data-motion-shared';
const CHROME_ATTR = 'data-motion-chrome';

function selectorFor(names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return `[${SHARED_ATTR}]`;
  return names.map((name) => `[${SHARED_ATTR}="${CSS.escape(name)}"]`).join(',');
}

function collect(root: ParentNode, names: readonly string[] | undefined): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>(selectorFor(names))) {
    const name = el.getAttribute(SHARED_ATTR);
    // First wins: a name is meant to identify ONE thing on each side.
    if (name && !found.has(name)) found.set(name, el);
  }
  return found;
}

/** One frame, so the browser has laid the updated DOM out before we measure. */
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * The same wait, for inside a View Transition's update callback — where it must
 * NOT be a frame.
 *
 * The browser suspends rendering for the length of that callback, so a
 * `requestAnimationFrame` in there never fires and the transition hangs
 * forever, taking the page's rendering down with it. A macrotask is enough:
 * React has flushed the update by the time it runs, and `getBoundingClientRect`
 * forces whatever layout we need.
 */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The chrome rise: 80ms after the move, 30ms apart, 14px (§5.1). */
function riseChrome(root: ParentNode, duration: number): Animation[] {
  const base = ms('--stagger-chrome');
  const step = ms('--stagger-light');
  const easing = springEasing(springTokens(), { durationMs: duration });
  const animations: Animation[] = [];
  [...root.querySelectorAll<HTMLElement>(`[${CHROME_ATTR}]`)].forEach((el, index) => {
    if (typeof el.animate !== 'function') return;
    animations.push(
      el.animate(
        [
          { transform: 'translate3d(0, 10px, 0)', opacity: 0 },
          { transform: 'translate3d(0, 0, 0)', opacity: 1 },
        ],
        { duration, delay: base + index * step, easing, fill: 'backwards' },
      ),
    );
  });
  return animations;
}

export interface SharedTransitionResult {
  /** Which engine actually ran — the demo and the gate both assert on this. */
  engine: 'view-transition' | 'flip' | 'none';
  /** Every animation the move started, so a caller can cancel them. */
  animations: Animation[];
}

/**
 * Run `update` and move the marked elements from where they were to where they
 * end up.
 */
export async function transitionWith(
  update: () => void | Promise<void>,
  options: SharedTransitionOptions = {},
): Promise<SharedTransitionResult> {
  const root = options.root ?? (typeof document !== 'undefined' ? document : null);
  if (!root || prefersReducedMotion()) {
    await update();
    return { engine: 'none', animations: [] };
  }

  const duration = options.duration ?? ms('--duration-move');
  const doc = document as ViewTransitionDocument;
  const engine =
    options.engine === 'flip'
      ? 'flip'
      : options.engine === 'view-transition' || typeof doc.startViewTransition === 'function'
        ? 'view-transition'
        : 'flip';

  if (engine === 'view-transition' && typeof doc.startViewTransition === 'function') {
    const before = collect(root, options.names);
    for (const [name, el] of before) el.style.viewTransitionName = `pc-${name.replace(/[^\w-]/g, '-')}`;
    const transition = doc.startViewTransition(async () => {
      await update();
      await nextTask();
      const after = collect(root, options.names);
      for (const [name, el] of after) el.style.viewTransitionName = `pc-${name.replace(/[^\w-]/g, '-')}`;
    });
    const animations = options.chrome === false ? [] : await transition.ready.then(() => riseChrome(root, duration));
    await transition.finished.catch(() => {});
    for (const el of root.querySelectorAll<HTMLElement>(`[${SHARED_ATTR}]`)) el.style.viewTransitionName = '';
    return { engine: 'view-transition', animations };
  }

  // FLIP: first, last, invert, play — on transform alone, so nothing reflows.
  const first = new Map<string, DOMRect>();
  for (const [name, el] of collect(root, options.names)) first.set(name, el.getBoundingClientRect());

  await update();
  await nextFrame();

  const easing = springEasing(springTokens(), { durationMs: duration });
  const animations: Animation[] = [];
  for (const [name, el] of collect(root, options.names)) {
    const from = first.get(name);
    if (!from || typeof el.animate !== 'function') continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = to.width > 0 ? from.width / to.width : 1;
    const sy = to.height > 0 ? from.height / to.height : 1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    animations.push(
      el.animate(
        [
          { transformOrigin: 'top left', transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
          { transformOrigin: 'top left', transform: 'translate3d(0, 0, 0) scale(1, 1)' },
        ],
        { duration, easing, fill: 'none' },
      ),
    );
  }
  if (options.chrome !== false) animations.push(...riseChrome(root, duration));
  return { engine: 'flip', animations };
}
