import { useEffect, useState } from 'react';

// Tailwind md starts at 768px; the mobile overlays must stop below it.
export const DEFAULT_MOBILE_MAX_WIDTH = 768;

function buildMediaQuery(maxWidthPx: number): string {
  return `(width < ${maxWidthPx}px)`;
}

/**
 * Whether there is a viewport to ask. There is none when rendering outside a
 * browser, and jsdom has a `window` with no `matchMedia`; neither is a phone.
 */
function canMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function useMobile(maxWidthPx: number = DEFAULT_MOBILE_MAX_WIDTH): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (!canMatchMedia()) return false;
    return window.matchMedia(buildMediaQuery(maxWidthPx)).matches;
  });

  useEffect(() => {
    if (!canMatchMedia()) return;
    const mediaQuery = window.matchMedia(buildMediaQuery(maxWidthPx));
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, [maxWidthPx]);

  return isMobile;
}

