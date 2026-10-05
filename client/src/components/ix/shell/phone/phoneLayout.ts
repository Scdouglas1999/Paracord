import { useSyncExternalStore } from 'react';

import { useMobile } from '../../../../hooks/useMobile';

/** The app's one mobile breakpoint (`hooks/useMobile`'s default). */
const PHONE_MAX_WIDTH = 768;

/**
 * What a phone is (docs/index-spec.md §9 "Phone (< 768px)"; IX-16).
 *
 *   - any window under 768px wide (the app's one mobile breakpoint, `useMobile`);
 *   - and a phone turned on its side: a touch screen under 500px tall. An iPhone
 *     in landscape is 844x390, wider than the breakpoint; without this it would
 *     get the desktop's two columns squeezed into 390px of height.
 *
 * A short desktop window is not a phone: the landscape rule needs a coarse
 * pointer with no hover (a finger), which a mouse never reports.
 *
 * Every Index surface that asks "is this a phone?" asks here (the frame, the
 * sheets, the menus, the switcher), so they cannot disagree at a boundary.
 */
export const PHONE_LANDSCAPE_QUERY = '(max-height: 499px) and (pointer: coarse) and (hover: none)';

function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function subscribeLandscape(onChange: () => void): () => void {
  if (!canMatch()) return () => {};
  const query = window.matchMedia(PHONE_LANDSCAPE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function landscapeNow(): boolean {
  return canMatch() && window.matchMedia(PHONE_LANDSCAPE_QUERY).matches;
}

/** A phone held sideways (a short touch screen). */
export function usePhoneLandscape(): boolean {
  return useSyncExternalStore(subscribeLandscape, landscapeNow, () => false);
}

/** The window is a phone (§9): narrow, or a short touch screen. */
export function useIsPhone(): boolean {
  // `useMobile()`'s default boundary is the phone's (768).
  const narrow = useMobile();
  const sideways = usePhoneLandscape();
  return narrow || sideways;
}

/** The same question outside React (a gesture, a store listener). */
export function isPhoneNow(): boolean {
  if (!canMatch()) return false;
  return window.matchMedia(`(width < ${PHONE_MAX_WIDTH}px)`).matches || landscapeNow();
}
