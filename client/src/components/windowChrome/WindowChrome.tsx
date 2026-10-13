import { useEffect, type PointerEvent as ReactPointerEvent } from 'react';

import { isTauri } from '../../lib/tauriEnv';
import {
  closeWindow,
  minimizeWindow,
  startWindowResize,
  toggleMaximizeWindow,
  watchWindow,
  type ResizeEdge,
} from '../../lib/windowChrome/windowActions';
import {
  WINDOW_CHROME_PREVIEW_EVENT,
  isWindowChromePreview,
  useWindowChromeStore,
  type WindowChromeState,
} from '../../lib/windowChrome/windowChromeStore';
import { installWindowDrag } from '../../lib/windowChrome/windowDrag';
import { stageFillsWindow, useGlassStore } from '../../stores/glassStore';
import { IxGlyph } from '../ix/glyphs';

type WindowSurface = 'toolbar' | 'sheet' | 'call' | 'fill';

/**
 * The window's own chrome (docs/design/index-checkpoints/window-chrome.md,
 * docs/index-spec.md §3 "Window chrome"). Mounted once, over everything.
 *
 * It marks the document (styles/window-chrome.css reads the marks):
 *
 *   data-window-chrome    frameless (Linux, Windows) | overlay (macOS)
 *   data-window-platform  linux | windows | macos
 *   data-window-state     normal | maximized | fullscreen
 *   data-window-focus     active | inactive
 *   data-window-surface   what holds the top right under the controls:
 *                         toolbar (main's toolbar, or a page's own bar) |
 *                         sheet | call (inset 10 over main: their header) |
 *                         fill (the call view over the whole window)
 *
 * and draws, for a frameless window, the minimize / maximize / close buttons
 * at the top right (not in full screen), and on Linux the resize edges and the
 * hairline edge (only while the window is neither maximized nor full screen).
 * macOS draws its own traffic lights; the page only pads for them.
 */
export function WindowChrome() {
  const platform = useWindowChromeStore((s) => s.platform);
  const kind = useWindowChromeStore((s) => s.kind);
  const state = useWindowChromeStore((s) => s.state);
  const focused = useWindowChromeStore((s) => s.focused);
  const surface = useGlassStore((s): WindowSurface =>
    s.stage.mode === 'none' ? (s.sheet ? 'sheet' : 'toolbar') : stageFillsWindow(s.stage) ? 'fill' : 'call',
  );

  useDocumentMarks(kind, platform, state, focused, surface);

  useEffect(() => {
    if (kind === 'none' || !platform) return;
    const uninstall = installWindowDrag(platform);
    if (!isTauri()) return uninstall;
    let stop: (() => void) | null = null;
    let alive = true;
    void watchWindow().then(
      (unwatch) => {
        if (alive) stop = unwatch;
        else unwatch();
      },
      (error: unknown) => console.error('[window] could not follow the window state', error),
    );
    return () => {
      alive = false;
      stop?.();
      uninstall();
    };
  }, [kind, platform]);

  useEffect(() => {
    if (!isWindowChromePreview()) return;
    const onPreview = (event: Event) => {
      const patch = (event as CustomEvent<Partial<Pick<WindowChromeState, 'state' | 'focused'>>>).detail;
      useWindowChromeStore.getState().setWindow(patch);
    };
    window.addEventListener(WINDOW_CHROME_PREVIEW_EVENT, onPreview);
    return () => window.removeEventListener(WINDOW_CHROME_PREVIEW_EVENT, onPreview);
  }, []);

  if (kind === 'none') return null;
  const full = state === 'fullscreen';
  return (
    <>
      {kind === 'frameless' && !full && <WindowControls maximized={state === 'maximized'} />}
      {kind === 'frameless' && platform === 'linux' && state === 'normal' && <ResizeEdges />}
      {kind === 'overlay' && !full && isWindowChromePreview() && <TrafficLightsPreview />}
    </>
  );
}

function useDocumentMarks(
  kind: WindowChromeState['kind'],
  platform: WindowChromeState['platform'],
  state: WindowChromeState['state'],
  focused: boolean,
  surface: WindowSurface,
) {
  useEffect(() => {
    if (kind === 'none' || !platform) return;
    const root = document.documentElement;
    root.dataset.windowChrome = kind;
    root.dataset.windowPlatform = platform;
    return () => {
      delete root.dataset.windowChrome;
      delete root.dataset.windowPlatform;
    };
  }, [kind, platform]);

  useEffect(() => {
    if (kind === 'none') return;
    const root = document.documentElement;
    root.dataset.windowState = state;
    root.dataset.windowFocus = focused ? 'active' : 'inactive';
    root.dataset.windowSurface = surface;
    return () => {
      delete root.dataset.windowState;
      delete root.dataset.windowFocus;
      delete root.dataset.windowSurface;
    };
  }, [kind, state, focused, surface]);
}

/** Minimize, maximize (restore), close. Close keeps the app in the tray. */
function WindowControls({ maximized }: { maximized: boolean }) {
  // Named for the window, so they never share a name with a dialog's own Close.
  const maximizeTitle = maximized ? 'Restore' : 'Maximize';
  return (
    <div className="wc-controls" role="group" aria-label="Window" data-window-drag="false" data-testid="window-controls">
      <button type="button" className="wc-btn" aria-label="Minimize window" title="Minimize" onClick={() => void minimizeWindow()}>
        <IxGlyph name="windowMinimize" size={16} />
      </button>
      <button
        type="button"
        className="wc-btn"
        aria-label={`${maximizeTitle} window`}
        title={maximizeTitle}
        onClick={() => void toggleMaximizeWindow()}
      >
        <IxGlyph name={maximized ? 'windowRestore' : 'windowMaximize'} size={16} />
      </button>
      <button type="button" className="wc-btn wc-btn--close" aria-label="Close window" title="Close" onClick={() => void closeWindow()}>
        <IxGlyph name="windowClose" size={16} />
      </button>
    </div>
  );
}

const EDGES: readonly ResizeEdge[] = ['North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest'];

/**
 * Linux: an undecorated GTK window has no resize border, so the page keeps
 * a thin band at each edge (wider at the corners) that starts the
 * compositor's own resize. Not drawn; only the cursor shows them.
 */
function ResizeEdges() {
  const onPointerDown = (edge: ResizeEdge) => (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void startWindowResize(edge);
  };
  return (
    <div className="wc-resize" aria-hidden="true" data-window-drag="false">
      {EDGES.map((edge) => (
        <div key={edge} className="wc-resize__edge" data-edge={edge} onPointerDown={onPointerDown(edge)} />
      ))}
    </div>
  );
}

/** Dev preview only: where macOS draws its traffic lights, for the review shots. */
function TrafficLightsPreview() {
  return (
    <div className="wc-lights-preview" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}
