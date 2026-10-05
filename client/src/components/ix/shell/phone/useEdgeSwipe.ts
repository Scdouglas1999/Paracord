import { useEffect, useRef } from 'react';

import { clearPush, paintPush, playPhoneScreens, playPush, shadeOf, type PushLayers } from '../../../glass/shell/phoneMotion';
import { showScreenSettled } from '../../../glass/shell/phoneNav';
import { canAnimate } from '../../motion';
import { useToolbarStore } from '../toolbarStore';
import { activeScreen, skipNextSheetPop } from './pushedSheets';

/**
 * The phone's back gesture (docs/index-spec.md §9 "Edge swipe or the back
 * chevron returns"; IX-16): a finger that starts at the left edge and moves
 * right drags the page in front off to the right, with the screen beneath
 * following from -30% and brightening, exactly as iOS does. Let go past half
 * way, or flick, and the page goes; otherwise it springs back.
 *
 * What is in front decides what the finger drags:
 *
 *   1. a sheet (a pushed full-screen page, `.ix-sheet[data-host="window"]`):
 *      the sheet over the screen beneath; letting it go closes the sheet;
 *   2. main, pushed over the sidebar: main over the sidebar; letting it go
 *      shows the root (`showScreenSettled`, so the frame does not replay it);
 *   3. a page pushed inside main by the route (a thread, a forum post): it
 *      cannot follow the finger (the page before it is not mounted), so a
 *      swipe past the threshold runs its back (`onBack`), like the chevron.
 *
 * Whatever owns the edge keeps it: a field, an element marked `data-no-swipe`,
 * a sideways scroller that is scrolled, a dialog or a menu. The gesture only
 * claims the touch once it is clearly sideways; a vertical drag stays a scroll.
 * `enabled` turns the listeners off (not a phone, the call sheet, settings).
 */

/** The zone at the left edge a swipe must start in, px. */
export const EDGE_ZONE = 24;
/** Travel before the gesture decides it is sideways, px. */
const SLOP = 8;
/** A release faster than this (px/ms) to the right finishes the move. */
const FLICK = 0.45;
/** A non-interactive back (case 3) needs this much travel, px. */
const BACK_THRESHOLD = 60;

type Target =
  | { kind: 'sheet'; layers: PushLayers; dismiss: HTMLElement | null; sheet: HTMLElement }
  | { kind: 'screen'; layers: PushLayers }
  | { kind: 'route'; onBack: () => void };

function claimsTheEdge(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], [data-no-swipe]')) return true;
  if (target.closest('[role="menu"], [role="alertdialog"], [role="dialog"]:not(.ix-sheet), .ix-call-sheet')) return true;
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollLeft > 0 && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

/** The topmost pushed sheet on a phone that is not already leaving. */
function topSheet(): HTMLElement | null {
  const sheets = document.querySelectorAll<HTMLElement>('.ix-sheet[data-host="window"]:not(.is-leaving)');
  return sheets.length > 0 ? sheets[sheets.length - 1] : null;
}

function findTarget(): Target | null {
  // A menu (an action sheet) or a dialog is in front: the edge is theirs.
  if (document.querySelector('.ix-menu, .ix-action-sheet, [role="dialog"][aria-modal="true"]:not(.ix-sheet), .ix-switcher')) return null;
  const sheet = topSheet();
  if (sheet) {
    // A page pushed inside the sheet (its own back chevron): back is that page's.
    const pageBack = sheet.querySelector<HTMLElement>('.ix-sheet__back:not([data-ix-sheet-dismiss])');
    if (pageBack) return { kind: 'route', onBack: () => pageBack.click() };
    const under = activeScreen();
    return {
      kind: 'sheet',
      sheet,
      layers: { top: sheet, under, shade: shadeOf(under) },
      dismiss: sheet.querySelector<HTMLElement>('[data-ix-sheet-dismiss]') ?? sheet.querySelector<HTMLElement>('.ix-sheet__close'),
    };
  }
  const frame = document.querySelector<HTMLElement>(".ix-frame[data-layout='phone']");
  if (!frame || frame.dataset.screen !== 'conversation' || frame.dataset.stage !== 'none') return null;
  const onBack = useToolbarStore.getState().page?.onBack;
  if (onBack) return { kind: 'route', onBack };
  const side = frame.querySelector<HTMLElement>(':scope > .ix-side');
  const main = frame.querySelector<HTMLElement>(':scope > .ix-main');
  if (!side || !main) return null;
  return { kind: 'screen', layers: { top: main, under: side, shade: shadeOf(side) } };
}

/** Stop any push still playing on these layers: the finger takes them from where they are. */
function interrupt(layers: PushLayers): void {
  for (const el of [layers.top, layers.under, layers.shade]) {
    if (!el || !canAnimate(el) || typeof el.getAnimations !== 'function') continue;
    for (const animation of el.getAnimations()) {
      if (animation.id.startsWith('ix-phone')) animation.cancel();
    }
  }
}

/** Should a release at `x` moving at `velocity` (px/ms, + is right) finish the move? */
export function releaseFinishes(x: number, velocity: number): boolean {
  if (velocity > FLICK) return true;
  if (velocity < -FLICK) return false;
  return x > 0.5;
}

export function useEdgeSwipe(enabled: boolean): void {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    let tracking = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let width = 1;
    let target: Target | null = null;
    let samples: Array<{ x: number; t: number }> = [];
    /** Where the finger has the top page now (0 pushed, 1 gone). */
    let x = 0;

    const reset = () => {
      tracking = false;
      dragging = false;
      target = null;
      samples = [];
      x = 0;
    };

    const onStart = (event: TouchEvent) => {
      reset();
      if (!enabledRef.current || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch || touch.clientX > EDGE_ZONE) return;
      if (claimsTheEdge(event.target)) return;
      target = findTarget();
      if (!target) return;
      tracking = true;
      startX = touch.clientX;
      startY = touch.clientY;
      width = Math.max(1, window.innerWidth);
      samples = [{ x: touch.clientX, t: event.timeStamp }];
    };

    const onMove = (event: TouchEvent) => {
      if (!tracking || !target) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        cancel();
        return;
      }
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) {
          // A scroll, not a swipe: let it go.
          reset();
          return;
        }
        if (dx < SLOP) return;
        dragging = true;
        if (target.kind !== 'route') interrupt(target.layers);
      }
      // The swipe is the finger's now: no scroll, no text selection under it.
      if (event.cancelable) event.preventDefault();
      samples.push({ x: touch.clientX, t: event.timeStamp });
      if (samples.length > 5) samples.shift();
      x = Math.min(1, Math.max(0, dx / width));
      if (target.kind !== 'route') paintPush(target.layers, x);
    };

    const velocity = (): number => {
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      // Samples from one frame say nothing about speed.
      return dt >= 8 ? (last.x - first.x) / dt : 0;
    };

    /** A second finger or the system took the touch: the page goes back where it was. */
    const cancel = () => {
      if (dragging && target && target.kind !== 'route') {
        clearPush(target.layers);
        playPush(target.layers, x, 0, { id: 'ix-phone' });
      }
      reset();
    };

    const onEnd = (event: TouchEvent) => {
      if (!tracking || !target) return;
      const touch = event.changedTouches[0];
      const dx = touch ? touch.clientX - startX : 0;
      if (!dragging) {
        reset();
        return;
      }
      const at = Math.min(1, Math.max(0, dx / width));
      const v = velocity();
      const done = target;
      reset();

      if (done.kind === 'route') {
        if (dx >= BACK_THRESHOLD || v > FLICK) done.onBack();
        return;
      }
      const finish = releaseFinishes(at, v);
      clearPush(done.layers);
      if (!finish) {
        playPush(done.layers, at, 0, { id: 'ix-phone' });
        return;
      }
      if (done.kind === 'screen') {
        playPhoneScreens(done.layers.under, done.layers.top, 'places', at);
        showScreenSettled('places');
        return;
      }
      // A sheet: it leaves from where the finger let it go; its own leave and
      // the covered screen's are already drawn by this move.
      playPush(done.layers, at, 1, { id: 'ix-phone' });
      done.sheet.setAttribute('data-ix-dismissed', '');
      skipNextSheetPop();
      done.dismiss?.click();
    };

    const onCancel = () => cancel();

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
      if (target && dragging && target.kind !== 'route') clearPush(target.layers);
    };
  }, [enabled]);
}
