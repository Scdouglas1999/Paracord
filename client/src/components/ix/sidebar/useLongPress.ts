import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

/**
 * The row's menu on touch (docs/index-spec.md §4.5: "the row's long-press on
 * touch"). A finger held on a row for half a second opens its menu where it
 * touched; moving more than a few pixels is a scroll, not a press; and the click
 * that follows a press that opened a menu is swallowed so it does not also open
 * the row. A mouse and a pen are not touch: they right-click.
 *
 * Chromium raises `contextmenu` for a long touch by itself and WebKit on iOS does
 * not; asking for the press here makes both behave alike (opening a menu twice at
 * one point is the same menu).
 */

export const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

export interface PressPoint {
  x: number;
  y: number;
}

/** A menu opener takes a mouse event; a long press has only a point, which is all a menu reads of it. */
export function pointEvent(point: PressPoint): MouseEvent<HTMLElement> {
  return { clientX: point.x, clientY: point.y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as MouseEvent<HTMLElement>;
}

export function useLongPress(onPress: (point: PressPoint) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<PressPoint | null>(null);
  const fired = useRef(false);
  const latest = useRef(onPress);
  useEffect(() => {
    latest.current = onPress;
  });

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch') return;
      fired.current = false;
      const point = { x: event.clientX, y: event.clientY };
      origin.current = point;
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        latest.current(point);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (timer.current === null || !start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
