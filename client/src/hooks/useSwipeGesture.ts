import { useEffect, useRef } from 'react';

interface SwipeHandlers {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

const SWIPE_THRESHOLD = 60; // px — minimum travel distance
const SWIPE_MAX_Y = 80; // px — max vertical drift to still count as horizontal
const EDGE_ZONE = 32; // px — swipe must start within this edge zone

/**
 * Lightweight touch-swipe detection for mobile navigation.
 *
 * - Swipe right from left edge → open channel sidebar
 * - Swipe left from right edge → open member list
 *
 * Attaches to `element` (defaults to document). Ignores swipes on scrollable
 * containers or range inputs to avoid conflicts.
 */
export function useSwipeGesture(handlers: SwipeHandlers, enabled = true) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;

      // Only start tracking on edge swipes
      const vw = window.innerWidth;
      const fromLeft = touch.clientX < EDGE_ZONE;
      const fromRight = touch.clientX > vw - EDGE_ZONE;
      if (!fromLeft && !fromRight) return;

      // Don't intercept swipes on scrollable or interactive elements
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (target.closest('[data-no-swipe]')) return;

      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
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

      if (dx > 0 && startX < EDGE_ZONE) {
        handlersRef.current.onSwipeRight?.();
      } else if (dx < 0 && startX > window.innerWidth - EDGE_ZONE) {
        handlersRef.current.onSwipeLeft?.();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [enabled]);
}
