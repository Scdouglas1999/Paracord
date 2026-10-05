import { useEffect } from 'react';

import { isTauri } from '../../../lib/tauriEnv';
import { useGlassStore } from '../../../stores/glassStore';
import { toast } from '../../../stores/toastStore';
import { beginCallMove } from './callMotion';

/**
 * The window half of full screen (docs/index-spec.md §7.7). The call view lays
 * itself out chrome-free over the whole page (`data-call-fill`, ix-call.css);
 * this makes the page the whole screen:
 *
 *   - desktop app: the Tauri window goes full screen, and coming back puts the
 *     window as it was (maximized, or its size and position) if the window
 *     manager did not already;
 *   - browser: the Fullscreen API on the document, so the call view's popovers
 *     (portaled to the body) still show over the stream.
 *
 * One path per platform, no fallback: a window that refuses full screen says
 * so in a toast and the view goes back to the layout under it.
 *
 * Leaving full screen from outside (the browser's own Esc, the compositor's
 * shortcut) is followed: the store hears it, and the view returns to the layout
 * under full screen.
 *
 * NATIVE VIDEO (§7.6): the window changes size under the stream, so for the
 * length of the change (until the page has seen the new size and painted it
 * twice, at most {@link WINDOW_SETTLE_MAX_MS}) native video is covered by the
 * move guard (`beginCallMove`): posters, then the holes reopen at the settled
 * geometry, never a surface at the old one.
 */

/** The longest the move guard waits for the window to take its new size, ms. */
export const WINDOW_SETTLE_MAX_MS = 900;

/** How the window was before full screen, to put it back. */
interface SavedWindow {
  maximized: boolean;
  /** Inner size, physical pixels (what `setSize` takes). */
  width: number;
  height: number;
  /** Outer position, physical pixels (a Wayland window reads 0,0 and cannot be placed). */
  x: number;
  y: number;
}

type TauriWindow = Awaited<ReturnType<typeof tauriWindow>>;

async function tauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

/** Resolves once the page has a new size and has painted it twice, or after `maxMs`. */
function windowSettled(maxMs = WINDOW_SETTLE_MAX_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let frame = 0;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('resize', onResize);
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      resolve();
    };
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(finish);
      });
    };
    const timer = setTimeout(finish, maxMs);
    window.addEventListener('resize', onResize);
  });
}

/* ---- The desktop app -------------------------------------------------------------- */

let saved: SavedWindow | null = null;
/** We put the window in full screen and it said so: a later "not full screen" is somebody else's exit. */
let confirmed = false;

async function enterTauri(): Promise<void> {
  const win = await tauriWindow();
  if (!(await win.isFullscreen())) {
    const [maximized, size, position] = await Promise.all([win.isMaximized(), win.innerSize(), win.outerPosition()]);
    saved = { maximized, width: size.width, height: size.height, x: position.x, y: position.y };
  }
  await win.setFullscreen(true);
  confirmed = await win.isFullscreen();
}

async function exitTauri(): Promise<void> {
  confirmed = false;
  const win = await tauriWindow();
  if (await win.isFullscreen()) {
    const settled = windowSettled();
    await win.setFullscreen(false);
    await settled;
  }
  const before = saved;
  saved = null;
  if (before) await restore(win, before);
}

/** The window manager usually restores the window itself; whatever it did not, is done here. */
async function restore(win: TauriWindow, before: SavedWindow): Promise<void> {
  const { PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/dpi');
  const maximized = await win.isMaximized();
  if (before.maximized) {
    if (!maximized) {
      await win.maximize();
      return;
    }
    // Maximized again but not at its maximized size (the window manager kept
    // the full-screen size): maximizing anew is what makes it configure.
    const size = await win.innerSize();
    if (size.width !== before.width || size.height !== before.height) {
      const settled = windowSettled();
      await win.unmaximize();
      await win.maximize();
      await settled;
    }
    return;
  }
  if (maximized) await win.unmaximize();
  const size = await win.innerSize();
  if (size.width !== before.width || size.height !== before.height) {
    await win.setSize(new PhysicalSize(before.width, before.height));
  }
  const position = await win.outerPosition();
  if (position.x !== before.x || position.y !== before.y) {
    await win.setPosition(new PhysicalPosition(before.x, before.y));
  }
}

async function watchTauri(onExternalExit: () => void): Promise<() => void> {
  const win = await tauriWindow();
  return win.onResized(() => {
    if (!confirmed) return;
    void win.isFullscreen().then((full) => {
      if (!full && confirmed) {
        confirmed = false;
        onExternalExit();
      }
    });
  });
}

/* ---- The browser -------------------------------------------------------------------- */

async function enterBrowser(): Promise<void> {
  const root = document.documentElement;
  if (document.fullscreenElement === root) return;
  if (typeof root.requestFullscreen !== 'function') throw new Error('this browser has no full screen');
  await root.requestFullscreen({ navigationUI: 'hide' });
}

async function exitBrowser(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen();
}

function watchBrowser(onExternalExit: () => void): () => void {
  const onChange = () => {
    if (!document.fullscreenElement) onExternalExit();
  };
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
}

/* ---- One queue, so a quick on-off-on never runs two changes at once ------------------ */

let queue: Promise<void> = Promise.resolve();

function enqueue(step: () => Promise<void>): Promise<void> {
  const next = queue.then(step);
  queue = next.catch(() => {});
  return next;
}

/** The window (or document) full screen, as `on` says, for as long as it says so. */
export function useWindowFullScreen(on: boolean): void {
  useEffect(() => {
    if (!on || typeof document === 'undefined') return;
    const desktop = isTauri();
    let alive = true;
    const leave = () => {
      if (alive) useGlassStore.getState().setStageFullscreen(false);
    };

    // In: covered from the first frame until the window has its new size.
    const endIn = beginCallMove();
    const settledIn = desktop ? windowSettled() : Promise.resolve();
    let watching: (() => void) | null = null;
    enqueue(desktop ? enterTauri : enterBrowser).then(
      async () => {
        if (!alive) return;
        if (desktop) {
          const stop = await watchTauri(leave);
          if (alive) watching = stop;
          else stop();
        } else {
          watching = watchBrowser(leave);
        }
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error('[call] full screen was refused', { reason });
        toast.error(`Could not go full screen: ${reason}`);
        leave();
      },
    );
    void settledIn.then(endIn);

    return () => {
      alive = false;
      watching?.();
      watching = null;
      endIn();
      // Out: covered again until the window is back as it was.
      const endOut = beginCallMove();
      enqueue(desktop ? exitTauri : exitBrowser)
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.error('[call] leaving full screen failed', { reason });
          toast.error(`Could not leave full screen: ${reason}`);
        })
        .finally(() => {
          if (desktop) requestAnimationFrame(() => requestAnimationFrame(endOut));
          else endOut();
        });
    };
  }, [on]);
}
