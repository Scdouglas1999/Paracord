import { RELAX_MS, ghostLayer, relax } from './animate';
import { captureFlip, type FlipCapture } from './flip';
import { prefersReducedMotion } from './reducedMotion';
import { motionToken } from './tokens';

/**
 * The send flight — a message floating out of the message box into the
 * conversation (docs/glass-spec.md §9, "a protected signature gesture").
 *
 * The words you typed leave the composer on an arc and become your bubble on
 * the way: x and y run on different curves, so the path bends (up first, then
 * across), with a 3px overshoot on the way in. The conversation makes room
 * underneath them, the composer gives one small press, the send control
 * releases. Everything is Web Animations on ONE flying element (and the rows
 * that make room): transform and opacity, plus the one color change that lets
 * the words pick up the bubble early so they never lose contrast.
 *
 * **This is the one gesture the quiet motion system (§5.2: "4–8px, nothing
 * slides across the screen, no overshoot, 500ms ceiling") does not govern.**
 * The owner named it their favorite animation in the product and asked for it
 * back after the motion pass clamped it to an 8px lift; the constants below are
 * the approved prototype's, `sendFlight.test.ts` pins them, and the clamp is
 * not to be reintroduced. Every other recipe keeps its ceilings.
 *
 * Two halves, one object:
 *
 *   - the **ghost** (this file) is a bubble the engine owns in the fixed ghost
 *     layer. It has to be a ghost: the timeline is a clipped, masked scroller
 *     and the words start in the composer, outside it.
 *   - the **row** it lands on is a real row of the timeline, held invisible
 *     until the ghost arrives and revealed in the same task the ghost is
 *     removed (`useSendFlight.ts`). Same position, no double, no flicker.
 *
 * Nothing here waits for the server: the flight is a function of the keystroke.
 */

/** The approved prototype's numbers (a documented exception to §5.2). */
export const SEND_FLIGHT = {
  /** The whole flight. */
  duration: 620,
  /** x: slow to leave, then across. */
  easeX: 'cubic-bezier(0.3, 0.05, 0.2, 1)',
  /** y and scale: up fast, settling. The overshoot below is in progress, not time. */
  easeY: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** Everything already in the conversation gliding up to make room. */
  glide: 'cubic-bezier(0.32, 0.72, 0, 1)',
  /** The glide ends this much before the flight does. */
  glideTrim: 60,
  fromScale: 0.95,
  overshoot: { y: -3, scale: 1.01, at: 0.7 },
  /** The words become the bubble between these two offsets. */
  fillFrom: 0.14,
  fillTo: 0.22,
  /** The airborne shadow holds until here, then settles away. */
  shadowHold: 0.4,
  /** The send control releasing from the cream "on" look to the quiet one. */
  releaseMs: 420,
  /** A bubble that is not where the flight aimed (scrolled, resized) is walked there. */
  correctMs: 140,
  /** A bubble let go of before it landed (the send failed). */
  retireMs: 160,
} as const;

/** The composer's press is `relax` (scale .992 and back, `RELAX_MS`). */
export { RELAX_MS };

/** Where the words sit in the composer: everything the ghost needs to start there. */
export interface SendOrigin {
  /** The text box, in viewport pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Where the first glyph starts, measured from `left`. */
  inset: number;
  /** The words' color as the composer paints them. */
  color: string;
}

/** Read where the words sit. Null where there is nothing to fly from. */
export function readSendOrigin(textarea: HTMLElement | null | undefined): SendOrigin | null {
  if (!textarea || prefersReducedMotion()) return null;
  const box = textarea.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const style = getComputedStyle(textarea);
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    inset: Number.parseFloat(style.paddingLeft) || 0,
    color: style.color,
  };
}

export interface FlightOptions {
  /** What was typed, as typed. */
  text: string;
  origin: SendOrigin;
  /**
   * The bubble to land on: a real, invisible row of the timeline. Asked for
   * again when the flight arrives, because React may have replaced the node
   * (the pending row becoming the delivered one).
   */
  bubble: () => HTMLElement | null;
  /**
   * The ghost is leaving: reveal the real row. Called synchronously, in the
   * same task the ghost is removed, so the two changes paint together.
   */
  onLand: () => void;
}

export interface Flight {
  /** True from takeoff until the ghost has landed or been let go. */
  readonly airborne: boolean;
  /** Land now — a second send, an unmount, a channel change. Reveals the row. */
  land(): void;
  /** Let go of it: freeze where it is and fade away. Does not reveal anything. */
  retire(): void;
}

/** The properties that make a text layer read like the bubble it lands in. */
const TYPE_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontVariationSettings',
  'lineHeight',
  'letterSpacing',
] as const;

const CORNERS = [
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
] as const;

/**
 * A picture of the reply chip a bubble carries, set where the chip sits, inside
 * the same inks the bubble gives it (`.glass-msg[data-own] .glass-bubble`).
 */
function replyChip(target: HTMLElement, to: DOMRect): HTMLElement | null {
  const source = target.querySelector<HTMLElement>('.glass-tl-reply');
  if (!source) return null;
  const box = source.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const holder = document.createElement('div');
  holder.className = 'glass-msg glass-flight__chip';
  holder.setAttribute('data-own', '');
  holder.setAttribute('inert', '');
  holder.style.left = `${box.left - to.left}px`;
  holder.style.top = `${box.top - to.top}px`;
  holder.style.width = `${box.width}px`;
  const inks = document.createElement('div');
  inks.className = 'glass-bubble';
  const copy = source.cloneNode(true) as HTMLElement;
  copy.style.margin = '0';
  inks.append(copy);
  holder.append(inks);
  holder.style.opacity = '0';
  return holder;
}

function layer(className: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  return node;
}

/**
 * Take off. Returns null when there is nothing to do (reduced motion, no
 * layer, no bubble to land on, no animation engine) — the caller then reveals
 * the row at once, and the send is the plain "text clears, row appears".
 */
export function flySend({ text, origin, bubble, onLand }: FlightOptions): Flight | null {
  if (prefersReducedMotion()) return null;
  const target = bubble();
  const host = ghostLayer();
  if (!target || !host || typeof host.animate !== 'function') return null;
  const to = target.getBoundingClientRect();
  if (to.width === 0 && to.height === 0) return null;

  const look = getComputedStyle(target);
  // A reply's chip sits above the words: the words land where the bubble's own
  // text is, not at its top-left corner.
  const wordsBox = (target.querySelector<HTMLElement>('.glass-bubble__text') ?? target).getBoundingClientRect();

  // The ghost: a mover (x) around a body (y and scale) around three layers.
  const shell = document.createElement('div');
  shell.className = 'glass-flight';
  shell.setAttribute('aria-hidden', 'true');
  shell.style.left = `${to.left}px`;
  shell.style.top = `${to.top}px`;
  shell.style.width = `${to.width}px`;
  shell.style.height = `${to.height}px`;
  const body = layer('glass-flight__body');
  const shadow = layer('glass-flight__shadow');
  const fill = layer('glass-flight__fill');
  const words = layer('glass-flight__words');
  for (const corner of CORNERS) {
    shadow.style[corner] = look[corner];
    fill.style[corner] = look[corner];
  }
  words.textContent = text;
  words.style.left = `${wordsBox.left - to.left}px`;
  words.style.top = `${wordsBox.top - to.top}px`;
  words.style.width = `${wordsBox.width}px`;
  for (const prop of TYPE_PROPS) words.style[prop] = look[prop];
  words.style.color = origin.color;
  // Scale about the words' own left edge, so the first glyph does not slide
  // when the flight takes off: it leaves exactly where it was typed.
  body.style.transformOrigin = `${wordsBox.left - to.left}px 50%`;
  body.append(shadow, fill, words);
  // A reply carries the chip of what it answers inside its bubble: the ghost
  // carries a picture of it, so the delivered row does not grow a chip at the
  // swap. It comes in with the fill, like everything that is not the plain words.
  const chip = replyChip(target, to);
  if (chip) body.append(chip);
  shell.append(body);
  host.append(shell);

  // Where it starts: the words' own left edge on the composer's, the bubble's
  // middle on the box's middle (so a tall draft leaves from its own height).
  let aim = { left: to.left, top: to.top };
  let startX = origin.left + origin.inset - wordsBox.left;
  let startY = origin.top + origin.height / 2 - (to.top + to.height / 2);
  const { duration, overshoot } = SEND_FLIGHT;
  const play = (el: HTMLElement, keyframes: Keyframe[], easing: string) => {
    const animation = el.animate(keyframes, { duration, easing, fill: 'both' });
    animation.id = 'data-motion-recipe:send-flight';
    return animation;
  };
  // x on its own curve: slow to leave, then across.
  const xFrames = () => [
    { transform: `translate3d(${startX}px, 0, 0)` },
    { transform: 'translate3d(0, 0, 0)' },
  ];
  // y and scale on another, with the 3px overshoot at 70% of the progress.
  const yFrames = () => [
    { transform: `translate3d(0, ${startY}px, 0) scale(${SEND_FLIGHT.fromScale})`, offset: 0 },
    { transform: `translate3d(0, ${overshoot.y}px, 0) scale(${overshoot.scale})`, offset: overshoot.at },
    { transform: 'translate3d(0, 0, 0) scale(1)', offset: 1 },
  ];
  const fillWindow = [SEND_FLIGHT.fillFrom, SEND_FLIGHT.fillTo] as const;
  const mover = play(shell, xFrames(), SEND_FLIGHT.easeX);
  const lifter = play(body, yFrames(), SEND_FLIGHT.easeY);
  const animations = [
    mover,
    lifter,
    // The words pick up the bubble early, so they never lose contrast in flight.
    play(
      fill,
      [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: fillWindow[0] },
        { opacity: 1, offset: fillWindow[1] },
        { opacity: 1, offset: 1 },
      ],
      'linear',
    ),
    play(
      words,
      [
        { color: origin.color, offset: 0 },
        { color: origin.color, offset: fillWindow[0] },
        { color: look.color, offset: fillWindow[1] },
        { color: look.color, offset: 1 },
      ],
      'linear',
    ),
    ...(chip
      ? [
          play(
            chip,
            [
              { opacity: 0, offset: 0 },
              { opacity: 0, offset: fillWindow[0] },
              { opacity: 1, offset: fillWindow[1] },
              { opacity: 1, offset: 1 },
            ],
            'linear',
          ),
        ]
      : []),
    // A soft shadow while airborne that settles away as it lands.
    play(
      shadow,
      [
        { opacity: 0, offset: 0 },
        { opacity: 1, offset: fillWindow[1] },
        { opacity: 1, offset: SEND_FLIGHT.shadowHold },
        { opacity: 0, offset: 1 },
      ],
      'linear',
    ),
  ];

  let state: 'air' | 'done' = 'air';
  let sweep = 0;
  let tracker = 0;
  const finish = () => {
    if (state === 'done') return;
    state = 'done';
    window.clearTimeout(sweep);
    if (tracker) cancelAnimationFrame(tracker);
    onLand();
    shell.remove();
  };

  /**
   * Follow the row. Its mark moves while the bubble is in the air — the
   * virtualizer measures the real row after the first layout, another message
   * arrives above it, the composer closes up, the window is resized — and a
   * bubble that lands where the row WAS is a bubble that jumps at the swap. So
   * the flight keeps its start exactly where the words were and re-aims its
   * end at wherever the row is now: the path bends a few pixels, never a jump.
   */
  const reaim = () => {
    const now = bubble()?.getBoundingClientRect();
    if (!now || (now.width === 0 && now.height === 0)) return;
    const dx = now.left - aim.left;
    const dy = now.top - aim.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    aim = { left: now.left, top: now.top };
    shell.style.left = `${now.left}px`;
    shell.style.top = `${now.top}px`;
    startX -= dx;
    startY -= dy;
    for (const [animation, frames] of [[mover, xFrames], [lifter, yFrames]] as const) {
      const effect = animation.effect as KeyframeEffect | null;
      if (effect && typeof effect.setKeyframes === 'function') effect.setKeyframes(frames());
    }
  };
  const track = () => {
    if (state !== 'air') return;
    reaim();
    tracker = requestAnimationFrame(track);
  };
  if (typeof requestAnimationFrame === 'function') tracker = requestAnimationFrame(track);

  const arrive = () => {
    if (state === 'done') return;
    // Anything the tracking has not caught: walk the ghost to the row, so the
    // swap never jumps.
    const now = bubble()?.getBoundingClientRect();
    const dx = now ? now.left - aim.left : 0;
    const dy = now ? now.top - aim.top : 0;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      finish();
      return;
    }
    const walk = shell.animate(
      [{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${dx}px, ${dy}px, 0)` }],
      { duration: SEND_FLIGHT.correctMs, easing: motionToken('--ease-out'), fill: 'forwards' },
    );
    walk.id = 'data-motion-recipe:send-flight';
    walk.finished.then(finish, finish);
  };

  // Landed when the longest of them is: they share one duration.
  lifter.finished.then(arrive, () => {
    // Canceled from outside (the element left the document): nothing to land.
  });
  // A belt-and-braces sweep: an animation on a detached element can lose its
  // events, and a ghost that outlives its moment is litter.
  sweep = window.setTimeout(finish, duration + 1_500);

  return {
    get airborne() {
      return state === 'air';
    },
    land() {
      if (state === 'done') return;
      for (const animation of animations) animation.cancel();
      finish();
    },
    retire() {
      if (state === 'done') return;
      state = 'done';
      window.clearTimeout(sweep);
      if (tracker) cancelAnimationFrame(tracker);
      // Freeze it where it is, then let it go.
      for (const animation of animations) animation.pause();
      const fade = shell.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: SEND_FLIGHT.retireMs,
        easing: motionToken('--ease-in'),
        fill: 'forwards',
      });
      fade.id = 'data-motion-recipe:send-flight';
      const remove = () => shell.remove();
      fade.finished.then(remove, remove);
      window.setTimeout(remove, SEND_FLIGHT.retireMs + 1_500);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Making room                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Measure the rows now (before the pending row exists); `play()` after the
 * render glides each from where it was to where it is, on transform alone —
 * the conversation making room underneath the words rather than jumping.
 */
export function captureRoom(rows: Iterable<Element | null | undefined>): FlipCapture {
  return captureFlip(rows);
}

/** Play the capture on the flight's own curve, ending a beat before it lands. */
export function makeRoom(capture: FlipCapture): Animation[] {
  return capture.play({
    duration: SEND_FLIGHT.duration - SEND_FLIGHT.glideTrim,
    easing: SEND_FLIGHT.glide,
    id: 'data-motion-recipe:send-room',
  });
}

/* -------------------------------------------------------------------------- */
/* The composer and the send control                                           */
/* -------------------------------------------------------------------------- */

/** The composer's tiny press: scale .992 and back over 300ms. */
export function pressComposer(capsule: Element | null | undefined): Animation | null {
  return relax(capsule);
}

/**
 * The send control releasing once: from the cream "on" look it is wearing to
 * the quiet one it is about to settle into, over 420ms. Colors only, and only
 * on the control; the target colors are read from its own tokens, never typed
 * here.
 */
export function releaseSend(button: HTMLElement | null | undefined): Animation | null {
  if (!button || typeof button.animate !== 'function' || prefersReducedMotion()) return null;
  const style = getComputedStyle(button);
  const quiet = style.getPropertyValue('--glass-fill-quiet').trim();
  const ink = style.getPropertyValue('--ink-1').trim();
  if (!quiet || !ink) return null;
  const release = button.animate(
    [
      { backgroundColor: style.backgroundColor, color: style.color },
      { backgroundColor: quiet, color: ink },
    ],
    { duration: SEND_FLIGHT.releaseMs, easing: motionToken('--ease-out'), fill: 'none' },
  );
  release.id = 'data-motion-recipe:send-release';
  return release;
}
