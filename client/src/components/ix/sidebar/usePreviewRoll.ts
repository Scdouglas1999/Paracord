import { useLayoutEffect, useRef } from 'react';

import { IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from '../motion';

/**
 * A channel's last line changes (docs/index-spec.md §5.3): the new line rolls up
 * from `translateY(9px)` and fades in, 520ms spring, and the time fades in over
 * 400ms. Returns the refs of the line and the time, in that order. Plays for a row that already had a line and now has a different one: not
 * when previews first arrive (there was no line before), not in a pane that is
 * sliding out, never at rest. Reduced motion: a 150ms fade, no travel.
 */

export const PREVIEW_ROLL_MS = 520;
export const PREVIEW_TIME_MS = 400;

export function usePreviewRoll(line: string | null, time: string | null, enabled: boolean) {
  const lineRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLTimeElement>(null);
  const before = useRef<{ line: string | null; time: string | null }>({ line, time });

  useLayoutEffect(() => {
    const was = before.current;
    before.current = { line, time };
    if (!enabled || was.line === null || line === null || was.line === line) return;
    const reduced = ixReduced();
    const text = lineRef.current;
    if (canAnimate(text)) {
      const roll = text.animate(
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [{ transform: 'translateY(9px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        reduced ? { duration: IX_REDUCED_MS, easing: 'ease-out' } : { duration: PREVIEW_ROLL_MS, easing: IX_SPRING },
      );
      roll.id = 'ix-preview:line';
    }
    const stamp = timeRef.current;
    if (time !== null && canAnimate(stamp)) {
      const fade = stamp.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: reduced ? IX_REDUCED_MS : PREVIEW_TIME_MS,
        easing: 'ease-out',
      });
      fade.id = 'ix-preview:time';
    }
  }, [line, time, enabled]);

  return [lineRef, timeRef] as const;
}
