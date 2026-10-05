import { cubicBezier } from '../../../lib/motion/cubicBezier';
import { isTauri } from '../../../lib/tauriEnv';
import { beginNativeMove } from '../../glass/stage/nativeUnderlay';
import { IX_REDUCED_MS, IX_SPRING, canAnimate, invertTransform, ixReduced, type RectLike } from '../motion';

/**
 * The call view's moves (docs/index-spec.md §5.8, §5.9, §7.6).
 *
 *   open     the surface grows out of the room card: translate + non-uniform
 *            scale from the card's rect (origin 0 0), opacity .3 -> 1, 185ms
 *            spring. Its content sits in a counter-layer that undoes the scale
 *            and only fades, from 40% of the move.
 *   theater  the surface FLIPs from main's inset to the window's (or back),
 *            185ms spring; the content keeps its new size in the counter-layer
 *            while the surface grows around it.
 *   close    Back to chat: a still copy of the surface shrinks back into the
 *            card, 135ms spring, its content fading in the first third, then
 *            it is gone. The real view unmounts at once, so every video it
 *            subscribed stops when the close starts (§7.3).
 *
 * Every move is transform and opacity only, with ids `ix-call:*`; nothing fills
 * forwards on anything that stays. Reduced motion: a 65ms fade in place.
 *
 * NATIVE VIDEO (§7.6, docs/glass-spec.md §6.6). In the desktop app each video
 * is a platform surface under the webview that follows its tile only when the
 * tile reports a settled box. For the length of a move `beginCallMove()`:
 *   - lays a transparent shield over the window (`data-native-shield`): every
 *     native tile reads it as an occluder, closes its hole and shows its
 *     poster (the latest still, in its own canvas), still decoding;
 *   - marks the page as moving (`beginNativeMove`, `html[data-native-moving]`):
 *     the page's bottom turns opaque in the ground color and posters show at
 *     once, and the call surface keeps its own fill (ix-call.css), so nothing
 *     beneath the surface and no surface below the webview shows mid-move.
 * When the move settles the shield goes and each tile reveals its surface at
 * the settled box once the native side confirms a frame is drawn there. On
 * the web there are no native surfaces, and none of this runs.
 */

export const CALL_OPEN_MS = 185;
export const CALL_THEATER_MS = 185;
export const CALL_CLOSE_MS = 135;
/** Open: the content holds at 0 until this share of the move, then fades in. */
export const CALL_CONTENT_FROM = 0.4;
/**
 * … and is whole by this share (IX-18, held against the prototype, whose tiles
 * are drawn from the start of the grow: a fade that took the whole rest of the
 * move left the view half-empty when the surface had already arrived).
 */
export const CALL_CONTENT_TO = 0.75;
/** Close: the copy's content is gone by this share of the move. */
export const CALL_CONTENT_OUT = 0.3;

const SPRING = cubicBezier(0.32, 0.72, 0, 1);
/** Keyframes a counter-layer samples the spring at (linear between them). */
const SAMPLES = 16;

/* ---- The native guard ----------------------------------------------------------- */

/**
 * A move begins: until the returned function runs, native video is covered
 * (shield + opaque ground + posters). Idempotent end. A no-op off the desktop.
 */
export function beginCallMove(): () => void {
  if (!isTauri() || typeof document === 'undefined') return () => {};
  const shield = document.createElement('div');
  shield.className = 'ix-call-shield';
  shield.setAttribute('aria-hidden', 'true');
  // Native tiles read this as an occluder (nativeVideoTile.ts, isUnderlayOccluder).
  // Not `data-native-overlay-occlude`: layout.css paints those solid.
  shield.setAttribute('data-native-shield', '');
  document.body.appendChild(shield);
  const endNative = beginNativeMove();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    shield.remove();
    endNative();
  };
}

/* ---- Counter-layers ------------------------------------------------------------- */

/**
 * Keyframes that undo a parent's scale from `from` to `to` (origin 0 0) as the
 * parent plays it on the spring, so the child keeps its own size. The parent
 * interpolates `scale(s)` linearly in eased progress p; the child carries
 * `scale(1/s(p))` at each sample, linear between samples. `fadeFrom` makes the
 * child hold at opacity 0 until that share of the move, then fade in, whole by
 * `fadeTo` (default: the end of the move).
 */
export function counterKeyframes(from: RectLike, to: RectLike, fadeFrom?: number, fadeTo = 1): Keyframe[] {
  const sx0 = to.width > 0 ? from.width / to.width : 1;
  const sy0 = to.height > 0 ? from.height / to.height : 1;
  const frames: Keyframe[] = [];
  // The samples, plus the fade's own start when it falls between two of them:
  // "holds at 0 until 40%" (§5.8) means exactly 40%, not the sample before it.
  const offsets = Array.from({ length: SAMPLES + 1 }, (_, i) => i / SAMPLES);
  for (const edge of fadeFrom === undefined ? [] : [fadeFrom, fadeTo]) {
    if (edge > 0 && edge < 1 && !offsets.includes(edge)) offsets.push(edge);
  }
  offsets.sort((a, b) => a - b);
  for (const t of offsets) {
    const p = SPRING(t);
    const sx = sx0 + (1 - sx0) * p;
    const sy = sy0 + (1 - sy0) * p;
    const frame: Keyframe = {
      offset: t,
      transform: `scale(${round(1 / sx)}, ${round(1 / sy)})`,
      transformOrigin: '0 0',
    };
    if (fadeFrom !== undefined) frame.opacity = t <= fadeFrom ? 0 : t >= fadeTo ? 1 : round((t - fadeFrom) / (fadeTo - fadeFrom));
    frames.push(frame);
  }
  frames[frames.length - 1].transform = 'none';
  return frames;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function scaledAbout(rect: RectLike, factor: number): RectLike {
  const width = rect.width * factor;
  const height = rect.height * factor;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

/* ---- Open and theater ----------------------------------------------------------- */

/**
 * Grow `surface` out of `origin` (the room card's rect), or, with no card on
 * screen, from 96% of itself, fading in. `content` is the counter-layer.
 */
export function playOpen(surface: HTMLElement, content: HTMLElement | null, origin: RectLike | null): Animation[] {
  if (!canAnimate(surface) || !surface.isConnected) return [];
  const to = surface.getBoundingClientRect();
  if (ixReduced()) {
    const fade = surface.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IX_REDUCED_MS, easing: 'ease-out' });
    fade.id = 'ix-call:open';
    return [fade];
  }
  const from = origin ?? scaledAbout(to, 0.96);
  const transform = invertTransform(from, to, 'xy') ?? 'none';
  const grow = surface.animate(
    [
      { transform, transformOrigin: '0 0', opacity: origin ? 0.3 : 0 },
      { transform: 'none', transformOrigin: '0 0', opacity: 1 },
    ],
    { duration: CALL_OPEN_MS, easing: IX_SPRING },
  );
  grow.id = 'ix-call:open';
  const played = [grow];
  if (canAnimate(content)) {
    const counter = content.animate(counterKeyframes(from, to, CALL_CONTENT_FROM, CALL_CONTENT_TO), { duration: CALL_OPEN_MS, easing: 'linear' });
    counter.id = 'ix-call:open-content';
    played.push(counter);
  }
  return played;
}

/** T: the surface FLIPs from where it was (`from`) to where the host now puts it. */
export function playTheater(surface: HTMLElement, content: HTMLElement | null, from: RectLike | null): Animation[] {
  if (!from || !canAnimate(surface) || !surface.isConnected) return [];
  const to = surface.getBoundingClientRect();
  if (ixReduced()) {
    const fade = surface.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IX_REDUCED_MS, easing: 'ease-out' });
    fade.id = 'ix-call:theater';
    return [fade];
  }
  const transform = invertTransform(from, to, 'xy');
  if (!transform) return [];
  const move = surface.animate(
    [
      { transform, transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' },
    ],
    { duration: CALL_THEATER_MS, easing: IX_SPRING },
  );
  move.id = 'ix-call:theater';
  const played = [move];
  if (canAnimate(content)) {
    const counter = content.animate(counterKeyframes(from, to), { duration: CALL_THEATER_MS, easing: 'linear' });
    counter.id = 'ix-call:theater-content';
    played.push(counter);
  }
  return played;
}

/* ---- Close ---------------------------------------------------------------------- */

/** A still copy of the surface, placed exactly over it in a fixed layer on the page. */
export function ghostOf(surface: HTMLElement): HTMLElement {
  const rect = surface.getBoundingClientRect();
  const ghost = surface.cloneNode(true) as HTMLElement;
  // A picture of the view, not the view: nothing in it can be reached, named,
  // found by a test, or taken for a native surface's hole.
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  ghost.removeAttribute('aria-label');
  ghost.removeAttribute('role');
  // `data-underlay` too: a tile whose hole was open would copy as a clear box
  // with a hidden canvas, and show the page beneath it for the whole shrink.
  const strip = ['id', 'data-testid', 'data-native-surface-boundary', 'data-native-underlay-clear', 'data-motion-speaking', 'data-underlay'];
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
    for (const name of strip) node.removeAttribute(name);
  }
  // A canvas clones blank: copy what it shows (a poster, a 2D frame; a WebGL
  // canvas may copy blank, and the copy's content fades in the first third).
  const from = surface.querySelectorAll('canvas');
  const to = ghost.querySelectorAll('canvas');
  from.forEach((canvas, index) => {
    const copy = to[index];
    if (!copy || canvas.width === 0 || canvas.height === 0) return;
    // A native tile's canvas is hidden while its hole is open, but it holds the
    // tile's poster (the latest still): the copy shows it.
    if (canvas.dataset.poster === 'true') {
      copy.style.visibility = 'visible';
      copy.style.opacity = '1';
    }
    try {
      copy.getContext('2d')?.drawImage(canvas, 0, 0);
    } catch {
      /* a lost or tainted context: the copy stays blank */
    }
  });
  ghost.classList.add('ix-call-ghost');
  const style = ghost.style;
  style.position = 'fixed';
  style.left = `${rect.left}px`;
  style.top = `${rect.top}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  style.right = 'auto';
  style.bottom = 'auto';
  style.margin = '0';
  style.transform = 'none';
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Back to chat: shrink `ghost` (from `ghostOf`) into `target` (the card's
 * rect), or, with no card, to 96% of itself, fading. Removes the ghost when the
 * move settles and calls `done`.
 */
export function playClose(ghost: HTMLElement, target: RectLike | null, done: () => void): Animation[] {
  const finish = () => {
    ghost.remove();
    done();
  };
  if (!canAnimate(ghost)) {
    finish();
    return [];
  }
  const from = ghost.getBoundingClientRect();
  let played: Animation[];
  if (ixReduced()) {
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: IX_REDUCED_MS, easing: 'ease-out', fill: 'forwards' });
    fade.id = 'ix-call:close';
    played = [fade];
  } else {
    const to = target ?? scaledAbout(from, 0.96);
    const transform = invertTransform(to, from, 'xy') ?? 'none';
    const shrink = ghost.animate(
      [
        { transform: 'none', transformOrigin: '0 0', opacity: 1 },
        { transform, transformOrigin: '0 0', opacity: target ? 0.3 : 0 },
      ],
      // The ghost is removed on settle; filling keeps its last frame until then.
      { duration: CALL_CLOSE_MS, easing: IX_SPRING, fill: 'forwards' },
    );
    shrink.id = 'ix-call:close';
    played = [shrink];
    const inner = ghost.firstElementChild;
    if (canAnimate(inner)) {
      const fade = inner.animate(
        [{ opacity: 1 }, { opacity: 0, offset: CALL_CONTENT_OUT }, { opacity: 0 }],
        { duration: CALL_CLOSE_MS, easing: 'linear', fill: 'forwards' },
      );
      fade.id = 'ix-call:close-content';
      played.push(fade);
    }
  }
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    finish();
  };
  void Promise.allSettled(played.map((animation) => animation.finished)).then(settle);
  // A hidden window stops the animation clock; the copy still goes.
  setTimeout(settle, (ixReduced() ? IX_REDUCED_MS : CALL_CLOSE_MS) + 500);
  return played;
}

/* ---- Where the call came from ----------------------------------------------------- */

/**
 * The room card the view grows out of (and returns to): your call's card for
 * this channel, else any card for it, in the sidebar's settled pane (not one
 * sliding out). Null when no card for the channel is on screen.
 */
export function findCallCard(channelId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const suffix = `:${channelId}`;
  const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="ix-room-card"][data-card-key]')].filter(
    (card) =>
      card.dataset.cardKey?.endsWith(suffix) &&
      !card.closest('[data-leaving]') &&
      card.dataset.exiting !== 'true',
  );
  const visible = cards.filter((card) => {
    const rect = card.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return visible.find((card) => card.hasAttribute('data-ix-call-card')) ?? visible[0] ?? null;
}
