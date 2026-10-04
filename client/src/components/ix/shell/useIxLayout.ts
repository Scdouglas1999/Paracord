import { DEFAULT_MOBILE_MAX_WIDTH, useMobile } from '../../../hooks/useMobile';

/**
 * Which frame the window gets (docs/index-spec.md §3 "Widths").
 *
 *   wide    >= 1024px  sidebar 316, column padding 48
 *   narrow  768-1023   sidebar 280, column padding 32
 *   phone   < 768      the sidebar is the root screen, main is pushed (§9)
 *
 * There is no third mode and no overlay: the Glass compact overlay is retired.
 * The phone boundary is the app's existing mobile breakpoint, so everything that
 * asks `useMobile()` agrees about what a phone is.
 */
export type IxLayout = 'wide' | 'narrow' | 'phone';

/** Below this window width the sidebar narrows to 280 (§3). */
export const IX_NARROW_MAX_WIDTH = 1024;

export function useIxLayout(): IxLayout {
  const phone = useMobile(DEFAULT_MOBILE_MAX_WIDTH);
  const narrow = useMobile(IX_NARROW_MAX_WIDTH);
  if (phone) return 'phone';
  return narrow ? 'narrow' : 'wide';
}
