import { useEffect, type RefObject } from 'react';

/**
 * The chrome over a stream in theater and full screen (docs/index-spec.md
 * §7.7): the header, the controls and the filmstrip show while the pointer
 * moves (or a key or a tap asks for them) and go after {@link CHROME_IDLE_MS}
 * of stillness, the cursor with them.
 *
 * The state is an attribute on the call surface, `data-chrome`:
 *
 *   shown   on screen
 *   hidden  fading out ({@link CHROME_FADE_MS}, opacity and a 6px slide)
 *   gone    faded: `visibility: hidden`, so nothing of it is painted and nothing
 *           runs at rest; the cursor is hidden over the stream
 *
 * Written straight to the element, never through React: a pointer move
 * restarts one timer, it never renders. One timer at most, and none once the
 * chrome is gone. (A timer per move, not a timestamp: no clock is read, so a
 * pinned page clock in the e2e harness cannot freeze it either.) The chrome stays while the pointer is on it, while a menu or popover
 * it opened is up, or while the keyboard is on one of its controls.
 */

/** Stillness before the chrome goes, ms. */
export const CHROME_IDLE_MS = 2000;
/** The chrome's fade, ms: `--duration-normal` (ix-call.css). */
export const CHROME_FADE_MS = 80;

/** The parts of the surface that are chrome. */
const ZONES = '.ix-call-head, .ix-call-controls, .ix-call-strip, .ix-call-chat';
/**
 * What the pointer resting on keeps the chrome up: a control in it, or the
 * chat column. Not the bars' scrims: a pointer parked at the screen's edge
 * must not hold the chrome over the stream forever.
 */
const HOLDS = 'button, a, input, select, textarea, [role="button"], .ix-call-tile, .ix-call-chat';
/** A layer the chrome opened (a menu, the stream's sound and quality). */
const LAYERS = '[role="menu"], [role="dialog"], [data-stream-overlay-portal]';

export type ChromeState = 'shown' | 'hidden' | 'gone';

/**
 * Whether something keeps the chrome up. Whether the pointer is on it is hit
 * tested where the pointer last moved to, now: neither `:hover` nor the last
 * event's target, both of which a browser can leave stale when the layout
 * changed under a still pointer (going full screen does exactly that).
 */
function held(surface: HTMLElement, x: number, y: number): boolean {
  if (Number.isFinite(x) && Number.isFinite(y) && typeof document.elementFromPoint === 'function') {
    const at = document.elementFromPoint(x, y);
    const control = at && surface.contains(at) ? at.closest(HOLDS) : null;
    if (control?.closest(ZONES)) return true;
  }
  for (const zone of surface.querySelectorAll<HTMLElement>(ZONES)) {
    if (zone.querySelector(':focus-visible')) return true;
  }
  if (surface.querySelector('[aria-expanded="true"]')) return true;
  for (const layer of document.querySelectorAll<HTMLElement>(LAYERS)) {
    if (layer.getClientRects().length > 0) return true;
  }
  return false;
}

export function useIdleChrome(surfaceRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (!enabled) {
      delete surface.dataset.chrome;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastX = Number.NaN;
    let lastY = Number.NaN;

    const set = (state: ChromeState) => {
      if (surface.dataset.chrome !== state) surface.dataset.chrome = state;
    };
    const wait = (ms: number, then: () => void) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        then();
      }, ms);
    };
    const check = () => {
      if (held(surface, lastX, lastY)) {
        wait(CHROME_IDLE_MS, check);
        return;
      }
      set('hidden');
      wait(CHROME_FADE_MS, () => set('gone'));
    };
    const show = () => {
      set('shown');
      wait(CHROME_IDLE_MS, check);
    };
    const onMove = (event: PointerEvent) => {
      // Some systems repeat a move without moving; only real movement wakes the chrome.
      if (event.clientX === lastX && event.clientY === lastY) return;
      lastX = event.clientX;
      lastY = event.clientY;
      show();
    };

    const onLeave = () => {
      lastX = Number.NaN;
      lastY = Number.NaN;
    };
    surface.addEventListener('pointermove', onMove, { passive: true });
    surface.addEventListener('pointerleave', onLeave);
    surface.addEventListener('pointerdown', show, { passive: true });
    surface.addEventListener('keydown', show);
    surface.addEventListener('focusin', show);
    // Coming in, the chrome is there to be seen, then goes.
    show();

    return () => {
      if (timer) clearTimeout(timer);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerleave', onLeave);
      surface.removeEventListener('pointerdown', show);
      surface.removeEventListener('keydown', show);
      surface.removeEventListener('focusin', show);
      delete surface.dataset.chrome;
    };
  }, [surfaceRef, enabled]);
}
