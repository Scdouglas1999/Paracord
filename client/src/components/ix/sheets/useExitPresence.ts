import { useEffect, useRef, useState } from 'react';

import { useReducedMotion } from '../../../lib/motion/reducedMotion';

/**
 * Staying mounted for an exit of a given length (docs/index-spec.md §5.17: a
 * sheet leaves in 115ms, longer than `usePresence`'s 75ms hold, which would cut
 * the leave short).
 *
 * The same rules as `lib/motion/presence.ts` `usePresence`, which this mirrors
 * (lib/motion is fenced for the send-flight branch, so it is copied rather than
 * widened): opening is synchronous (the node exists on the commit that opens it,
 * so a layout effect can measure it), the leave starts on the commit that closes
 * it, re-opening during a leave cancels it, reduced motion has no leave at all,
 * and the first render never plays one.
 */
export interface ExitPresence {
  /** Keep rendering the element while this is true. */
  mounted: boolean;
  /** The leave is in flight: apply the leave class. */
  exiting: boolean;
}

export function useExitPresence(open: boolean, exitMs: number): ExitPresence {
  const reduced = useReducedMotion();
  const [state, setState] = useState<ExitPresence>(() => ({ mounted: open, exiting: false }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (open) {
    if (!state.mounted || state.exiting) setState({ mounted: true, exiting: false });
  } else if (reduced) {
    if (state.mounted || state.exiting) setState({ mounted: false, exiting: false });
  } else if (state.mounted && !state.exiting) {
    setState({ mounted: true, exiting: true });
  }

  useEffect(() => {
    if (!state.exiting) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setState({ mounted: false, exiting: false });
    }, exitMs);
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [state.exiting, exitMs]);

  return state;
}

/** Index motion: a sheet enters in 175ms and leaves in 115ms (§5.17). */
export const SHEET_EXIT_MS = 115;
/** Menus and popovers leave in 55ms (§5.17); the hold is a little longer so the animation finishes first. */
export const MENU_EXIT_MS = 65;
