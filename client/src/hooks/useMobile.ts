import { useEffect, useState } from 'react';

export const DEFAULT_MOBILE_MAX_WIDTH = 768;

function buildMediaQuery(maxWidthPx: number): string {
  return `(max-width: ${maxWidthPx}px)`;
}

export function useMobile(maxWidthPx: number = DEFAULT_MOBILE_MAX_WIDTH): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(buildMediaQuery(maxWidthPx)).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia(buildMediaQuery(maxWidthPx));
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, [maxWidthPx]);

  return isMobile;
}

