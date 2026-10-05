import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { IX_EASE, IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from '../motion';

/** The indicator glides to the new item in 165ms on the spring (§5.1). */
export const INDICATOR_GLIDE_MS = 165;
/** The indicator is 16 wide (§3.1), so its left edge is 8 left of an item's center. */
const HALF_WIDTH = 8;

function itemFor(dock: HTMLElement, key: string): HTMLElement | null {
  for (const item of dock.querySelectorAll<HTMLElement>('[data-dock-item]')) {
    if (item.dataset.place === key) return item;
  }
  return null;
}

/** Where the bar's left edge belongs, in the dock's coordinates, and whether its item is in view. */
function measureBar(dock: HTMLElement, scroller: HTMLElement | null, key: string): { x: number; visible: boolean } | null {
  const item = itemFor(dock, key);
  if (!item) return null;
  const box = item.getBoundingClientRect();
  const frame = dock.getBoundingClientRect();
  const center = box.left + box.width / 2;
  let visible = true;
  if (scroller?.contains(item)) {
    const view = scroller.getBoundingClientRect();
    visible = center >= view.left && center <= view.right;
  }
  return { x: center - frame.left - HALF_WIDTH, visible };
}

/** The bar's resting state: where it is and whether it is shown. */
function paintBar(bar: HTMLElement, x: number | null, visible: boolean): void {
  if (x !== null) bar.style.transform = `translateX(${x}px)`;
  bar.style.opacity = visible ? '1' : '0';
}

/** The glide: one Web Animation on the bar from where it was to where it is (it rests at the end). */
function glideBar(bar: HTMLElement, from: number, to: number): Animation | null {
  if (!canAnimate(bar)) return null;
  if (ixReduced()) {
    return bar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IX_REDUCED_MS, easing: IX_EASE, id: 'ix-dock:indicator' });
  }
  return bar.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
    duration: INDICATOR_GLIDE_MS,
    easing: IX_SPRING,
    id: 'ix-dock:indicator',
  });
}

/**
 * The one indicator (§4.8): a 16x3 bar under the current place that glides to
 * the new one when the place changes and otherwise stays glued to its item.
 *
 * It lives in the dock, not in the servers' scroller, so it can glide between
 * People (fixed, left of the scroller) and a server; its x is measured from the
 * item's rect. It follows the item while the scroller scrolls (no glide, one
 * write per frame) and is hidden while its item is scrolled out of view. The
 * current server is scrolled into view when the place changes, before the glide
 * is measured, so the bar travels to where the item will be.
 *
 * One Web Animation (`ix-dock:indicator`, transform, 165ms spring) from where
 * the bar was to where it is; reduced motion lands it with a 65ms fade.
 *
 * Returns the three elements to attach: the dock's root, the servers' scroller
 * and the bar. (`currentKey` is the current place's key, or null when it is not
 * in the dock; `layoutKey` changes whenever items move without a place change.)
 */
export function useDockIndicator(currentKey: string | null, layoutKey: string) {
  const dock = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);

  const lastX = useRef<number | null>(null);
  const lastKey = useRef<string | null>(null);
  const shown = useRef<boolean | null>(null);
  const glide = useRef<Animation | null>(null);
  const frame = useRef(0);

  const place = useCallback(
    (animate: boolean) => {
      const bar = indicator.current;
      const root = dock.current;
      if (!bar || !root) return;
      const target = currentKey === null ? null : measureBar(root, scroller.current, currentKey);
      if (!target) {
        if (shown.current !== false) paintBar(bar, null, false);
        shown.current = false;
        lastX.current = null;
        return;
      }
      const from = lastX.current;
      const moved = from === null || Math.abs(target.x - from) > 0.5;
      const wasShown = shown.current === true;
      if (!moved && wasShown === target.visible) return;
      lastX.current = target.x;
      shown.current = target.visible;
      paintBar(bar, target.x, target.visible);
      if (animate && moved && wasShown && target.visible && from !== null) {
        glide.current?.cancel();
        glide.current = glideBar(bar, from, target.x);
      }
    },
    [currentKey],
  );

  // A new current place: bring it into view first, then glide the bar to where it ended up.
  useLayoutEffect(() => {
    const root = dock.current;
    if (root && currentKey !== null && lastKey.current !== currentKey) {
      const item = itemFor(root, currentKey);
      if (item && scroller.current?.contains(item) && typeof item.scrollIntoView === 'function') {
        item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    place(lastKey.current !== null && lastKey.current !== currentKey);
    lastKey.current = currentKey;
  }, [currentKey, layoutKey, place]);

  // Stay under the item while the scroller scrolls and while anything resizes.
  useEffect(() => {
    const view = scroller.current;
    const root = dock.current;
    if (!root) return;
    const follow = () => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        place(false);
      });
    };
    view?.addEventListener('scroll', follow, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(follow);
      observer.observe(root);
    }
    return () => {
      view?.removeEventListener('scroll', follow);
      observer?.disconnect();
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [place]);

  useEffect(
    () => () => {
      glide.current?.cancel();
    },
    [],
  );

  return { dock, scroller, indicator };
}
