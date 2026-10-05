import { IX_EASE, IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced, invertTransform, type RectLike } from '../motion';

/**
 * The card's moments (docs/index-spec.md §5.4, §5.5, §5.7). Web Animations on
 * `transform` and `opacity` only, each with an id (`ix-card:<part>`) so the
 * motion gate can find it, none filling forwards on an element that stays
 * mounted. Reduced motion turns every move into a 150ms fade, or into nothing
 * for content that was merely pushed.
 *
 *   enter        the card or a person row arrives: translateY(-8px) scale(.97),
 *                opacity 0 -> none (card 600ms, row 500ms, spring)
 *   leave        the card or a row goes: the reverse (card 300ms, row 250ms, ease)
 *   push         content displaced by a card or row arriving or going: a
 *                translateY FLIP (600ms down, 450ms up, spring)
 *   fly          your face from the toolbar avatar into your row, a ghost on
 *                the document so the sidebar does not clip it (750ms spring);
 *                the card's new content holds at 0 until 45% then fades in
 *   pin          your call card between "above the header" and "under the
 *                search" (550ms spring, translate only)
 */

export const CARD_IN_MS = 600;
/**
 * The card waits this long while what it pushes makes room (IX-18). The card is
 * translucent: entering on the same beat as the 600ms push, the rows still
 * sliding down showed through it for the first frames (the prototype does not
 * push at all, so never had them under it). By 120ms the spring has moved the
 * rows two thirds of the way.
 */
export const CARD_IN_DELAY_MS = 120;
export const CARD_OUT_MS = 300;
export const ROW_IN_MS = 500;
export const ROW_OUT_MS = 250;
export const PUSH_DOWN_MS = 600;
export const PUSH_UP_MS = 450;
export const FLY_MS = 750;
export const PIN_MS = 550;
/** The yours layer (stronger tint, edge and glow) fades in (CSS transition, ix-card.css). */
export const YOURS_FADE_MS = 400;

const ARRIVE = 'translateY(-8px) scale(0.97)';

function fade(element: HTMLElement, from: number, to: number, id: string, fill: FillMode = 'none'): Animation {
  const animation = element.animate([{ opacity: from }, { opacity: to }], { duration: IX_REDUCED_MS, easing: 'ease-out', fill });
  animation.id = id;
  return animation;
}

/** The card (600ms) or a person row (500ms) arriving. */
export function playEnter(element: HTMLElement | null, kind: 'card' | 'row'): Animation | null {
  if (!canAnimate(element)) return null;
  const id = `ix-card:${kind}-in`;
  if (ixReduced()) return fade(element, 0, 1, id);
  const animation = element.animate(
    [
      { opacity: 0, transform: ARRIVE },
      { opacity: 1, transform: 'none' },
    ],
    kind === 'card'
      ? { duration: CARD_IN_MS, delay: CARD_IN_DELAY_MS, easing: IX_SPRING, fill: 'backwards' }
      : { duration: ROW_IN_MS, easing: IX_SPRING },
  );
  animation.id = id;
  return animation;
}

/**
 * The card (300ms) or a row (250ms) going: it fills forwards, because the caller
 * removes the element when it settles (it never stays mounted at rest).
 */
export function playLeave(element: HTMLElement | null, kind: 'card' | 'row'): Animation | null {
  if (!canAnimate(element)) return null;
  const id = `ix-card:${kind}-out`;
  if (ixReduced()) return fade(element, 1, 0, id, 'forwards');
  const animation = element.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: kind === 'card' ? ARRIVE : 'scale(0.97)' },
    ],
    { duration: kind === 'card' ? CARD_OUT_MS : ROW_OUT_MS, easing: IX_EASE, fill: 'forwards' },
  );
  animation.id = id;
  return animation;
}

/**
 * Content that a card or row pushed by `dy` px (positive: it moved down) plays
 * back from where it was. Reduced motion: nothing (it was only displaced).
 */
export function playPush(elements: readonly Element[], dy: number, duration = dy > 0 ? PUSH_DOWN_MS : PUSH_UP_MS): Animation[] {
  if (ixReduced() || Math.abs(dy) < 0.5) return [];
  const played: Animation[] = [];
  for (const element of elements) {
    if (!canAnimate(element)) continue;
    const animation = element.animate([{ transform: `translateY(${-dy}px)` }, { transform: 'none' }], {
      duration,
      easing: IX_SPRING,
    });
    animation.id = 'ix-card:push';
    played.push(animation);
  }
  return played;
}

/** Stop at the sidebar's pane (inline) or the sidebar itself (pinned). */
const PUSH_BOUNDARY = '.ix-pane, .ix-side';
/** Never moved: the dock sits at the sidebar's foot, the tint layers fill it. */
const NEVER_PUSHED = '.ix-side__dock, [data-ix-tint]';

/**
 * What sits below `element` in the sidebar: its following siblings, then its
 * parent's, up to the pane (or the sidebar). That is what a card arriving
 * pushes down.
 */
export function contentBelow(element: Element | null): Element[] {
  const below: Element[] = [];
  let node: Element | null = element;
  while (node && !node.matches(PUSH_BOUNDARY)) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (!next.matches(NEVER_PUSHED)) below.push(next);
    }
    node = node.parentElement;
  }
  return below;
}

/** Inside a sidebar pane that is sliding out (it renders the old place for 450ms). */
export function inLeavingPane(element: Element | null): boolean {
  return Boolean(element?.closest('[data-leaving]'));
}

/* ---- Your face flies in (§5.7) -------------------------------------------- */

/**
 * A copy of `source` drawn on the document at `rect` (fixed, above everything,
 * no pointer events): something that must travel across surfaces that clip
 * (the sidebar pane, the sidebar).
 */
function ghostAt(source: HTMLElement, rect: RectLike): HTMLElement {
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-ix-ghost', '');
  ghost.style.cssText = [
    'position: fixed',
    `left: ${rect.left}px`,
    `top: ${rect.top}px`,
    `width: ${rect.width}px`,
    `height: ${rect.height}px`,
    'margin: 0',
    'z-index: 60',
    'pointer-events: none',
  ].join(';');
  document.body.appendChild(ghost);
  return ghost;
}

export interface FlightResult {
  animations: Animation[];
  /** Puts everything back (removes the ghost, shows the real face). Idempotent. */
  done: () => void;
}

/**
 * Your face flies from the toolbar's avatar (`from`) into its row (`face`, now
 * laid out at its place), translate and one scale, 750ms spring, above the
 * other rows. `holds` (your name) wait at opacity 0 until 45% and fade in. Reduced motion: they fade in over 150ms, nothing flies.
 */
export function playFlight(face: HTMLElement | null, from: RectLike | null, holds: readonly HTMLElement[]): FlightResult {
  const animations: Animation[] = [];
  const reduced = ixReduced();
  for (const element of holds) {
    if (!canAnimate(element)) continue;
    const animation = reduced
      ? fade(element, 0, 1, 'ix-card:fly-hold')
      : element.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: FLY_MS, easing: 'linear' });
    animation.id = 'ix-card:fly-hold';
    animations.push(animation);
  }
  if (reduced || !face || !from || !canAnimate(face) || typeof document === 'undefined') {
    if (face && canAnimate(face) && reduced) animations.push(fade(face, 0, 1, 'ix-card:fly'));
    return { animations, done: () => {} };
  }
  const to = face.getBoundingClientRect();
  const transform = invertTransform(from, to, 'uniform');
  if (!transform) return { animations, done: () => {} };
  const ghost = ghostAt(face, to);
  face.style.visibility = 'hidden';
  const flight = ghost.animate(
    [
      { transform, transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' },
    ],
    { duration: FLY_MS, easing: IX_SPRING },
  );
  flight.id = 'ix-card:fly';
  animations.push(flight);
  let finished = false;
  return {
    animations,
    done: () => {
      if (finished) return;
      finished = true;
      ghost.remove();
      face.style.visibility = '';
    },
  };
}

/* ---- Your card between its two places (§5.4) ------------------------------ */

/**
 * Pinned to inline: the pinned card is gone from the DOM by the time the inline
 * one lays out (the panes slide in beneath), so its copy travels on the
 * document to the inline card's place, and the inline card shows when it lands.
 */
export function playPinGhost(snapshot: { clone: HTMLElement; rect: RectLike }, target: HTMLElement): FlightResult {
  if (ixReduced() || !canAnimate(target) || typeof document === 'undefined') {
    const animation = canAnimate(target) ? fade(target, 0, 1, 'ix-card:pin') : null;
    return { animations: animation ? [animation] : [], done: () => {} };
  }
  const to = target.getBoundingClientRect();
  const transform = invertTransform(snapshot.rect, to, 'none');
  if (!transform) return { animations: [], done: () => {} };
  const ghost = snapshot.clone;
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-ix-ghost', '');
  ghost.removeAttribute('data-testid');
  ghost.style.cssText = [
    'position: fixed',
    `left: ${to.left}px`,
    `top: ${to.top}px`,
    `width: ${to.width}px`,
    'margin: 0',
    'z-index: 6',
    'pointer-events: none',
  ].join(';');
  document.body.appendChild(ghost);
  target.style.opacity = '0';
  const move = ghost.animate([{ transform }, { transform: 'none' }], { duration: PIN_MS, easing: IX_SPRING });
  move.id = 'ix-card:pin';
  let finished = false;
  return {
    animations: [move],
    done: () => {
      if (finished) return;
      finished = true;
      ghost.remove();
      target.style.opacity = '';
    },
  };
}

/** Inline to pinned: the pinned card is outside the slide, so it moves itself. */
export function playPinMove(card: HTMLElement | null, from: RectLike | null): Animation | null {
  if (!from || !canAnimate(card)) return null;
  if (ixReduced()) return fade(card, 0, 1, 'ix-card:pin');
  const transform = invertTransform(from, card.getBoundingClientRect(), 'none');
  if (!transform) return null;
  const animation = card.animate([{ transform }, { transform: 'none' }], { duration: PIN_MS, easing: IX_SPRING });
  animation.id = 'ix-card:pin';
  return animation;
}

/* ---- The last place your card was drawn --------------------------------------- */

interface YoursSnapshot {
  key: string;
  position: 'pinned' | 'inline';
  rect: DOMRect;
  clone: HTMLElement;
  at: number;
}

let lastYours: YoursSnapshot | null = null;

/** How long a snapshot stands for "the card that just went" (one commit, generously). */
const SNAPSHOT_FRESH_MS = 250;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Your card is unmounting: remember where it was and what it looked like. */
export function rememberYours(key: string, position: 'pinned' | 'inline', element: HTMLElement | null): void {
  if (!element || !element.isConnected) return;
  const clone = element.cloneNode(true) as HTMLElement;
  lastYours = { key, position, rect: element.getBoundingClientRect(), clone, at: clock() };
}

/** The card for `key` that just left `position`, if it left a moment ago. Taken once. */
export function takeYours(key: string, position: 'pinned' | 'inline'): YoursSnapshot | null {
  const snapshot = lastYours;
  if (!snapshot || snapshot.key !== key || snapshot.position !== position) return null;
  lastYours = null;
  return clock() - snapshot.at <= SNAPSHOT_FRESH_MS ? snapshot : null;
}
