import { useEffect, useState, type RefObject } from 'react';

import { reportGroundColor } from '../../../lib/nativeGround';

/**
 * The desktop app's video route: every remote video (and the self-view) is
 * decoded natively and drawn on a platform surface UNDER the webview, and the
 * page shows it through a hole (docs/glass-spec.md §2; docs/design/glass-plan.md
 * §6, "Native underlay").
 *
 * A surface tells the page whether its hole may be open through the bubbled
 * `paracord:native-surface-visibility` event on the element it was given. It
 * says `visible: true` only once the native side has drawn a frame exactly
 * where the tile is (`NativeVideoTile`), so a hole never opens over nothing.
 * While one is open:
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
 * The page attribute outlives a closed hole by {@link UNDERLAY_GRACE_MS}: a hole
 * that closes for a stage move or a menu and reopens a moment later must not
 * flip the whole page between its underlay look and its normal one (the room's
 * backdrop would flash in and out on every move).
 *
 * A stage move (`beginNativeMove`) makes the bottom of the page opaque, in the
 * ground color the shell paints under it, for its length: every surface is
 * covered from the move's first frame, wherever it still is, while the tiles
 * show their posters and travel with the page. When the move ends the tiles
 * reveal their surfaces at the settled geometry, each once its frame is there.
 */

/** How long the page keeps its underlay look after the last hole closed, ms. */
export const UNDERLAY_GRACE_MS = 1200;

let holes = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function setPageUnderlay(on: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const was = root.hasAttribute('data-native-underlay');
  root.toggleAttribute('data-native-underlay', on);
  // The toplevel under the webview shows around the video the moment the hole
  // opens: tell the shell the ground color again so it is the current one.
  if (on && !was) void reportGroundColor();
}

function setHole(open: boolean): void {
  if (typeof document === 'undefined') return;
  holes = Math.max(0, holes + (open ? 1 : -1));
  if (holes > 0) {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = null;
    setPageUnderlay(true);
    return;
  }
  if (releaseTimer) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (holes === 0 && moves === 0) setPageUnderlay(false);
  }, UNDERLAY_GRACE_MS);
}

let moves = 0;

/**
 * A stage move starts: until the returned function is called, the page is
 * opaque at the bottom (`html[data-native-moving]`) and every native tile shows
 * its poster. Call it synchronously before the move's first frame is painted.
 */
export function beginNativeMove(): () => void {
  if (typeof document === 'undefined') return () => {};
  moves += 1;
  document.documentElement.toggleAttribute('data-native-moving', true);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    moves = Math.max(0, moves - 1);
    if (moves > 0) return;
    document.documentElement.removeAttribute('data-native-moving');
    if (holes === 0 && !releaseTimer && document.documentElement.hasAttribute('data-native-underlay')) {
      // The page kept its look through the move; let it go the usual way.
      setHole(true);
      setHole(false);
    }
  };
}

/** For tests. */
export function underlayHoleCount(): number {
  return holes;
}

/** For tests: forget every hole, move and pending release. */
export function resetNativeUnderlay(): void {
  holes = 0;
  moves = 0;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute('data-native-underlay');
    document.documentElement.removeAttribute('data-native-moving');
  }
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
