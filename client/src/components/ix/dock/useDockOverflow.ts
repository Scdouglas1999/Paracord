import { useEffect, useState, type RefObject } from 'react';

export interface DockFade {
  /** Servers are scrolled out past the start edge. */
  start: boolean;
  /** Servers are scrolled out past the end edge. */
  end: boolean;
}

const NO_FADE: DockFade = { start: false, end: false };

/** The scroller's overflow: whether either edge has more beyond it (a hair of slack for subpixels). */
export function fadeOf(scroller: Pick<HTMLElement, 'scrollLeft' | 'clientWidth' | 'scrollWidth'>): DockFade {
  return {
    start: scroller.scrollLeft > 1,
    end: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
  };
}

/**
 * Overflow of the servers (§4.8): "the dock scrolls horizontally (wheel vertical
 * maps to horizontal, no visible scrollbar) with 16px static edge fades". The
 * fades are a mask drawn by CSS from `data-fade-start` / `data-fade-end`; this
 * measures which edge has more beyond it, and turns a vertical wheel over the
 * servers into a horizontal scroll (only while they overflow, so a dock that
 * fits never swallows the wheel).
 *
 * `count` re-measures when servers come and go.
 */
export function useDockOverflow(scroller: RefObject<HTMLElement | null>, count: number): DockFade {
  const [fade, setFade] = useState<DockFade>(NO_FADE);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const next = fadeOf(element);
      setFade((previous) => (previous.start === next.start && previous.end === next.end ? previous : next));
    };
    // The first measure waits for the frame: layout has settled by then, and a
    // server joining or leaving moves the end without resizing the scroller.
    const first = requestAnimationFrame(measure);
    element.addEventListener('scroll', measure, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    }
    return () => {
      cancelAnimationFrame(first);
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [scroller, count]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (element.scrollWidth <= element.clientWidth + 1) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      element.scrollLeft += event.deltaY * unit;
      event.preventDefault();
    };
    // Not React's onWheel: that listener is passive and cannot cancel the page's scroll.
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [scroller]);

  return fade;
}
