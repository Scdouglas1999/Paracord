import { invoke } from '@tauri-apps/api/core';

import { logVoiceDiagnostic } from '../desktopDiagnostics';
import { isTauri } from '../tauriEnv';
import { isWindowChromePreview, useWindowChromeStore, type WindowState } from './windowChromeStore';

/**
 * What the page's window controls, drag regions and resize edges ask of the
 * desktop window (docs/design/index-checkpoints/window-chrome.md). Each is the
 * Tauri window API, one path; a refusal is logged with its reason, never
 * swallowed. In a dev preview (no desktop shell) they move the preview's state
 * instead, so the controls can be reviewed in a browser.
 */

/** The eight edges a resize can start from (Tauri's `ResizeDirection`). */
export type ResizeEdge = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

function report(what: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[window] ${what} failed`, { reason });
  logVoiceDiagnostic(`[window] ${what} failed`, { reason });
}

function run(what: string, step: () => Promise<unknown>): Promise<void> {
  return step().then(
    () => undefined,
    (error: unknown) => report(what, error),
  );
}

function previewState(next: (state: WindowState) => WindowState): boolean {
  if (isTauri() || !isWindowChromePreview()) return false;
  const { state, setWindow } = useWindowChromeStore.getState();
  setWindow({ state: next(state) });
  return true;
}

export function minimizeWindow(): Promise<void> {
  if (previewState((state) => state)) return Promise.resolve();
  return run('minimize', async () => (await currentWindow()).minimize());
}

export function toggleMaximizeWindow(): Promise<void> {
  if (previewState((state) => (state === 'maximized' ? 'normal' : 'maximized'))) return Promise.resolve();
  return run('maximize', async () => (await currentWindow()).toggleMaximize());
}

/** Close asks the shell to close; the shell keeps the app in the tray (lib.rs). */
export function closeWindow(): Promise<void> {
  if (previewState((state) => state)) return Promise.resolve();
  return run('close', async () => (await currentWindow()).close());
}

export function startWindowDrag(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return run('move', async () => (await currentWindow()).startDragging());
}

export function startWindowResize(edge: ResizeEdge): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return run('resize', async () => (await currentWindow()).startResizeDragging(edge));
}

/** A double click on a drag region: what the desktop's own title bars do (window_chrome.rs). */
export function titleBarDoubleClick(): Promise<void> {
  if (previewState((state) => (state === 'maximized' ? 'normal' : 'maximized'))) return Promise.resolve();
  return run('title bar double click', () => invoke<string>('window_titlebar_double_click'));
}

/**
 * Follow the real window: maximized, full screen and focus, from its events.
 * Returns the unsubscribe. Only in the desktop app.
 */
export async function watchWindow(): Promise<() => void> {
  const win = await currentWindow();
  const { setWindow } = useWindowChromeStore.getState();
  const refresh = async () => {
    const [fullscreen, maximized] = await Promise.all([win.isFullscreen(), win.isMaximized()]);
    setWindow({ state: fullscreen ? 'fullscreen' : maximized ? 'maximized' : 'normal' });
  };
  const sync = () => {
    void refresh().catch((error: unknown) => report('reading the window state', error));
  };
  sync();
  const stops = await Promise.all([
    win.onResized(sync),
    win.onFocusChanged(({ payload }) => setWindow({ focused: payload })),
  ]);
  return () => stops.forEach((stop) => stop());
}
