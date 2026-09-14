import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

import { prefersReducedMotion } from './reducedMotion';
import { sampleRunning, springEasing, springTokens } from './spring';
import { motionToken, ms } from './tokens';

/**
 * FLIP for lists (docs/lantern-stage-spec.md §5.1, §5.3).
 *
 * "A list that changes order animates layout on the spring-settle curve — never
 * a snap." `transitionWith` covers the one-off shared element; this hook covers
 * a container whose rows reorder as data changes (the Buildings column, the
 * toast stack), where the update arrives from a store rather than a click the
 * engine can wrap.
 *
 * Rows opt in with a stable `data-flip-key`. On every commit the hook measures
 * them and plays back the deltas:
 *
 *   - a row that MOVED travels on the spring, `--duration-move`, interruptibly —
 *     a second reorder retargets it carrying the velocity it had;
 *   - a row that ARRIVED fades and rises like a surface (`pc-enter`'s recipe:
 *     6px, spring-settle, `--duration-slow`);
 *   - a row that LEFT leaves a falling clone at its old spot (`pc-exit`'s
 *     recipe: 4px, `--ease-in`, `--duration-fast`) — a real removed node cannot
 *     play its own exit, so the engine paints the same leave as scenery;
 *   - a row inside a moved PARENT does not animate twice: when an ancestor
 *     marked with the same attribute travelled the same delta, the ancestor
 *     carries the row.
 *
 * The first commit only measures — nothing animates on initial mount
 * (§5.3), and reduced motion lands everything instantly by skipping the play.
 */

export const FLIP_KEY_ATTR = 'data-flip-key';

/**
 * On a `pop` row: the person looking at this screen put this here — the chip
 * takes the full pop (0.6 up, glyph over-rotating) rather than the smaller
 * 0.8 pop a reaction arriving from somebody else gets.
 */
export const FLIP_OWN_ATTR = 'data-flip-own';

/**
 * Inside an own `pop` row: the mark that over-rotates ±8° while the row
 * itself scales — the emoji on a reaction chip.
 */
export const FLIP_GLYPH_ATTR = 'data-flip-glyph';

/**
 * Every animation this module creates carries the same id convention
 * `flip.ts` uses — `data-motion-recipe:<name>` — so the frame gate can say
 * which recipe a dropped frame belongs to instead of reporting `anonymous`.
 */
const RECIPE = 'data-motion-recipe';

function tag(animation: Animation, recipe: string): Animation {
  animation.id = `${RECIPE}:${recipe}`;
  return animation;
}

const MOVED_EPSILON_PX = 0.5;

/**
 * `offsetTop`/`offsetLeft` are whole pixels, so a layout box can disagree with
 * the rendered one by up to a pixel per axis without anything having moved.
 * A real reorder in this column is 36 px; 1.5 keeps the rounding out.
 */
const LAYOUT_EPSILON_PX = 1.5;

/**
 * How far a row's delta may differ from its carrying ancestor's and still count
 * as the same journey. Both deltas are differences of whole-pixel offsets, so
 * each can be a pixel out and the difference two; anything smaller than a
 * character is not a row moving independently of the plate it sits on. Getting
 * this wrong animates the row AND the section it is in, and the two transforms
 * compose into a row travelling twice as far as the list did.
 */
const CARRIED_EPSILON_PX = 2.5;

/**
 * A row's place in the container's own content box — NOT the viewport, and NOT
 * where an animation currently has it.
 *
 * Two things have to come out of the number before a delta can mean "this row
 * reordered":
 *
 *   - **Scroll.** A viewport rect changes when the list scrolls, and a store
 *     update that arrives mid-scroll would read every row as having moved and
 *     animate the whole column back to where the scroll had just taken it.
 *   - **The transform a FLIP is already playing.** `getBoundingClientRect`
 *     reports where a row is being *drawn*, which during a move is somewhere
 *     between its old place and its new one. Recording that as the row's
 *     resting position feeds a mid-flight number back in as the next commit's
 *     "before", and because a burst of store updates commits several times
 *     inside one 380 ms move, the error compounds: the desktop client measured
 *     383 px, then 466, 849, 1315, 2176 … 28 300 px — the Fibonacci sum of its
 *     own mistakes — and the sidebar's rows were told to fly in from four
 *     screens away. That is the "bounce" the user was reporting. A row must
 *     animate from where it actually was, so the box we keep is the LAYOUT box:
 *     the offset chain, which no transform can touch.
 *
 * What the running transform is worth is still needed — an interrupted move has
 * to retarget from where the row is *drawn*, not restart from where layout put
 * it — so it is measured as {@link Drift}: rendered minus layout, read fresh on
 * the commit that needs it and never stored.
 */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far animations currently have a row from where layout put it. */
interface Drift {
  dx: number;
  dy: number;
}

interface Frame {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
  right: number;
  bottom: number;
  /** The container's own place in the offset chain, so rows can subtract it. */
  offsetLeft: number;
  offsetTop: number;
}

/**
 * Where an element sits in the document's LAYOUT, walking the offset chain.
 *
 * `offsetLeft`/`offsetTop` are measured from an ancestor's padding edge and are
 * defined on layout alone: they ignore both scroll and every transform in the
 * chain, which is exactly what a FLIP's "before" needs. Summing the chain for
 * a row and for its container and subtracting cancels everything they share.
 */
function layoutOrigin(el: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = el;
  while (node) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { left, top };
}

function frameOf(container: HTMLElement): Frame {
  const rect = container.getBoundingClientRect();
  const origin = layoutOrigin(container);
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    scrollLeft: container.scrollLeft,
    scrollTop: container.scrollTop,
    offsetLeft: origin.left,
    offsetTop: origin.top,
  };
}

/** The row's resting place: layout only, immune to a move already in flight. */
function boxOf(el: HTMLElement, frame: Frame): Box {
  const origin = layoutOrigin(el);
  return {
    left: origin.left - frame.offsetLeft,
    top: origin.top - frame.offsetTop,
    width: el.offsetWidth,
    height: el.offsetHeight,
  };
}

/**
 * Where the row is being *drawn* right now, minus where layout puts it — the
 * sum of every transform between it and the container, however that transform
 * got there. Zero unless something is mid-animation.
 */
function driftOf(el: HTMLElement, box: Box, frame: Frame): Drift | null {
  const rect = el.getBoundingClientRect();
  const dx = rect.left - frame.left + frame.scrollLeft - box.left;
  const dy = rect.top - frame.top + frame.scrollTop - box.top;
  if (Math.abs(dx) < LAYOUT_EPSILON_PX && Math.abs(dy) < LAYOUT_EPSILON_PX) return null;
  return { dx, dy };
}

/** Is this one of ours, and still going? */
function inFlight(animation: Animation | undefined): boolean {
  return Boolean(animation) && animation!.playState === 'running';
}

function rowsOf(container: HTMLElement, attribute: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[${attribute}]`)];
}

/** The nearest marked ancestor, or null — the row a parent FLIP carries. */
function flipAncestor(el: HTMLElement, container: HTMLElement, attribute: string): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== container) {
    if (node.hasAttribute(attribute)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * The stack the ghost has to join. A clone parked on `document.body` has left
 * its container's stacking context, so it needs the container's own z-index or
 * it falls behind the very surface it was part of (a toast ghost under the
 * toast stack, say).
 */
function stackingIndex(container: HTMLElement): string {
  let node: HTMLElement | null = container;
  while (node && node !== document.body) {
    const z = getComputedStyle(node).zIndex;
    if (z && z !== 'auto') return z;
    node = node.parentElement;
  }
  return '40';
}

/**
 * Paint a removed row's leave as a clone at the spot it occupied, then drop it.
 * A real removed node cannot play its own exit, so the engine paints the same
 * 4px fall as scenery — but only where the row was actually visible: a row
 * scrolled out of its container has no leave to show, and a `fixed` clone
 * would escape the container's clip and fall across the chrome above it.
 *
 * `shrink` is the pop list's exit: a reaction chip does not fall, it fades
 * back out the way it popped in.
 */
function playDeparture(el: HTMLElement, box: Box, frame: Frame, zIndex: string, style: 'fall' | 'shrink'): void {
  if (typeof el.cloneNode !== 'function') return;
  const left = box.left + frame.left - frame.scrollLeft;
  const top = box.top + frame.top - frame.scrollTop;
  const visible =
    top >= frame.top - 1 &&
    top + box.height <= frame.bottom + 1 &&
    left >= frame.left - 1 &&
    left + box.width <= frame.right + 1;
  if (!visible) return;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.setAttribute('aria-hidden', 'true');
  clone.removeAttribute(FLIP_KEY_ATTR);
  Object.assign(clone.style, {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex,
  });
  (document.body ?? document.documentElement).append(clone);
  const drop = () => clone.remove();
  if (typeof clone.animate === 'function') {
    const animation = tag(
      clone.animate(
        style === 'shrink'
          ? [
              { opacity: 1, transform: 'scale(1)' },
              { opacity: 0, transform: 'scale(0.6)' },
            ]
          : [
              { opacity: 1, transform: 'translate3d(0, 0, 0)' },
              { opacity: 0, transform: 'translate3d(0, 4px, 0)' },
            ],
        {
          duration: ms('--duration-fast'),
          easing: motionToken('--ease-in'),
          fill: 'forwards',
        },
      ),
      'exit',
    );
    animation.finished.then(drop, drop);
    animation.addEventListener('cancel', drop);
  }
  // The clone is scenery: even if the animation never reports, it cannot stay.
  window.setTimeout(drop, ms('--duration-fast') + 400);
}

export interface FlipListOptions {
  /** The attribute carrying the row key. Defaults to `data-flip-key`. */
  attribute?: string;
  /** Pixels a new row rises as it fades in. 6 matches the shared enter. */
  enterDistance?: number;
  /**
   * How a new row arrives. `rise` is the shared surface enter — a row joining
   * a list. `pop` is §5.1's reaction: it lands rather than slides — 0.6 to 1
   * on the spring when it's yours, 0.8 when it arrives from somebody else —
   * because a reaction is a thing somebody put there, not a row that was
   * always going to be there.
   */
  enter?: 'rise' | 'pop';
  /**
   * How a removed row leaves. `fall` is the shared surface leave — a 4px drop
   * as it fades. `shrink` is the pop list's exit — the chip fades back out the
   * way it came. Defaults to `shrink` for `pop` rows, `fall` otherwise.
   */
  exit?: 'fall' | 'shrink';
}

/**
 * Watch a container's marked rows and FLIP every reorder, arrival and leave.
 * Attach the returned ref to the scroll container; give every row a stable
 * `data-flip-key`.
 */
export function useFlipList<T extends HTMLElement = HTMLElement>(
  options: FlipListOptions = {},
): RefObject<T | null> {
  const attribute = options.attribute ?? FLIP_KEY_ATTR;
  const enterDistance = options.enterDistance ?? 6;
  const enterStyle = options.enter ?? 'rise';
  const exitStyle = options.exit ?? (enterStyle === 'pop' ? 'shrink' : 'fall');
  const ref = useRef<T | null>(null);
  const boxes = useRef(new Map<string, Box>());
  const elements = useRef(new Map<string, HTMLElement>());
  const committed = useRef(false);
  const running = useRef(new WeakMap<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) {
      // The container itself left the tree: its rows are gone with it, and the
      // next mount is a first commit again.
      committed.current = false;
      boxes.current = new Map();
      elements.current = new Map();
      return;
    }
    const frame = frameOf(container);
    const rows = rowsOf(container, attribute);
    const now = new Map<string, Box>();
    // Read once per row: the resting box that gets remembered, and the drift a
    // move already in flight is drawing it at, which never does.
    const drifts = new Map<HTMLElement, Drift>();
    for (const el of rows) {
      const key = el.getAttribute(attribute);
      if (!key) continue;
      const box = boxOf(el, frame);
      now.set(key, box);
      const drift = driftOf(el, box, frame);
      if (drift) drifts.set(el, drift);
    }

    const prev = boxes.current;
    const prevEls = elements.current;
    const firstCommit = !committed.current;
    committed.current = true;
    const canPlay = !firstCommit && !prefersReducedMotion() && typeof container.animate === 'function';

    if (canPlay) {
      const deltas = new Map<HTMLElement, { dx: number; dy: number }>();
      for (const el of rows) {
        const key = el.getAttribute(attribute)!;
        const from = prev.get(key);
        const to = now.get(key)!;
        if (!from) continue;
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (Math.abs(dx) >= LAYOUT_EPSILON_PX || Math.abs(dy) >= LAYOUT_EPSILON_PX) {
          deltas.set(el, { dx, dy });
        }
      }

      // Rows that left paint their own fall at the spot they occupied.
      const zIndex = stackingIndex(container);
      for (const [key, oldEl] of prevEls) {
        if (now.has(key)) continue;
        const box = prev.get(key);
        if (box) playDeparture(oldEl, box, frame, zIndex, exitStyle);
      }

      const spring = springTokens();
      const moveDuration = ms('--duration-move');
      const enterDuration = ms('--duration-slow');
      for (const el of rows) {
        const key = el.getAttribute(attribute)!;
        const delta = deltas.get(el);
        const ancestor = flipAncestor(el, container, attribute);
        if (!delta) {
          // A brand-new row fades and rises — unless the ancestor carrying it
          // is itself new or moving, in which case the parent's motion is the
          // row's motion.
          if (prev.has(key)) continue;
          if (ancestor && (deltas.has(ancestor) || !prev.has(ancestor.getAttribute(attribute)!))) {
            continue;
          }
          if (typeof el.animate !== 'function') continue;
          const own = el.hasAttribute(FLIP_OWN_ATTR);
          // Kept with the moves: an arrival is a transform on the row like any
          // other, so a reorder that lands on top of it must cancel and
          // retarget it rather than run a second transform against it.
          running.current.set(
            el,
            tag(
            el.animate(
              enterStyle === 'pop'
                ? [
                    { opacity: 0, transform: `scale(${own ? 0.6 : 0.8})` },
                    { opacity: 1, transform: 'scale(1)' },
                  ]
                : [
                    { opacity: 0, transform: `translate3d(0, ${enterDistance}px, 0)` },
                    { opacity: 1, transform: 'translate3d(0, 0, 0)' },
                  ],
              {
                duration: enterDuration,
                easing: springEasing(spring, { durationMs: enterDuration }),
                fill: 'backwards',
              },
            ),
            enterStyle === 'pop' ? 'pop' : 'enter',
            ),
          );
          // The emoji itself over-rotates ±8° on your own reaction — the row
          // lands and the mark inside it settles a beat behind (§5.1).
          if (enterStyle === 'pop' && own) {
            const glyph = el.querySelector<HTMLElement>(`[${FLIP_GLYPH_ATTR}]`);
            if (glyph && typeof glyph.animate === 'function') {
              tag(
                glyph.animate(
                  [{ transform: 'rotate(-8deg)' }, { transform: 'rotate(0deg)' }],
                  {
                    duration: enterDuration,
                    easing: springEasing(spring, { durationMs: enterDuration }),
                    fill: 'backwards',
                  },
                ),
                'pop',
              );
            }
          }
          continue;
        }
        // The ancestor moved the same way — the parent carries this row.
        const parentDelta = ancestor ? deltas.get(ancestor) : undefined;
        if (
          parentDelta
          && Math.abs(parentDelta.dx - delta.dx) < CARRIED_EPSILON_PX
          && Math.abs(parentDelta.dy - delta.dy) < CARRIED_EPSILON_PX
        ) {
          continue;
        }
        if (typeof el.animate !== 'function') continue;
        const prior = running.current.get(el);
        const { velocity } = sampleRunning(prior);
        // Retarget, never restart (§5.3). The row is being drawn `drift` away
        // from where layout has just put it, so the replacement starts from
        // there — the reorder it has to travel PLUS the part of the last move
        // it had not finished — and carries the velocity it had. Starting from
        // the bare layout delta would snap it back to the old row first.
        //
        // Only drift this engine put there: a press is `scale(.96)` and a hover
        // a 1px lift, and neither is a journey half-finished. And only the row's
        // OWN share of it — a rect is drawn through every transform above it, so
        // a row inside a section that is itself travelling reads its ancestor's
        // journey as well, and adding that here would compose the ancestor's
        // move into the row a second time.
        const drift = inFlight(prior) ? drifts.get(el) : undefined;
        const carried =
          ancestor && inFlight(running.current.get(ancestor)) ? drifts.get(ancestor) : undefined;
        prior?.cancel();
        const fromX = delta.dx + (drift?.dx ?? 0) - (carried?.dx ?? 0);
        const fromY = delta.dy + (drift?.dy ?? 0) - (carried?.dy ?? 0);
        running.current.set(
          el,
          tag(
            el.animate(
              [
                { transform: `translate3d(${fromX}px, ${fromY}px, 0)` },
                { transform: 'translate3d(0, 0, 0)' },
              ],
              {
                duration: moveDuration,
                easing: springEasing({ ...spring, velocity }, { durationMs: moveDuration }),
                fill: 'none',
              },
            ),
            'flip',
          ),
        );
      }
    }

    boxes.current = now;
    elements.current = new Map(rows.map((el) => [el.getAttribute(attribute)!, el]));
  });

  return ref;
}

/* -------------------------------------------------------------------------- */
/* The single-element version: a tab thumb, a chat sheet                      */
/* -------------------------------------------------------------------------- */

export interface FlipOptions {
  /** Animate the size delta as a scale on top of the travel. Default true. */
  scale?: boolean;
  /** Origin for the scale. Default 'left top'. */
  origin?: string;
  /** Override `--duration-move`. */
  duration?: number;
  /** The easing — defaults to the spring-settle curve. */
  easing?: string;
}

/**
 * Play a measured before/after pair back on one element, transform only.
 * Returns the animation so a caller can chain or cancel it.
 */
export function flipBetween(
  el: HTMLElement | null | undefined,
  first: DOMRect | null | undefined,
  last?: DOMRect,
  options: FlipOptions = {},
): Animation | null {
  if (!el || !first || typeof el.animate !== 'function') return null;
  const to = last ?? el.getBoundingClientRect();
  const dx = first.left - to.left;
  const dy = first.top - to.top;
  const sx = options.scale === false || to.width <= 0 ? 1 : first.width / to.width;
  const sy = options.scale === false || to.height <= 0 ? 1 : first.height / to.height;
  if (Math.abs(dx) < MOVED_EPSILON_PX && Math.abs(dy) < MOVED_EPSILON_PX && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) {
    return null;
  }
  const duration = options.duration ?? ms('--duration-move');
  const easing = options.easing ?? springEasing(springTokens(), { durationMs: duration });
  const origin = options.origin ?? 'left top';
  return tag(
    el.animate(
      [
        { transformOrigin: origin, transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
        { transformOrigin: origin, transform: 'translate3d(0, 0, 0) scale(1, 1)' },
      ],
      { duration, easing, fill: 'none' },
    ),
    'flip',
  );
}

/**
 * One element that re-lays itself out when `deps` change (the chat sheet's
 * height, a tab thumb's anchor): measure across the commit and play the delta
 * back on the spring. Never animates the first commit.
 */
export function useFlip<T extends HTMLElement = HTMLElement>(
  deps: readonly unknown[],
  options: FlipOptions = {},
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const previous = useRef<DOMRect | null>(null);
  const committed = useRef(false);
  const running = useRef<Animation | null>(null);
  const { scale, origin, duration, easing } = options;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      previous.current = null;
      committed.current = false;
      return;
    }
    const last = el.getBoundingClientRect();
    const first = previous.current;
    previous.current = last;
    const firstCommit = !committed.current;
    committed.current = true;
    if (firstCommit || !first || prefersReducedMotion()) return;
    const prior = running.current;
    const { velocity } = sampleRunning(prior);
    prior?.cancel();
    running.current = flipBetween(el, first, last, {
      scale,
      origin,
      duration,
      easing: easing ?? springEasing({ ...springTokens(), velocity }, { durationMs: duration ?? ms('--duration-move') }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

/* -------------------------------------------------------------------------- */
/* The sliding indicator — a tab pill that travels instead of jumping          */
/* -------------------------------------------------------------------------- */

/**
 * §5.1: "the thumb/indicator slides on the spring-settle — never a jump."
 * A `useFlip` almost covers this, but a tab indicator has two moving parts in
 * one commit — the mark under the selected child *and* the element that must
 * reach it — so the measure, the placement and the play live in one effect
 * here instead of racing each other.
 *
 * Mark the selected child `data-indicator-target`; attach the returned ref to
 * an absolutely-positioned span at the container's origin. The hook writes its
 * `transform`/`width`/`height` directly (no extra render), glides between
 * marks on `--duration-normal` spring-settle, carries velocity when the mark
 * jumps mid-travel, and lands silently on first paint and under reduced
 * motion. A `ResizeObserver` keeps it seated when the row reflows.
 */
export interface IndicatorOptions {
  /**
   * Cover the whole mark (default) or sit as a bar of this thickness along the
   * mark's bottom edge — the underline variant of a tab row.
   */
  thickness?: number;
  /** Horizontal inset for a bar, matching the mark's own padding. */
  insetX?: number;
}

export function useIndicator(
  containerRef: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
  options: IndicatorOptions = {},
): RefObject<HTMLSpanElement | null> {
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const mark = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const running = useRef<Animation | null>(null);
  const committed = useRef(false);

  const seat = useCallback(
    (animate: boolean) => {
      const container = containerRef.current;
      const indicator = indicatorRef.current;
      if (!container || !indicator) return;
      const target = container.querySelector<HTMLElement>('[data-indicator-target]');
      if (!target) {
        mark.current = null;
        indicator.style.opacity = '0';
        return;
      }
      const insetX = options.thickness != null ? (options.insetX ?? 0) : 0;
      const box = {
        left: target.offsetLeft + insetX,
        top:
          options.thickness != null
            ? target.offsetTop + target.offsetHeight - options.thickness
            : target.offsetTop,
        width: target.offsetWidth - insetX * 2,
        height: options.thickness ?? target.offsetHeight,
      };
      const first = mark.current;
      mark.current = box;
      indicator.style.opacity = '1';
      indicator.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`;
      indicator.style.width = `${box.width}px`;
      indicator.style.height = `${box.height}px`;
      if (!animate || !first || prefersReducedMotion() || typeof indicator.animate !== 'function') return;
      const prior = running.current;
      const { velocity } = sampleRunning(prior);
      prior?.cancel();
      const duration = ms('--duration-normal');
      running.current = tag(
        indicator.animate(
          [
            {
              transformOrigin: 'left top',
              transform: `translate3d(${first.left}px, ${first.top}px, 0) scale(${box.width > 0 ? first.width / box.width : 1}, ${box.height > 0 ? first.height / box.height : 1})`,
            },
            { transformOrigin: 'left top', transform: `translate3d(${box.left}px, ${box.top}px, 0) scale(1, 1)` },
          ],
          { duration, easing: springEasing({ ...springTokens(), velocity }, { durationMs: duration }), fill: 'backwards' },
        ),
        'indicator',
      );
    },
    [containerRef, options.thickness, options.insetX],
  );

  useLayoutEffect(() => {
    const firstCommit = !committed.current;
    committed.current = true;
    seat(!firstCommit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => seat(false));
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, seat]);

  return indicatorRef;
}
