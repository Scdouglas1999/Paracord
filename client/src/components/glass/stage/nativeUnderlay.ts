import { useEffect, useState, type RefObject } from 'react';

import { reportGroundColor } from '../../../lib/nativeGround';

/**
 * The desktop app's native-surface route on Linux: the decoded video is drawn
 * on a platform surface UNDER the webview, and the page shows it through a
 * hole (docs/design/glass-plan.md §6, "Native underlay on Linux").
 *
 * The engine decides the route once per track when `subscribeVideo` starts and
 * never switches it mid-stream; a surface only tells the page whether it is
 * visible, through the bubbled `paracord:native-surface-visibility` event on
 * the element it was given. While one is visible:
 *
 *   - `<html data-native-underlay>` is set (refcounted here), which makes the
 *     ancestor chain marked `data-native-underlay-clear` transparent
 *     (styles/layout.css), so the cleared pixels are a real hole;
 *   - the element's own backdrop goes clear (`underlayLive`), and the stage's
 *     controls drawn over the video switch to near-solid fills, because nothing
 *     in the webview can blur a surface below it (styles/glass-stage.css);
 *   - after the page has painted the hole, the surface is nudged
 *     (`paracord:native-underlay-hole-ready`) to report its geometry once more.
 *
 * This is the only owner of the attribute: the stage (and its camera tiles) is
 * the one surface that draws a native video (WP-G14; the Lantern stream viewer
 * that kept a count of its own was retired in WP-G22).
 */

let holes = 0;

function setHole(open: boolean): void {
  if (typeof document === 'undefined') return;
  const wasOpen = holes > 0;
  holes = Math.max(0, holes + (open ? 1 : -1));
  document.documentElement.toggleAttribute('data-native-underlay', holes > 0);
  // The toplevel under the webview shows around the video the moment the hole
  // opens: tell the shell the ground color again so it is the current one.
  if (!wasOpen && holes > 0) void reportGroundColor();
}

/** For tests. */
export function underlayHoleCount(): number {
  return holes;
}

/**
 * Whether the native surface under `containerRef` (the element that receives
 * the surface's visibility events) is live. `canvasRef` is nudged once the hole
 * is painted.
 */
export function useNativeUnderlay(
  containerRef: RefObject<HTMLElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): boolean {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onVisibility = (event: Event) => {
      setLive(Boolean((event as CustomEvent<{ visible?: boolean }>).detail?.visible));
    };
    container.addEventListener('paracord:native-surface-visibility', onVisibility);
    return () => container.removeEventListener('paracord:native-surface-visibility', onVisibility);
  }, [containerRef]);

  useEffect(() => {
    if (!live) return;
    setHole(true);
    return () => setHole(false);
  }, [live]);

  useEffect(() => {
    if (!live) return;
    let first = 0;
    let second = 0;
    first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        canvasRef.current?.dispatchEvent(new CustomEvent('paracord:native-underlay-hole-ready', { bubbles: true }));
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [live, canvasRef]);

  return live;
}
