import { useMobile, DEFAULT_MOBILE_MAX_WIDTH } from '../../../hooks/useMobile';

/**
 * Which frame the window gets (docs/glass-spec.md §3, §8).
 *
 *   wide     >= 860px  both panes float side by side
 *   compact  768-859   the conversation alone; places is an overlay from the header
 *   phone    < 768     the phone frame (today's Lantern phone path until WP-G20)
 *
 * The phone boundary is the app's existing mobile breakpoint, so everything
 * that already asks `useMobile()` agrees with the frame about what a phone is.
 */
export type GlassLayout = 'wide' | 'compact' | 'phone';

/** Below this window width the places panel stops being a pane (§3). */
export const PLACES_OVERLAY_MAX_WIDTH = 860;

export function useGlassLayout(): GlassLayout {
  const phone = useMobile(DEFAULT_MOBILE_MAX_WIDTH);
  const narrow = useMobile(PLACES_OVERLAY_MAX_WIDTH);
  if (phone) return 'phone';
  return narrow ? 'compact' : 'wide';
}
