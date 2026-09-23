import { useEffect, useLayoutEffect } from 'react';

/**
 * The hand-off from the loading screen in `index.html` (`#pc-boot`) to the app.
 *
 * The loading screen paints before any script has loaded and plays its sequence
 * in pure CSS (see the comment in index.html). This module decides when it
 * goes, and there are exactly two cases:
 *
 * - **The app is ready**: its first commit rendered no splash of its own (a
 *   sign-in page, the shell, an error screen). The loading screen fades out now,
 *   mid-sequence if need be. It never holds the app back.
 * - **The app is still loading**: something in the first commit rendered
 *   {@link BrandSplash} ("Restoring session...") or the lazy-route fallback.
 *   Those draw the loading screen's final frame in the same place, so the
 *   loading screen plays to the end and then fades out over its own final
 *   frame; the only change on screen is the status line appearing. It also
 *   goes the moment the last of them unmounts.
 *
 * Once gone it is removed from the document, so nothing keeps animating.
 */

const LEAVE_MS = 180; // .pc-boot's opacity transition in index.html

let holds = 0;
let committed = false;
let state: 'showing' | 'waiting' | 'gone' = 'showing';

function bootNode(): HTMLElement | null {
  return document.getElementById('pc-boot');
}

function takeDown() {
  if (state === 'gone') return;
  state = 'gone';
  const node = bootNode();
  if (!node) return;
  node.classList.add('is-leaving');
  window.setTimeout(() => node.remove(), LEAVE_MS);
}

function evaluate() {
  if (state === 'gone' || !committed) return;
  if (holds === 0) {
    takeDown();
    return;
  }
  if (state === 'waiting') return;
  state = 'waiting';
  const node = bootNode();
  if (!node) {
    state = 'gone';
    return;
  }
  // Every animation in the loading screen is finite, and the one that is not
  // part of the sequence (the "taking longer than usual" line, 12 s in) is
  // left out, or this would wait for it.
  const sequence = node.getAnimations({ subtree: true }).filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return !target?.classList.contains('pc-boot__slow');
  });
  void Promise.all(sequence.map((animation) => animation.finished)).then(takeDown, takeDown);
}

/**
 * Re-check after the current commit has settled. StrictMode mounts, unmounts
 * and remounts every effect synchronously inside one commit, which would read
 * as "the last splash went away" for an instant.
 */
function scheduleEvaluate() {
  void Promise.resolve().then(evaluate);
}

/**
 * Called once by the root of the tree (main.tsx) after the app's first commit.
 * Child effects run before a parent's, so every splash in that commit has
 * already registered its hold by now.
 */
export function useBootSplashHandoff() {
  useEffect(() => {
    committed = true;
    scheduleEvaluate();
  }, []);
}

/**
 * Keep the loading screen up while this component is mounted during boot. For
 * surfaces that draw the loading screen's final frame themselves.
 */
export function useBootSplashHold() {
  useLayoutEffect(() => {
    holds += 1;
    return () => {
      holds -= 1;
      scheduleEvaluate();
    };
  }, []);
}

/** Test seam: forget everything, as if the page had just loaded. */
export function resetBootSplashForTests() {
  holds = 0;
  committed = false;
  state = 'showing';
}
