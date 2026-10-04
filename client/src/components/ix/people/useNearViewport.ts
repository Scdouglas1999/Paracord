import { useEffect, useState, type RefObject } from 'react';

/**
 * True once the element has come within `margin` px of the viewport, and then for
 * good. A list of two hundred conversations asks for the previews of the few on
 * screen, not all of them at once; the rest ask as they are scrolled near. Where
 * there is no `IntersectionObserver` (a test, an old engine) every element counts
 * as near, so a row is never left without its line.
 */
export function useNearViewport(ref: RefObject<Element | null>, margin = 240): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: `${margin}px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref, margin]);
  return near;
}
