import { playPush, shadeOf, type PushLayers } from '../../../glass/shell/phoneMotion';

/**
 * Sheets on a phone are pushed pages (docs/index-spec.md §9 "Sheets (people,
 * search, channel pages) are pushed full-screen pages"; IX-16).
 *
 * A sheet slides in from the right over the full screen (its own CSS
 * animation, ix-phone.css); the screen it covers (main, or the sidebar on the
 * root) moves 30% left beneath it and dims, exactly as main does over the
 * sidebar. This module keeps that screen's side of the move: while any phone
 * sheet is open `<html data-ix-pushed>` holds the covered screen at its
 * resting -30% (CSS), and the moves in and out are played here.
 *
 * `SheetFrame` calls `pushSheet()` for as long as a sheet is open on a phone;
 * the returned function is the sheet's close.
 */

let open = 0;
let skipNextPop = false;
let running: Animation[] = [];
/** A pop waiting one frame: a sheet replaced by another (people -> search) is no pop at all. */
let pendingPop: number | null = null;

/** The screen in front of the phone frame: what a sheet covers. */
export function activeScreen(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(".ix-frame[data-layout='phone'] > [data-active]");
}

function coveredLayers(): PushLayers {
  const under = activeScreen();
  return { top: null, under, shade: shadeOf(under) };
}

function settleRunning(): void {
  for (const animation of running) animation.cancel();
  running = [];
}

function schedule(run: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(run);
  return setTimeout(run, 16) as unknown as number;
}

function unschedule(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  clearTimeout(handle);
}

/** A phone sheet opened: hold the screen beneath back, and play it there. Returns the close. */
export function pushSheet(): () => void {
  if (typeof document === 'undefined') return () => {};
  open += 1;
  if (open === 1) {
    if (pendingPop !== null) {
      // The last sheet closed this very frame and this one replaces it: the
      // screen beneath simply stays where it is.
      unschedule(pendingPop);
      pendingPop = null;
      skipNextPop = false;
    } else {
      settleRunning();
      document.documentElement.setAttribute('data-ix-pushed', 'sheet');
      running = playPush(coveredLayers(), 1, 0, { id: 'ix-phone-sheet' });
    }
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    open = Math.max(0, open - 1);
    if (open > 0) return;
    if (pendingPop !== null) unschedule(pendingPop);
    pendingPop = schedule(() => {
      pendingPop = null;
      if (open > 0) return;
      settleRunning();
      document.documentElement.removeAttribute('data-ix-pushed');
      if (skipNextPop) {
        skipNextPop = false;
        return;
      }
      running = playPush(coveredLayers(), 0, 1, { id: 'ix-phone-sheet' });
    });
  };
}

/** The edge swipe has already moved the covered screen back: the next close plays nothing. */
export function skipNextSheetPop(): void {
  skipNextPop = true;
}

/** Tests: forget every open sheet. */
export function resetPushedSheetsForTests(): void {
  open = 0;
  if (pendingPop !== null) unschedule(pendingPop);
  pendingPop = null;
  skipNextPop = false;
  settleRunning();
  if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-ix-pushed');
}
