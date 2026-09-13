import { useSyncExternalStore } from 'react';

/**
 * The one reduced-motion switch (docs/lantern-stage-spec.md §5.3:
 * "One central switch, never per component").
 *
 * Three inputs, one answer:
 *
 *   - the OS setting, `matchMedia('(prefers-reduced-motion: reduce)')`;
 *   - the explicit user setting in Settings › Appearance (`uiStore.motion`:
 *     `system` follows the OS, `full` and `reduced` override it);
 *   - the answer itself, published as `data-motion="reduced"` on `<html>` so
 *     CSS switches off the same decision the script does.
 *
 * Nothing else in the app may call `matchMedia('(prefers-reduced-motion…')`.
 * Components read `useReducedMotion()`; plain modules read
 * `prefersReducedMotion()`; stylesheets read `:root[data-motion='reduced']`.
 */

export type MotionPreference = 'system' | 'full' | 'reduced';

export const MOTION_PREFERENCES: readonly MotionPreference[] = ['system', 'full', 'reduced'];

const QUERY = '(prefers-reduced-motion: reduce)';

let preference: MotionPreference = 'system';
let reduced = false;
const listeners = new Set<() => void>();
let query: MediaQueryList | null = null;

function systemPrefersReduce(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (!query) {
    query = window.matchMedia(QUERY);
    // Older WebKit only has the deprecated listener form; the desktop webview
    // on every platform we ship has `addEventListener`, and the fallback keeps
    // the switch honest in a test renderer that stubs only the old shape.
    if (typeof query.addEventListener === 'function') query.addEventListener('change', apply);
    else if (typeof (query as MediaQueryList).addListener === 'function') query.addListener(apply);
  }
  return query.matches;
}

/** Recompute the answer, write the attribute, and wake every reader. */
function apply(): void {
  const next = preference === 'system' ? systemPrefersReduce() : preference === 'reduced';
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const changed = next !== reduced;
  reduced = next;
  if (root) {
    if (next) root.setAttribute('data-motion', 'reduced');
    else root.setAttribute('data-motion', 'full');
  }
  if (changed) for (const listener of [...listeners]) listener();
}

/**
 * Point the switch at a preference. `useTheme` calls this with the stored
 * setting; nothing else should.
 */
export function configureMotion(next: MotionPreference): void {
  preference = MOTION_PREFERENCES.includes(next) ? next : 'system';
  apply();
}

/** The preference in force (not the answer — see `prefersReducedMotion`). */
export function motionPreference(): MotionPreference {
  return preference;
}

/** The answer: should this app land things instantly? */
export function prefersReducedMotion(): boolean {
  return reduced;
}

/** Subscribe to changes in the answer. Returns an unsubscribe. */
export function subscribeReducedMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The React reader. Re-renders when the OS setting or the user setting moves. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

/** Test seam: forget the media query and the listeners between cases. */
export function resetMotionSwitchForTests(): void {
  if (query) {
    if (typeof query.removeEventListener === 'function') query.removeEventListener('change', apply);
    else if (typeof (query as MediaQueryList).removeListener === 'function') query.removeListener(apply);
  }
  query = null;
  listeners.clear();
  preference = 'system';
  reduced = false;
  if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-motion');
}

// The attribute has to exist before the first frame a user causes, and the
// engine is imported by everything that animates, so settle it on load.
if (typeof document !== 'undefined') apply();
