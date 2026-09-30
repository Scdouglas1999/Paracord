import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { prefersReducedMotion } from '../../../lib/motion/reducedMotion';
import {
  containedPicture,
  cubicBezier,
  GLASS_LAYOUT_CURVE,
  playMorph,
  type MorphBox,
  type MorphFade,
  type MorphItem,
} from '../../../lib/motion/sharedElement';
import { createViewFrameSource } from '../../../lib/room/viewFrameSource';
import { isTauri } from '../../../lib/tauriEnv';
import { useGlassStore, type GlassState, type StageMode } from '../../../stores/glassStore';

/**
 * The stage's layout moves (docs/glass-spec.md §6, §6.2, §6.3, §9; WP-G15).
 *
 *   open     Watch: the stage grows out of the call pill (or the live row that
 *            was clicked); the places panel steps back and fades; the
 *            conversation narrows against its right edge.
 *   close    Stop watching: the stage shrinks back into the pill, which fades
 *            in as it lands; places comes back; the conversation widens.
 *   mode     T: side by side <-> theater. The stage pane grows to the window
 *            (or back), the stream travels with a uniform scale (it never
 *            stretches), the title, buttons and controls glide to their places,
 *            the people row and the theater faces cross over.
 *   browse   S: places slides in from the left (or out); side by side, the stage
 *            grows to 1076 and the conversation steps aside (its own CSS
 *            transition, glass-layout.css); in theater the faces, the title and
 *            the controls move over.
 *   chat     H: the conversation slides away (CSS); the controls and the buttons
 *            move over to the middle of what is visible.
 *
 * 650ms on the Glass layout curve; reduced motion makes every one of them a
 * 150ms crossfade in place (§9).
 *
 * HOW. Any change of the stage's layout state, whoever makes it (the pill's
 * Watch, the live row, S/T/H/Esc, the buttons, a route change closing browse),
 * goes through `glassStore`. A store listener runs inside `set()`, before React
 * has touched the DOM, so it measures where everything IS (transforms included,
 * so a move interrupted halfway retargets from where it was seen). It clones
 * what is about to disappear (the stage on close, places, the pill, the people
 * row) into a layer above the frame. After React commits the new layout, the
 * frame's layout effect (plus one microtask, so the stage's own synchronous
 * re-measure has landed) measures where everything went and plays the
 * difference as one morph (lib/motion/sharedElement.ts). Nothing depends on
 * who called the store.
 *
 * NATIVE VIDEO (glass-plan §6). On the desktop app a stream may be drawn on a
 * platform surface under (Linux) or over (macOS) the webview, which follows its
 * element's box only when the box is reported, and never mid-animation. So for
 * the length of a move a transparent shield marked `data-native-overlay-occlude`
 * covers the window: every native surface reads it as an occluder and hides,
 * the stream box shows its poster (the last sampled frame, `useStreamPoster`)
 * while it travels, and when the shield comes off the surfaces report their
 * settled geometry and come back. The shield also takes the pointer for those
 * 650ms. On the web there are no native surfaces, and no shield.
 */

export const STAGE_MOVE_MS = 650;
export const STAGE_CROSSFADE_MS = 150;

const EASE = cubicBezier(...GLASS_LAYOUT_CURVE);
const LINEAR = (t: number) => t;

/* ---- What changed -------------------------------------------------------------- */

export interface StageLayoutKey {
  mode: StageMode;
  browse: boolean;
  chatHidden: boolean;
}

export type StageChange = 'open' | 'close' | 'mode' | 'browse' | 'chat';

export function layoutKeyOf(state: Pick<GlassState, 'stage' | 'browseOpen' | 'chatHidden'>): StageLayoutKey {
  return { mode: state.stage.mode, browse: state.browseOpen, chatHidden: state.chatHidden };
}

/** Which move a state change is, or null when nothing on screen moves. Pure. */
export function classifyChange(prev: StageLayoutKey, next: StageLayoutKey): StageChange | null {
  if (prev.mode === next.mode && prev.browse === next.browse && prev.chatHidden === next.chatHidden) return null;
  if (prev.mode === 'none' && next.mode !== 'none') return 'open';
  if (prev.mode !== 'none' && next.mode === 'none') return 'close';
  if (prev.mode === 'none') return null;
  if (prev.mode !== next.mode) return 'mode';
  if (prev.browse !== next.browse) return 'browse';
  return 'chat';
}

/* ---- The parts -------------------------------------------------------------------- */

const PARTS = {
  places: ':scope > .glass-frame__places',
  stage: ':scope > .glass-frame__stage',
  content: ':scope > .glass-frame__stage > .glass-stage',
  stream: ':scope > .glass-frame__stage .glass-stage__stream',
  title: ':scope > .glass-frame__stage [data-glass-move="title"]',
  actions: ':scope > .glass-frame__stage [data-glass-move="actions"]',
  peopleSide: ':scope > .glass-frame__stage [data-glass-move="people-side"]',
  peopleTheater: ':scope > .glass-frame__stage [data-glass-move="people-theater"]',
  controls: ':scope > .glass-frame__stage .glass-stage__controls',
  conversation: ':scope > .glass-frame__conversation',
  pill: '.glass-pill[data-layout="row"]',
  pillSurface: '.glass-pill[data-layout="row"] .glass-pill__surface',
} as const;

type Part = keyof typeof PARTS;

/** The stream box's own layers: they scale with it (or, the overlay, move as title and actions). */
const STREAM_OWN = 'canvas, .glass-stage__scrim, .glass-stage__overlay, .glass-stage__notice';

interface Snap {
  el: HTMLElement;
  rect: MorphBox;
  /** The corner radius it is seen with, px. */
  radius: number;
  /** Its computed box-shadow ("none" when it has none). */
  shadow: string;
  away: boolean;
}

/** The radius each element was last animated to: its computed value mid-move is the counter-scaled one. */
const seenRadius = new WeakMap<HTMLElement, number>();

function boxOf(el: Element): MorphBox {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function snap(el: HTMLElement): Snap {
  const style = getComputedStyle(el);
  const moving = typeof el.getAnimations === 'function' && el.getAnimations().some((a) => a.id.startsWith('glass-morph:'));
  const radius = moving && seenRadius.has(el) ? seenRadius.get(el)! : Number.parseFloat(style.borderTopLeftRadius) || 0;
  return {
    el,
    rect: boxOf(el),
    radius,
    shadow: el.style.boxShadow === 'none' && el.dataset.glassShadow ? el.dataset.glassShadow : style.boxShadow || 'none',
    away: el.getAttribute('data-away') === 'true',
  };
}

function measureParts(frame: HTMLElement): Map<Part, Snap> {
  const found = new Map<Part, Snap>();
  for (const [part, selector] of Object.entries(PARTS) as Array<[Part, string]>) {
    const el = frame.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const measured = snap(el);
    // An element with no box (display: none, not laid out yet) takes no part.
    if (measured.rect.width <= 0 || measured.rect.height <= 0) continue;
    found.set(part, measured);
  }
  return found;
}

/* ---- Layers: the clones above the frame, the shadows under it, the shield ------- */

export const MORPH_OVER_CLASS = 'glass-morph glass-morph--over';
export const MORPH_UNDER_CLASS = 'glass-morph glass-morph--under';

export interface MorphLayers {
  over: HTMLElement | null;
  under: HTMLElement | null;
}

/** A still copy of an element that is about to leave, placed exactly over it. */
function cloneOf(source: HTMLElement, at: Snap, layer: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  // It is a picture of the thing, not the thing: nothing in it can be reached,
  // named twice, or taken for a native surface's own chrome.
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  clone.removeAttribute('aria-label');
  clone.removeAttribute('role');
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('[id], [data-native-surface-boundary], [data-motion-speaking]')]) {
    node.removeAttribute('id');
    node.removeAttribute('data-native-surface-boundary');
    node.removeAttribute('data-motion-speaking');
  }
  // A canvas clones blank: copy what it shows (a WebGL canvas may copy blank too;
  // the clone's content fades out within the first third of the move anyway).
  const from = source.querySelectorAll('canvas');
  const to = clone.querySelectorAll('canvas');
  from.forEach((canvas, index) => {
    const copy = to[index];
    if (!copy || canvas.width === 0 || canvas.height === 0) return;
    try {
      copy.getContext('2d')?.drawImage(canvas, 0, 0);
    } catch {
      /* a tainted or lost context: the copy stays blank */
    }
  });
  clone.classList.add('glass-morph__clone');
  const style = clone.style;
  style.position = 'absolute';
  style.left = `${at.rect.left}px`;
  style.top = `${at.rect.top}px`;
  style.width = `${at.rect.width}px`;
  style.height = `${at.rect.height}px`;
  style.margin = '0';
  style.transform = 'none';
  style.translate = 'none';
  style.borderRadius = `${at.radius}px`;
  style.boxShadow = 'none';
  style.zIndex = 'auto';
  layer.appendChild(clone);
  return clone;
}

/** A shadow on its own layer, so a box whose corners change is never repainted with its blur. */
function shadowGhost(shadow: string, at: MorphBox, radius: number, layer: HTMLElement, before?: Node | null): HTMLElement {
  const ghost = document.createElement('div');
  ghost.className = 'glass-morph__shadow';
  ghost.setAttribute('aria-hidden', 'true');
  const style = ghost.style;
  style.left = `${at.left}px`;
  style.top = `${at.top}px`;
  style.width = `${at.width}px`;
  style.height = `${at.height}px`;
  style.borderRadius = `${radius}px`;
  style.boxShadow = shadow;
  layer.insertBefore(ghost, before ?? null);
  return ghost;
}

function shield(layer: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'glass-morph__shield';
  el.setAttribute('aria-hidden', 'true');
  // Native surfaces read this as an occluder (nativeVideoTile.ts, isUnderlayOccluder)
  // and hide until it is gone; then they report their settled geometry.
  el.setAttribute('data-native-overlay-occlude', '');
  layer.appendChild(el);
  return el;
}

/* ---- One move --------------------------------------------------------------------- */

interface Capture {
  change: StageChange;
  prev: StageLayoutKey;
  next: StageLayoutKey;
  reduced: boolean;
  before: Map<Part, Snap>;
  /** Open: where the stage grows from (the pill, or the live row that was clicked). */
  origin: Snap | null;
  clones: Map<Part, { clone: HTMLElement; at: Snap }>;
  shield: HTMLElement | null;
  /** Other packages' chrome on the stream (its direct children), where each was. */
  chrome: Map<HTMLElement, MorphBox>;
}

interface Running {
  animations: Animation[];
  nodes: HTMLElement[];
  restore: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

let running: Running | null = null;

function settle(run: Running | null): void {
  if (!run) return;
  if (run.timer) clearTimeout(run.timer);
  for (const animation of run.animations) animation.cancel();
  for (const undo of run.restore) undo();
  for (const node of run.nodes) node.remove();
  run.animations = [];
  run.nodes = [];
  run.restore = [];
  if (running === run) running = null;
}

/** For tests and for a frame that unmounts mid-move. */
export function settleStageMove(): void {
  settle(running);
}

function leaversFor(change: StageChange, prev: StageLayoutKey, next: StageLayoutKey, before: Map<Part, Snap>): Part[] {
  const out: Part[] = [];
  switch (change) {
    case 'open':
      if (before.has('places')) out.push('places');
      if (before.has('pill')) out.push('pill');
      break;
    case 'close':
      if (before.has('stage')) out.push('stage');
      break;
    case 'mode':
      if (before.has('peopleSide')) out.push('peopleSide');
      if (before.has('peopleTheater')) out.push('peopleTheater');
      break;
    case 'browse':
      if (prev.browse && !next.browse && before.has('places')) out.push('places');
      break;
    case 'chat':
      break;
  }
  return out;
}

function capture(frame: HTMLElement, layers: MorphLayers, prev: StageLayoutKey, next: StageLayoutKey): Capture | null {
  if (frame.dataset.layout === 'phone') return null;
  const change = classifyChange(prev, next);
  if (!change) return null;
  const before = measureParts(frame);
  let origin: Snap | null = null;
  if (change === 'open') {
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest<HTMLElement>('.glass-place-live') : null;
    if (row && row.getBoundingClientRect().width > 0) origin = snap(row);
    else origin = before.get('pillSurface') ?? null;
  }
  // A move that starts before the last one finished starts from where things
  // are seen now (measured above); the last one's clones and shield go.
  settle(running);
  const clones = new Map<Part, { clone: HTMLElement; at: Snap }>();
  if (layers.over) {
    for (const part of leaversFor(change, prev, next, before)) {
      const at = before.get(part);
      if (at) clones.set(part, { clone: cloneOf(at.el, at, layers.over), at });
    }
  }
  const guard = isTauri() && layers.over ? shield(layers.over) : null;
  const chrome = new Map<HTMLElement, MorphBox>();
  const stream = before.get('stream')?.el;
  if (stream) {
    for (const child of stream.children) {
      if (!(child instanceof HTMLElement) || child.matches(STREAM_OWN)) continue;
      const rect = boxOf(child);
      if (rect.width > 0 && rect.height > 0) chrome.set(child, rect);
    }
  }
  return { change, prev, next, reduced: prefersReducedMotion(), before, origin, clones, shield: guard, chrome };
}

const shift = (box: MorphBox, dx: number, dy = 0): MorphBox => ({ ...box, left: box.left + dx, top: box.top + dy });

function scaleAbout(box: MorphBox, factor: number): MorphBox {
  const width = box.width * factor;
  const height = box.height * factor;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

const same = (a: MorphBox, b: MorphBox) =>
  Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

interface Plan {
  items: MorphItem[];
  /** Nodes to remove when the move settles (clones, ghosts, the shield). */
  nodes: HTMLElement[];
  restore: Array<() => void>;
  /** Extra animations played outside the morph (reduced-motion crossfades of away panes). */
  extra: Animation[];
}

function hideShadow(plan: Plan, el: HTMLElement, shadow: string): void {
  if (shadow === 'none' || !shadow) return;
  const previous = el.style.boxShadow;
  el.dataset.glassShadow = shadow;
  el.style.boxShadow = 'none';
  plan.restore.push(() => {
    el.style.boxShadow = previous;
    delete el.dataset.glassShadow;
  });
}

/** A box morph of a real pane, its shadow crossfading on ghosts under the frame. */
function paneBox(
  plan: Plan,
  layers: MorphLayers,
  name: string,
  from: MorphBox,
  fromRadius: number,
  fromShadow: string,
  after: Snap,
): MorphItem {
  const item: MorphItem = {
    name,
    el: after.el,
    kind: 'box',
    layout: after.rect,
    from,
    to: after.rect,
    radius: { from: fromRadius, to: after.radius },
  };
  seenRadius.set(after.el, after.radius);
  if (layers.under) {
    hideShadow(plan, after.el, after.shadow);
    if (fromShadow && fromShadow !== 'none') {
      const ghost = shadowGhost(fromShadow, after.rect, after.radius, layers.under);
      plan.nodes.push(ghost);
      plan.items.push({ name: `${name}-shadow-from`, el: ghost, kind: 'box', layout: after.rect, from, to: after.rect, fade: { from: 1, to: 0 } });
    }
    if (after.shadow && after.shadow !== 'none') {
      const ghost = shadowGhost(after.shadow, after.rect, after.radius, layers.under);
      plan.nodes.push(ghost);
      plan.items.push({ name: `${name}-shadow-to`, el: ghost, kind: 'box', layout: after.rect, from, to: after.rect, fade: { from: 0, to: 1 } });
    }
  }
  plan.items.push(item);
  return item;
}

/** Each element child of a pane rides the pane's corner (it keeps its size). */
function rideChildren(plan: Plan, pane: MorphItem, anchor: readonly [number, number], fade?: MorphFade): void {
  for (const child of pane.el.children) {
    if (!(child instanceof HTMLElement)) continue;
    const layout = boxOf(child);
    if (layout.width <= 0 && layout.height <= 0) continue;
    plan.items.push({ name: 'ride', el: child, kind: 'ride', layout, parent: pane, anchor, fade });
  }
}

function fullPlan(cap: Capture, after: Map<Part, Snap>, layers: MorphLayers): Plan {
  const plan: Plan = { items: [], nodes: [], restore: [], extra: [] };
  const { change, before } = cap;
  const b = (part: Part) => before.get(part);
  const a = (part: Part) => after.get(part);

  /* The stage pane and what it holds. */
  const stageAfter = a('stage');
  let stageItem: MorphItem | null = null;
  let contentItem: MorphItem | null = null;
  if (stageAfter && change === 'open') {
    const origin = cap.origin;
    const from = origin?.rect ?? scaleAbout(stageAfter.rect, 0.96);
    stageItem = paneBox(plan, layers, 'stage', from, origin?.radius ?? stageAfter.radius, 'none', stageAfter);
    if (!origin) stageItem.fade = { from: 0, to: 1, end: 0.35 };
    // Above the conversation it grows across, for the length of the move.
    const el = stageAfter.el;
    const { position, zIndex } = el.style;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.zIndex = '3';
    plan.restore.push(() => {
      el.style.position = position;
      el.style.zIndex = zIndex;
    });
  } else if (stageAfter && b('stage')) {
    const before = b('stage')!;
    if (!same(before.rect, stageAfter.rect) || before.radius !== stageAfter.radius) {
      stageItem = paneBox(plan, layers, 'stage', before.rect, before.radius, before.shadow, stageAfter);
    }
  }
  const contentAfter = a('content');
  if (contentAfter) {
    if (stageItem) {
      contentItem = {
        name: 'stage-content',
        el: contentAfter.el,
        kind: 'ride',
        layout: contentAfter.rect,
        parent: stageItem,
        anchor: [0, 0],
        fade: change === 'open' ? { from: 0, to: 1, start: 0.12, end: 0.55 } : undefined,
      };
      plan.items.push(contentItem);
    }
  }
  const parentInStage = contentItem ?? undefined;

  if (change !== 'open' && stageAfter) {
    // The stream travels with a uniform scale; the chrome on it keeps its size.
    const streamBefore = b('stream');
    const streamAfter = a('stream');
    let streamItem: MorphItem | null = null;
    if (streamBefore && streamAfter && (!same(streamBefore.rect, streamAfter.rect) || stageItem)) {
      const picture = containedPicture(streamAfter.rect);
      streamItem = {
        name: 'stream',
        el: streamAfter.el,
        kind: 'fit',
        layout: streamAfter.rect,
        picture,
        from: containedPicture(streamBefore.rect),
        to: picture,
        parent: parentInStage,
        radius: { from: streamBefore.radius, to: streamAfter.radius },
      };
      seenRadius.set(streamAfter.el, streamAfter.radius);
      plan.items.push(streamItem);
      // Scaled by its picture, the stream's box loses its letterbox for the move,
      // and the title and buttons that sit in it would be clipped: let them show,
      // and round the picture itself with the stream's (moving) corners instead.
      const el = streamAfter.el;
      const overflow = el.style.overflow;
      el.style.overflow = 'visible';
      const canvases = [...el.querySelectorAll<HTMLElement>(':scope > canvas')];
      const radii = canvases.map((canvas) => canvas.style.borderRadius);
      for (const canvas of canvases) canvas.style.borderRadius = 'inherit';
      plan.restore.push(() => {
        el.style.overflow = overflow;
        canvases.forEach((canvas, index) => {
          canvas.style.borderRadius = radii[index];
        });
      });
    }
    const aligns = { title: [0, 0], actions: [1, 0] } as const;
    for (const part of ['title', 'actions'] as const) {
      const was = b(part);
      const now = a(part);
      if (!was || !now) continue;
      plan.items.push({ name: part, el: now.el, kind: 'rigid', layout: now.rect, from: was.rect, to: now.rect, align: aligns[part], parent: streamItem ?? parentInStage });
    }
    // Other chrome on the stream (the reactions, the surfacing messages): glides
    // from where it was to where it is, counter-scaled against the stream. An
    // element with a transform of its own at rest (the clip toast centers itself
    // with one) is left to scale with the stream: a move's transform would
    // replace its own for 650ms.
    if (streamAfter) {
      for (const [el, was] of cap.chrome) {
        if (!el.isConnected || !streamAfter.el.contains(el)) continue;
        const now = boxOf(el);
        if (now.width <= 0 || now.height <= 0) continue;
        if (getComputedStyle(el).transform !== 'none') continue;
        plan.items.push({ name: 'stream-chrome', el, kind: 'rigid', layout: now, from: was, to: now, parent: streamItem ?? parentInStage });
      }
    }
    const controlsBefore = b('controls');
    const controlsAfter = a('controls');
    if (controlsBefore && controlsAfter) {
      plan.items.push({ name: 'controls', el: controlsAfter.el, kind: 'rigid', layout: controlsAfter.rect, from: controlsBefore.rect, to: controlsAfter.rect, parent: parentInStage });
    }
    for (const part of ['peopleSide', 'peopleTheater'] as const) {
      const was = b(part);
      const now = a(part);
      if (now && was && now.el === was.el) {
        plan.items.push({ name: part, el: now.el, kind: 'rigid', layout: now.rect, from: was.rect, to: now.rect, align: [0, 0], parent: parentInStage });
      } else if (now) {
        // The other layout's people cross over: these fade in as the old ones fade out.
        plan.items.push({ name: part, el: now.el, kind: 'rigid', layout: now.rect, parent: parentInStage, fade: { from: 0, to: 1, start: 0.35, end: 1 } });
      }
    }
  }

  /* The conversation: narrows or widens against the edge that stays put. Its
     stepping aside (browse, H) is its own CSS transition (glass-layout.css). */
  const convBefore = b('conversation');
  const convAfter = a('conversation');
  if (convBefore && convAfter && !convBefore.away && !convAfter.away && !same(convBefore.rect, convAfter.rect)) {
    const pane = paneBox(plan, layers, 'conversation', convBefore.rect, convBefore.radius, convBefore.shadow, convAfter);
    const right = (r: MorphBox) => r.left + r.width;
    const anchorRight = Math.abs(right(convBefore.rect) - right(convAfter.rect)) <= Math.abs(convBefore.rect.left - convAfter.rect.left);
    rideChildren(plan, pane, anchorRight ? [1, 0] : [0, 0]);
  }

  /* Places. */
  const placesBefore = b('places');
  const placesAfter = a('places');
  const gutter = 16;
  if (placesAfter && !placesBefore) {
    if (change === 'close') {
      // Back to the conversation: it steps forward again (the prototype's 28px and 98%).
      plan.items.push({ name: 'places', el: placesAfter.el, kind: 'box', layout: placesAfter.rect, from: shift(scaleAbout(placesAfter.rect, 0.98), -28), to: placesAfter.rect, fade: { from: 0, to: 1, start: 0.15, end: 0.7 } });
    } else {
      // Browse: it slides in from the left edge.
      plan.items.push({ name: 'places', el: placesAfter.el, kind: 'rigid', layout: placesAfter.rect, from: shift(placesAfter.rect, -(placesAfter.rect.left + placesAfter.rect.width + gutter)), to: placesAfter.rect, fade: { from: 0, to: 1, end: 0.45 } });
    }
  } else if (placesAfter && placesBefore && placesAfter.el === placesBefore.el && !same(placesBefore.rect, placesAfter.rect)) {
    plan.items.push({ name: 'places', el: placesAfter.el, kind: 'rigid', layout: placesAfter.rect, from: placesBefore.rect, to: placesAfter.rect });
  }

  /* What left: the clones. */
  for (const [part, { clone, at }] of cap.clones) {
    plan.nodes.push(clone);
    if (part === 'places') {
      const to = change === 'open' ? shift(scaleAbout(at.rect, 0.98), -28) : shift(at.rect, -(at.rect.left + at.rect.width + gutter));
      plan.items.push({
        name: 'places-leaving',
        el: clone,
        kind: change === 'open' ? 'box' : 'rigid',
        layout: at.rect,
        from: at.rect,
        to,
        fade: change === 'open' ? { from: 1, to: 0, end: 0.45 } : { from: 1, to: 0, start: 0.25, end: 1 },
      });
    } else if (part === 'pill') {
      plan.items.push({ name: 'pill-leaving', el: clone, kind: 'rigid', layout: at.rect, fade: { from: 1, to: 0, end: 0.22 } });
    } else if (part === 'peopleSide' || part === 'peopleTheater') {
      plan.items.push({ name: 'people-leaving', el: clone, kind: 'rigid', layout: at.rect, fade: { from: 1, to: 0, end: 0.3 } });
    } else if (part === 'stage') {
      const pill = a('pillSurface');
      const target = pill?.rect ?? scaleAbout(at.rect, 0.96);
      if (layers.over && at.shadow && at.shadow !== 'none') {
        const ghost = shadowGhost(at.shadow, at.rect, at.radius, layers.over, clone);
        plan.nodes.push(ghost);
        plan.items.push({ name: 'stage-leaving-shadow', el: ghost, kind: 'box', layout: at.rect, from: at.rect, to: target, fade: { from: 1, to: 0, end: 0.6 } });
      }
      const box: MorphItem = {
        name: 'stage-leaving',
        el: clone,
        kind: 'box',
        layout: at.rect,
        from: at.rect,
        to: target,
        radius: { from: at.radius, to: pill?.radius ?? at.radius },
        fade: pill ? { from: 1, to: 0, start: 0.72, end: 1 } : { from: 1, to: 0, end: 0.5 },
      };
      plan.items.push(box);
      const inner = clone.firstElementChild;
      if (inner instanceof HTMLElement) {
        // The clone's content rides the shrinking box's top left and fades early.
        plan.items.push({ name: 'stage-leaving-content', el: inner, kind: 'ride', layout: boxOf(inner), parent: box, anchor: [0, 0], fade: { from: 1, to: 0, end: 0.3 } });
      }
    }
  }

  /* The pill lands where the stage shrank to. */
  if (change === 'close') {
    const pill = a('pill');
    if (pill) plan.items.push({ name: 'pill', el: pill.el, kind: 'rigid', layout: pill.rect, fade: { from: 0, to: 1, start: 0.62, end: 0.95 } });
  }
  return plan;
}

/** Reduced motion: nothing travels. What arrived or moved fades in, what left fades out, 150ms (§9). */
function reducedPlan(cap: Capture, after: Map<Part, Snap>): Plan {
  const plan: Plan = { items: [], nodes: [], restore: [], extra: [] };
  const fadeIn: MorphFade = { from: 0, to: 1 };
  const parts: Part[] = ['places', 'stage', 'conversation', 'pill'];
  for (const part of parts) {
    const now = after.get(part);
    if (!now) continue;
    const was = cap.before.get(part);
    if (part === 'conversation' && was && was.away !== now.away) continue;
    if (!was || was.el !== now.el || !same(was.rect, now.rect)) {
      plan.items.push({ name: `${part}-in`, el: now.el, kind: 'rigid', layout: now.rect, fade: fadeIn });
    }
  }
  for (const { clone, at } of cap.clones.values()) {
    plan.nodes.push(clone);
    plan.items.push({ name: 'leaving', el: clone, kind: 'rigid', layout: at.rect, fade: { from: 1, to: 0 } });
  }
  // The conversation stepping aside or back: CSS moves it at once under reduced
  // motion (utilities.css zeroes every transition), so crossfade it in place here.
  const convBefore = cap.before.get('conversation');
  const convAfter = after.get('conversation');
  if (convBefore && convAfter && convBefore.away !== convAfter.away && typeof convAfter.el.animate === 'function') {
    const leaving = convAfter.away;
    const animation = convAfter.el.animate(
      [
        { transform: 'none', opacity: leaving ? 1 : 0 },
        { transform: 'none', opacity: leaving ? 0 : 1 },
      ],
      { duration: STAGE_CROSSFADE_MS, easing: 'linear', fill: 'both' },
    );
    animation.id = 'glass-morph:conversation-crossfade';
    plan.extra.push(animation);
  }
  return plan;
}

function play(frame: HTMLElement, layers: MorphLayers, cap: Capture): void {
  const after = measureParts(frame);
  const plan = cap.reduced ? reducedPlan(cap, after) : fullPlan(cap, after, layers);
  const duration = cap.reduced ? STAGE_CROSSFADE_MS : STAGE_MOVE_MS;
  const animations = [...plan.extra, ...playMorph(plan.items, { duration, easing: cap.reduced ? LINEAR : EASE })];
  const run: Running = {
    animations,
    nodes: cap.shield ? [...plan.nodes, cap.shield] : plan.nodes,
    restore: plan.restore,
    timer: null,
  };
  // Clones that no plan used still have to go.
  for (const { clone } of cap.clones.values()) if (!run.nodes.includes(clone)) run.nodes.push(clone);
  running = run;
  if (animations.length === 0) {
    settle(run);
    return;
  }
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => settle(run));
  // A window hidden mid-move stops its animation clock; the move still ends (and
  // the shield still comes off) when its time is up.
  run.timer = setTimeout(() => settle(run), duration + 500);
}

/**
 * Wire the moves to the frame: GlassFrame calls this once with its frame and
 * its two morph layers. `deps` are the layout state the frame rendered with.
 */
export function useStageTransitions(
  frameRef: RefObject<HTMLElement | null>,
  overRef: RefObject<HTMLElement | null>,
  underRef: RefObject<HTMLElement | null>,
  deps: StageLayoutKey,
): void {
  const pending = useRef<Capture | null>(null);

  useEffect(() => {
    const unsubscribe = useGlassStore.subscribe((state, previous) => {
      const next = layoutKeyOf(state);
      const prev = layoutKeyOf(previous);
      if (!classifyChange(prev, next)) return;
      const frame = frameRef.current;
      if (!frame) return;
      // Two changes before React commits (one handler calling two actions) are
      // one move: keep the first measurement, which is what is on screen.
      if (pending.current) {
        pending.current.next = next;
        pending.current.change = classifyChange(pending.current.prev, next) ?? pending.current.change;
        return;
      }
      pending.current = capture(frame, { over: overRef.current, under: underRef.current }, prev, next);
    });
    return () => {
      unsubscribe();
      settle(running);
    };
  }, [frameRef, overRef, underRef]);

  useLayoutEffect(() => {
    const cap = pending.current;
    if (!cap) return;
    pending.current = null;
    const frame = frameRef.current;
    if (!frame) {
      for (const { clone } of cap.clones.values()) clone.remove();
      cap.shield?.remove();
      return;
    }
    // One microtask: the stage re-measures its own geometry in a layout effect,
    // and React commits that synchronously right after this one. Still before paint.
    queueMicrotask(() => play(frame, { over: overRef.current, under: underRef.current }, cap));
  }, [deps.mode, deps.browse, deps.chatHidden, frameRef, overRef, underRef]);
}

/* ---- The poster: the stream while its native surface cannot be shown ------------ */

const POSTER_HZ = 1;

/**
 * On the desktop app's native route no frame of the stream reaches the page,
 * so while its surface is hidden (a move, a dialog over it) the stream box
 * would be black. The shell keeps a 32x18 sample of what the surface presents
 * (`native_render_sample`, G8); this draws the latest one, once a second, into
 * `canvasRef`, scaled up (a soft picture of the frame, the "last sampled frame"
 * of glass-plan §6). `data-native` on the canvas says the poster is in use; CSS
 * shows it only while the stream box has no live surface (glass-stage-modes.css).
 *
 * On a route that draws in the page (WebCodecs) the stream moves with the page
 * and needs no poster, so the subscription stops at the first frame. On the
 * web there is no native route at all, and nothing is subscribed.
 */
export function useStreamPoster(canvasRef: RefObject<HTMLCanvasElement | null>, streamerId: string): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isTauri()) return;
    const source = createViewFrameSource('watch', streamerId);
    let stopped = false;
    let stop: (() => void) | null = null;
    const end = () => {
      if (stopped) return;
      stopped = true;
      stop?.();
    };
    stop = source.subscribe((bitmap) => {
      try {
        if (stopped) return;
        if (source.route !== 'native-surface') {
          queueMicrotask(end);
          return;
        }
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        canvas.dataset.native = 'true';
      } finally {
        bitmap.close();
      }
    }, POSTER_HZ);
    if (stopped) stop();
    return () => {
      end();
      delete canvas.dataset.native;
    };
  }, [canvasRef, streamerId]);
}
