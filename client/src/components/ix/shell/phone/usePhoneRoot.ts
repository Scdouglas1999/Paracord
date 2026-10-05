import { useEffect, useLayoutEffect } from 'react';

/**
 * What a phone tells the whole document (docs/index-spec.md §9; IX-16).
 *
 *   `<html data-ix-layout="phone">`  sheets, menus and the switcher render in a
 *        portal on `<body>`, outside the frame, and read the layout from here
 *        (ix-phone.css). Removed when the window stops being a phone.
 *
 *   `--ix-vv-top`, `--ix-keyboard` and `<html data-ix-keyboard>`  the
 *        on-screen keyboard. A phone browser (and the iOS web view) leaves the
 *        layout viewport alone when the keyboard opens and shrinks only the
 *        visual one, so a message box at the foot of a fixed frame ends up
 *        behind the keyboard. The visual viewport says what is still visible:
 *        main is laid out to it (`top: var(--ix-vv-top)`, `bottom:
 *        var(--ix-keyboard)`), so the box sits on the keyboard and the end of
 *        the conversation stays in view. Where the browser resizes the layout
 *        itself (Android's `resizes-content`), the inset is 0 and nothing
 *        changes. No transition: the keyboard is the motion.
 */

/** Less than this is a toolbar or rounding, not a keyboard (px). */
export const KEYBOARD_MIN = 80;

export interface KeyboardInset {
  /** How far the visible area starts below the layout viewport's top (px). */
  top: number;
  /** How much of the layout viewport's foot is covered (px). */
  bottom: number;
}

/** The keyboard's inset from a layout height and the visual viewport. */
export function keyboardInset(layoutHeight: number, viewport: { height: number; offsetTop: number } | null): KeyboardInset {
  if (!viewport) return { top: 0, bottom: 0 };
  const top = Math.max(0, Math.round(viewport.offsetTop));
  const bottom = Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop));
  return bottom < KEYBOARD_MIN ? { top: 0, bottom: 0 } : { top, bottom };
}

/**
 * How near its end a timeline counts as read to the end: the timeline's own
 * "near the bottom" (MessageList follows new messages within 140px), and the
 * message box opening on focus has just taken some of that.
 */
const NEAR_END = 160;

/** The timelines in main that are read to their end. */
function feedsAtEnd(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('main [role="feed"]')].filter(
    (feed) => feed.scrollHeight - feed.scrollTop - feed.clientHeight <= NEAR_END,
  );
}

export function usePhoneRoot(phone: boolean): void {
  useLayoutEffect(() => {
    if (!phone || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    root.setAttribute('data-ix-layout', 'phone');
    return () => root.removeAttribute('data-ix-layout');
  }, [phone]);

  useEffect(() => {
    if (!phone || typeof window === 'undefined') return undefined;
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const root = document.documentElement;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const inset = keyboardInset(window.innerHeight, viewport);
      const opening = inset.bottom > 0 && root.getAttribute('data-ix-keyboard') !== 'open';
      const closing = inset.bottom === 0 && root.getAttribute('data-ix-keyboard') === 'open';
      // A conversation read to its end stays at its end when main shrinks or grows.
      const atEnd = opening || closing ? feedsAtEnd() : [];
      if (inset.bottom > 0) {
        root.style.setProperty('--ix-keyboard', `${inset.bottom}px`);
        root.style.setProperty('--ix-vv-top', `${inset.top}px`);
        root.setAttribute('data-ix-keyboard', 'open');
      } else {
        root.style.removeProperty('--ix-keyboard');
        root.style.removeProperty('--ix-vv-top');
        root.removeAttribute('data-ix-keyboard');
      }
      for (const feed of atEnd) feed.scrollTop = feed.scrollHeight;
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    apply();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      root.style.removeProperty('--ix-keyboard');
      root.style.removeProperty('--ix-vv-top');
      root.removeAttribute('data-ix-keyboard');
    };
  }, [phone]);
}
