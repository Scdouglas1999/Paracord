import { useEffect, useRef } from 'react';

interface SwipeHandlers {
  /** A swipe toward the left edge, begun at the right edge. */
  onSwipeLeft?: () => void;
  /** A swipe toward the right edge, begun at the left edge: "back" on a phone. */
  onSwipeRight?: () => void;
}

export const SWIPE_THRESHOLD = 60; // px, minimum travel distance
export const SWIPE_MAX_Y = 80; // px, max vertical drift to still count as horizontal
export const SWIPE_EDGE_ZONE = 32; // px, the swipe must start within this edge zone

/**
 * Something the swipe must leave alone: a field (the caret and the selection
 * handles use horizontal drags), an element that opted out, or a scroller that
 * has been scrolled sideways, where the drag belongs to the scroller.
 */
function claimsTheDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], [data-no-swipe]')) return true;
  for (let node: Element | null = target; node; node = node.parentElement) {
    // A scroller with room to scroll back is still in use; at its start it is not.
    if (node.scrollLeft > 0 && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

/**
 * Edge swipes for a phone (docs/glass-spec.md §8, WP-G20).
 *
 * - Swipe right from the left edge: `onSwipeRight`. The shell uses it to go
 *   back from a conversation to places, the way a platform's back gesture does.
 * - Swipe left from the right edge: `onSwipeLeft`.
 *
 * It listens on the document and only starts a swipe that begins inside the edge
 * zone with one finger, so scrolling, pinching and the text caret are never
 * taken. A swipe ends when the finger lifts: long enough (`SWIPE_THRESHOLD`) and
 * not too far off the horizontal (`SWIPE_MAX_Y`). A drag that turns vertical, a
 * second finger, or the system taking the touch (`touchcancel`) drops it.
 *
 * `enabled` turns the listeners off entirely, so the shell can leave the gesture
 * to a surface that owns the edge (a dialog, a sheet, full screen).
 */
export function useSwipeGesture(handlers: SwipeHandlers, enabled = true) {
  const handlersRef = useRef(handlers);
  // The newest handlers, without re-registering the listeners on every render.
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onTouchStart = (e: TouchEvent) => {
      tracking = false;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (!touch) return;

      const fromLeft = touch.clientX < SWIPE_EDGE_ZONE;
      const fromRight = touch.clientX > window.innerWidth - SWIPE_EDGE_ZONE;
      if (!fromLeft && !fromRight) return;
      if (claimsTheDrag(e.target)) return;

      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || Math.abs(touch.clientY - startY) > SWIPE_MAX_Y) tracking = false;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;

      const touch = e.changedTouches[0];
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);

      if (dy > SWIPE_MAX_Y) return; // too much vertical movement
      if (Math.abs(dx) < SWIPE_THRESHOLD) return; // too short

      if (dx > 0 && startX < SWIPE_EDGE_ZONE) {
        handlersRef.current.onSwipeRight?.();
      } else if (dx < 0 && startX > window.innerWidth - SWIPE_EDGE_ZONE) {
        handlersRef.current.onSwipeLeft?.();
      }
    };

    const onTouchCancel = () => {
      tracking = false;
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [enabled]);
}
