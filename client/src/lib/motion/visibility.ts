/**
 * Nothing animates on a window nobody can see (the motion law, §5.3).
 *
 * A browser stops painting a hidden tab on its own, but a desktop webview is
 * not a tab: a minimized or covered window can keep a CSS animation's clock
 * running and keep the compositor waking for it. The few animations allowed to
 * loop — the live indicators, the speaking breath, a loading pulse — are
 * therefore paused from here: the document's visibility is published as
 * `data-visibility` on `<html>`, and utilities.css pauses every animation under
 * `data-visibility='hidden'`. It resumes, where it was, the moment the window
 * is shown again.
 */

function publish(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-visibility', document.visibilityState === 'hidden' ? 'hidden' : 'visible');
}

let installed = false;

/** Start publishing. Idempotent; the module calls it on load. */
export function installVisibilityPause(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  publish();
  document.addEventListener('visibilitychange', publish);
}

/** Test seam: stop publishing and forget the attribute. */
export function resetVisibilityPauseForTests(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', publish);
  document.documentElement.removeAttribute('data-visibility');
  installed = false;
}

installVisibilityPause();
