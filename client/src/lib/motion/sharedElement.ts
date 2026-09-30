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
  /**
   * The element the gesture started on, when more than one thing on screen
   * carries the same name.
   *
   * A room's name is on its Lobby card, on its sidebar row and on the inline
   * "lit up" event at the same time — all three are the same room. Without
   * this, "first in the document wins" makes the sidebar the origin of every
   * journey, and a card you clicked in the middle of the Lobby appears to fly
   * out of the sidebar. The caller knows which one was clicked; nothing else
   * can.
   */
  origin?: Element | null;
  /**
   * Where the journey is GOING, as a selector — the same problem as `origin`,
   * at the other end.
   *
   * A room's name is on its sidebar row as well as on the Stage, and after the
   * update both are in the document, so "first in the document wins" made the
   * card you clicked fly into the sidebar instead of into the room. The frame
   * strip showed it; nothing else would have. Walking into a room lands in the
   * main content area, so that is what the caller names.
   */
  destinationRoot?: string;
  /**
   * What kind of journey this is, stamped on `<html>` as
   * `data-motion-transition` for the length of it. Both engines read it: the
   * FLIP path through `beforeUpdate`, the View Transitions path through CSS
   * (`primitives.css`), which is how "the rest of the Lobby recedes" is the
   * same motion on both.
   */
  kind?: string;
  /** Runs before the update, told which engine is about to carry it. */
  beforeUpdate?: (engine: 'view-transition' | 'flip') => void;
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

function collect(
  root: ParentNode,
  names: readonly string[] | undefined,
  origin?: Element | null,
  /**
   * Never the destination.
   *
   * The route change does not take the old surface out of the document on the
   * frame it happens — React unmounts it a tick later — so an "after" pass that
   * accepted the element it had just left found the card still sitting where it
   * was, measured a delta of zero, and played nothing at all. A journey's
   * destination is never its origin.
   */
  exclude?: Element | null,
): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  // The origin is put in first, so it wins its own name.
  if (origin instanceof HTMLElement && origin.isConnected) {
    const name = origin.getAttribute(SHARED_ATTR);
    if (name && (!names || names.includes(name))) found.set(name, origin);
  }
  for (const el of root.querySelectorAll<HTMLElement>(selectorFor(names))) {
    if (exclude && el === exclude) continue;
    const name = el.getAttribute(SHARED_ATTR);
    // First wins: a name is meant to identify ONE thing on each side.
    if (name && !found.has(name)) found.set(name, el);
  }
  return found;
}

/** Stamp the journey on `<html>` so CSS can dress it, and hand back the undo. */
function stampKind(kind: string | undefined): () => void {
  if (!kind || typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  root.setAttribute('data-motion-transition', kind);
  return () => root.removeAttribute('data-motion-transition');
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

/**
 * How long a journey will wait for the place it is going to.
 *
 * Every room, thread and settings surface is behind a lazy route chunk and a
 * React render, so the destination is not in the document on the frame the
 * route changed — and a shared element with nothing to arrive at is a page that
 * goes blank and then fills in. Waiting is what makes it a journey: on the View
 * Transitions path the browser is still holding the old frame while we do it,
 * so the room you left stays on screen until the room you are entering is ready
 * to be looked at.
 *
 * Bounded, because a destination that never comes must not hang the page: the
 * transition then plays with whatever is there, which is the same fade the
 * route change would have had on its own.
 */
const DESTINATION_WAIT_MS = 700;

/** Where a journey's destination is looked for. */
function destinationOf(root: ParentNode, selector: string | undefined): ParentNode {
  if (!selector || typeof document === 'undefined') return root;
  return document.querySelector(selector) ?? root;
}

/** Poll (in macrotasks — see `nextTask`) until every name has landed. */
async function waitForDestination(
  root: ParentNode,
  names: readonly string[] | undefined,
  exclude: Element | null | undefined,
  /**
   * How to wait between looks. Inside a View Transition it MUST be a macrotask
   * (rendering is suspended, so a frame never comes — WP9a's hang); outside one
   * it must be a frame, because polling on a macrotask while the route's chunk
   * mounts starves the very frame the travel is about to start on.
   */
  wait: () => Promise<void>,
): Promise<void> {
  if (!names || names.length === 0) return;
  const deadline = Date.now() + DESTINATION_WAIT_MS;
  while (Date.now() < deadline) {
    const found = collect(root, names, null, exclude);
    if (names.every((name) => found.has(name))) return;
    await wait();
  }
}

/** The chrome rise: 80ms after the move, 30ms apart, 6px (§5.1). */
function riseChrome(root: ParentNode, duration: number): Animation[] {
  const base = ms('--stagger-chrome');
  const step = ms('--stagger-light');
  const easing = springEasing(springTokens(), { durationMs: duration });
  const animations: Animation[] = [];
  [...root.querySelectorAll<HTMLElement>(`[${CHROME_ATTR}]`)].forEach((el, index) => {
    if (typeof el.animate !== 'function') return;
    const animation = el.animate(
      [
        { transform: 'translate3d(0, 6px, 0)', opacity: 0 },
        { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      ],
      { duration, delay: base + index * step, easing, fill: 'backwards' },
    );
    // Named, so the frame gate can say WHICH recipe owned a frame it did not
    // like rather than reporting "anonymous".
    animation.id = 'data-motion-recipe:chrome';
    animations.push(animation);
  });
  return animations;
}

/**
 * The chrome rises when the chrome exists.
 *
 * Every room, thread and settings surface in this app is behind a lazy route
 * chunk, so the destination's header, tile strip and control bar are not in the
 * document on the frame the route changes — they arrive when React has
 * rendered the chunk. Rising "80ms after the move" over an empty document
 * animates nothing at all, which is how WP9b's first gate run found this.
 *
 * So the rise waits for its subject, and gives up rather than firing late into
 * a surface that never had any: a journey to somewhere with no chrome is a
 * journey with no chrome rise, not a stalled promise.
 */
const CHROME_WAIT_MS = 600;

async function risingChrome(root: ParentNode, duration: number): Promise<Animation[]> {
  const deadline = Date.now() + CHROME_WAIT_MS;
  while (root.querySelector(`[${CHROME_ATTR}]`) === null) {
    if (Date.now() >= deadline) return [];
    await nextFrame();
  }
  return riseChrome(root, duration);
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

  const unstamp = stampKind(options.kind);

  if (engine === 'view-transition' && typeof doc.startViewTransition === 'function') {
    const before = collect(root, options.names, options.origin);
    for (const [name, el] of before) el.style.viewTransitionName = `pc-${name.replace(/[^\w-]/g, '-')}`;
    options.beforeUpdate?.('view-transition');
    const transition = doc.startViewTransition(async () => {
      await update();
      await nextTask();
      const into = destinationOf(root, options.destinationRoot);
      await waitForDestination(into, options.names, options.origin, nextTask);
      const after = collect(into, options.names, null, options.origin);
      for (const [name, el] of after) el.style.viewTransitionName = `pc-${name.replace(/[^\w-]/g, '-')}`;
    });
    // **Both of these promises reject in ordinary use**, and neither rejection
    // is an error the person needs to hear about. `ready` rejects whenever the
    // browser skips the transition — a second one starting on top of this one,
    // the tab going to the background, the document being torn down — with
    // "Transition was aborted because of invalid state"; before this was
    // handled it escaped as an unhandled rejection and the app turned it into
    // an error toast on top of the room you had just walked into. A skipped
    // transition means the update still happened and the travel did not, which
    // is the correct degradation, so the chrome simply rises without it.
    const ready = await transition.ready.then(
      () => true,
      () => false,
    );
    const animations = options.chrome === false ? [] : await risingChrome(root, duration);
    if (ready) await transition.finished.catch(() => {});
    for (const el of root.querySelectorAll<HTMLElement>(`[${SHARED_ATTR}]`)) el.style.viewTransitionName = '';
    unstamp();
    return { engine: 'view-transition', animations };
  }

  // FLIP: first, last, invert, play — on transform alone, so nothing reflows.
  const first = new Map<string, DOMRect>();
  for (const [name, el] of collect(root, options.names, options.origin)) {
    first.set(name, el.getBoundingClientRect());
  }

  options.beforeUpdate?.('flip');
  await update();
  await nextFrame();
  const into = destinationOf(root, options.destinationRoot);
  await waitForDestination(into, options.names, options.origin, nextFrame);

  const easing = springEasing(springTokens(), { durationMs: duration });
  const animations: Animation[] = [];
  for (const [name, el] of collect(into, options.names, null, options.origin)) {
    const from = first.get(name);
    if (!from || typeof el.animate !== 'function') continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = to.width > 0 ? from.width / to.width : 1;
    const sy = to.height > 0 ? from.height / to.height : 1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    const animation = el.animate(
      [
        { transformOrigin: 'top left', transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
        { transformOrigin: 'top left', transform: 'translate3d(0, 0, 0) scale(1, 1)' },
      ],
      { duration, easing, fill: 'none' },
    );
    animation.id = 'data-motion-recipe:shared';
    animations.push(animation);
  }
  if (options.chrome !== false) animations.push(...(await risingChrome(root, duration)));
  // The stamp outlives the last animation it dresses, not the call.
  window.setTimeout(unstamp, duration + ms('--stagger-chrome') + ms('--duration-move'));
  return { engine: 'flip', animations };
}

/* =============================================================================
   Morph: one layout move of nested boxes (docs/glass-spec.md §6, §9; WP-G15).

   The Glass layout changes (the pill growing into the stage, side by side <->
   theater, browsing) move whole panes, and a pane's content must not stretch
   while its box does. `transitionWith` above moves ONE named element; a morph
   moves a small tree of them in one timeline:

     box    a pane or the pill: scaled from its first box to its last, its corner
            radius riding the same curve (counter-scaled, so the corners stay
            round instead of squashing). Its `overflow: hidden` clips what it
            holds, which is what makes a box that grows look like it opens.
     fit    the stream: a uniform scale that carries its picture (16:9 inside
            the box) from where it was to where it is, so video never stretches.
     rigid  chrome that keeps its size: moved from its first center to its last,
            counter-scaled against every moving ancestor.
     ride   content inside a moving box that keeps its size and rides one of the
            box's corners (a pane's column riding its right edge, say).

   Every item's transform is computed from its ancestors' transforms at the same
   moment, so nesting cancels exactly. The easing is baked into the keyframes
   (`MORPH_SAMPLES` of them, linear between), because a counter-scale is the
   inverse of a scale at each instant, and two animations with the same easing
   curve are only inverse at their ends.

   Only `transform`, `opacity` and `border-radius` move (the motion lint); the
   radius only on boxes whose corners change, and the caller takes the heavy
   shadows off those boxes for the length of the move (a shadow repainted per
   frame is the WebKitGTK cost glass-plan §6 warns about).

   One engine on every platform: this is Web Animations on transform, not the
   View Transitions API. See docs/design/glass-g15-checkpoint.md ("Why not View
   Transitions") for why; WebKitGTK 2.52 has the API, it is not missing.
   ============================================================================= */

export interface MorphBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type MorphKind = 'box' | 'fit' | 'rigid' | 'ride';

/** An opacity ramp over part of the move (fractions of its duration). */
export interface MorphFade {
  from: number;
  to: number;
  /** Where the ramp starts, 0..1 of the duration. Default 0. */
  start?: number;
  /** Where it ends, 0..1 of the duration. Default 1. */
  end?: number;
}

export interface MorphItem {
  el: HTMLElement;
  kind: MorphKind;
  /** The element's untransformed box as laid out now, in viewport px. */
  layout: MorphBox;
  /**
   * Where it is seen at the start and the end. `box`: the whole box. `fit`: the
   * picture. `rigid`: only the centers count (it keeps its layout size).
   * `ride` ignores both. Each defaults to `layout` (or `picture` for `fit`).
   */
  from?: MorphBox;
  to?: MorphBox;
  /** `fit`: the picture's box inside `layout`, in the same viewport px. */
  picture?: MorphBox;
  /** The nearest moving ancestor; this item's transform compensates for it. */
  parent?: MorphItem;
  /** `ride`: the point of the parent's box it keeps its distance to: [0,0] top left, [1,0] top right. */
  anchor?: readonly [number, number];
  /**
   * `rigid`: which point of it travels from `from` to `to` ([0,0] its top left,
   * [1,0] its top right). Default [0.5, 0.5], its center. It matters when it is
   * not the same size at both ends (a group that gained a button).
   */
  align?: readonly [number, number];
  /** The corner radius it is SEEN with at the start and the end (`box`, `fit`), px. */
  radius?: { from: number; to: number };
  fade?: MorphFade;
  /** Names the animation (`glass-morph:<name>`), for tests and the frame gate. */
  name?: string;
}

export interface MorphOptions {
  duration: number;
  /** Progress along the move for a time fraction, 0..1 -> 0..1 (it may overshoot). */
  easing: (t: number) => number;
  /** Keyframes per item. Default MORPH_SAMPLES. */
  samples?: number;
}

export const MORPH_SAMPLES = 24;

/** The Glass layout curve, `--glass-spring: cubic-bezier(0.2, 0.8, 0.2, 1)` (tokens.css). */
export const GLASS_LAYOUT_CURVE = [0.2, 0.8, 0.2, 1] as const;

/**
 * A CSS `cubic-bezier(x1, y1, x2, y2)` as a function of time: Newton's method on
 * x(u) = t, bisection when the slope is too flat to trust.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (t: number): number => {
    let u = t;
    for (let i = 0; i < 8; i += 1) {
      const error = x(u) - t;
      if (Math.abs(error) < 1e-6) return u;
      const slope = dx(u);
      if (Math.abs(slope) < 1e-6) break;
      u -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 40; i += 1) {
      const value = x(u);
      if (Math.abs(value - t) < 1e-6) return u;
      if (value < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return y(solve(t));
  };
}

interface Affine {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const IDENTITY: Affine = { ax: 1, ay: 1, bx: 0, by: 0 };

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function lerpBox(a: MorphBox, b: MorphBox, p: number): MorphBox {
  return {
    left: lerp(a.left, b.left, p),
    top: lerp(a.top, b.top, p),
    width: lerp(a.width, b.width, p),
    height: lerp(a.height, b.height, p),
  };
}

/** A fade's value at time fraction `t`, eased in and out over its window. */
export function fadeAt(fade: MorphFade, t: number): number {
  const start = fade.start ?? 0;
  const end = fade.end ?? 1;
  if (t <= start) return fade.from;
  if (t >= end || end <= start) return fade.to;
  const x = (t - start) / (end - start);
  const smooth = x * x * (3 - 2 * x);
  return lerp(fade.from, fade.to, smooth);
}

/** One item at one moment: its own transform and the net map from layout to screen it leaves its children. */
interface Solved {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  net: Affine;
}

function solveAt(item: MorphItem, p: number, parentNet: Affine): Solved {
  const L = item.layout;
  const P = parentNet;
  let desiredX = 1;
  let desiredY = 1;
  // A point of the item's layout, and where on screen it must be now.
  let refX = L.left;
  let refY = L.top;
  let toX = L.left;
  let toY = L.top;
  switch (item.kind) {
    case 'box': {
      const box = lerpBox(item.from ?? L, item.to ?? L, p);
      desiredX = L.width > 0 ? box.width / L.width : 1;
      desiredY = L.height > 0 ? box.height / L.height : 1;
      toX = box.left;
      toY = box.top;
      break;
    }
    case 'fit': {
      const picture = item.picture ?? L;
      const box = lerpBox(item.from ?? picture, item.to ?? picture, p);
      const scale = picture.width > 0 ? box.width / picture.width : 1;
      desiredX = scale;
      desiredY = scale;
      refX = picture.left;
      refY = picture.top;
      toX = box.left;
      toY = box.top;
      break;
    }
    case 'rigid': {
      const from = item.from ?? L;
      const to = item.to ?? L;
      const [ax, ay] = item.align ?? [0.5, 0.5];
      const pointX = lerp(from.left + ax * from.width, to.left + ax * to.width, p);
      const pointY = lerp(from.top + ay * from.height, to.top + ay * to.height, p);
      toX = pointX - ax * L.width;
      toY = pointY - ay * L.height;
      break;
    }
    case 'ride': {
      const parent = item.parent;
      if (parent) {
        const [fx, fy] = item.anchor ?? [0, 0];
        const PL = parent.layout;
        // The parent's box as seen now.
        const seenLeft = P.ax * PL.left + P.bx;
        const seenTop = P.ay * PL.top + P.by;
        const anchorX = seenLeft + fx * P.ax * PL.width;
        const anchorY = seenTop + fy * P.ay * PL.height;
        toX = anchorX + (L.left - (PL.left + fx * PL.width));
        toY = anchorY + (L.top - (PL.top + fy * PL.height));
      }
      break;
    }
  }
  const kx = desiredX / P.ax;
  const ky = desiredY / P.ay;
  // X(x) = L.tl + k(x - L.tl) + t, and the parent's map of X(ref) must land on (toX, toY).
  const translateX = (toX - P.bx) / P.ax - L.left - kx * (refX - L.left);
  const translateY = (toY - P.by) / P.ay - L.top - ky * (refY - L.top);
  const net: Affine = {
    ax: P.ax * kx,
    ay: P.ay * ky,
    bx: P.ax * (L.left - kx * L.left + translateX) + P.bx,
    by: P.ay * (L.top - ky * L.top + translateY) + P.by,
  };
  return { translateX, translateY, scaleX: kx, scaleY: ky, net };
}

const round = (value: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/**
 * The keyframes of every item (pure; the math, testable without a DOM). An item
 * whose every frame is at rest and fully opaque gets none.
 */
export function morphFrames(items: readonly MorphItem[], options: MorphOptions): Map<MorphItem, Keyframe[]> {
  const samples = Math.max(2, options.samples ?? MORPH_SAMPLES);
  const frames = new Map<MorphItem, Keyframe[]>();
  const moving = new Set<MorphItem>();
  for (const item of items) frames.set(item, []);
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const p = options.easing(t);
    const nets = new Map<MorphItem, Affine>();
    const netOf = (item: MorphItem): Affine => {
      const known = nets.get(item);
      if (known) return known;
      const parentNet = item.parent ? netOf(item.parent) : IDENTITY;
      const solved = solveAt(item, p, parentNet);
      nets.set(item, solved.net);
      return solved.net;
    };
    for (const item of items) {
      const parentNet = item.parent ? netOf(item.parent) : IDENTITY;
      const solved = solveAt(item, p, parentNet);
      nets.set(item, solved.net);
      const frame: Keyframe = {
        offset: t,
        transformOrigin: '0px 0px',
        transform: `translate(${round(solved.translateX, 3)}px, ${round(solved.translateY, 3)}px) scale(${round(solved.scaleX, 6)}, ${round(solved.scaleY, 6)})`,
      };
      const still =
        Math.abs(solved.translateX) < 0.05
        && Math.abs(solved.translateY) < 0.05
        && Math.abs(solved.scaleX - 1) < 1e-4
        && Math.abs(solved.scaleY - 1) < 1e-4;
      if (!still) moving.add(item);
      if (item.radius) {
        const seen = lerp(item.radius.from, item.radius.to, p);
        const sx = Math.max(1e-3, Math.abs(solved.net.ax));
        const sy = Math.max(1e-3, Math.abs(solved.net.ay));
        frame.borderRadius = `${round(seen / sx, 2)}px / ${round(seen / sy, 2)}px`;
        if (item.radius.from !== item.radius.to) moving.add(item);
      }
      if (item.fade) {
        frame.opacity = round(fadeAt(item.fade, t), 3);
        if (item.fade.from !== 1 || item.fade.to !== 1) moving.add(item);
      }
      frames.get(item)!.push(frame);
    }
  }
  for (const item of items) if (!moving.has(item)) frames.delete(item);
  return frames;
}

/**
 * Play a morph: every item starts on this frame, with the same duration, and
 * holds its last frame until the move is over, when all of them are dropped
 * together (their last frames are their resting state, so nothing jumps).
 * Returns the animations, or none where Web Animations are missing (jsdom).
 */
export function playMorph(items: readonly MorphItem[], options: MorphOptions): Animation[] {
  const frames = morphFrames(items, options);
  const animations: Animation[] = [];
  for (const [item, keyframes] of frames) {
    if (typeof item.el.animate !== 'function') continue;
    const animation = item.el.animate(keyframes, { duration: options.duration, easing: 'linear', fill: 'both' });
    animation.id = `glass-morph:${item.name ?? item.kind}`;
    animations.push(animation);
  }
  return animations;
}

/** The box a 16:9 picture takes inside `box` when it is contained (letterboxed). */
export function containedPicture(box: MorphBox, aspect = 16 / 9): MorphBox {
  if (!(box.width > 0) || !(box.height > 0)) return box;
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}
