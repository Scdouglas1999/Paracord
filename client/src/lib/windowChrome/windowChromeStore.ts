import { create } from 'zustand';

import { isTauri } from '../tauriEnv';

/**
 * The desktop window's own chrome (docs/design/index-checkpoints/window-chrome.md,
 * docs/index-spec.md §3 "Window chrome").
 *
 *   frameless  Linux and Windows: no native title bar or frame. The page draws
 *              minimize / maximize / close (top right), marks its drag regions,
 *              and on Linux its resize edges and a hairline edge.
 *   overlay    macOS: the native traffic lights float over the content (top
 *              left of the sidebar); the page marks its drag regions.
 *   none       a browser tab: the browser owns the window.
 */
export type WindowPlatform = 'linux' | 'windows' | 'macos';
export type WindowChromeKind = 'frameless' | 'overlay' | 'none';
export type WindowState = 'normal' | 'maximized' | 'fullscreen';

export interface WindowChromeState {
  platform: WindowPlatform | null;
  kind: WindowChromeKind;
  state: WindowState;
  focused: boolean;
  /** Set from the window's events (desktop) or a preview (dev builds). */
  setWindow: (patch: Partial<Pick<WindowChromeState, 'state' | 'focused'>>) => void;
}

/** The platform the desktop shell runs on, from the webview's user agent. */
export function platformFromUserAgent(userAgent: string): WindowPlatform | null {
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return null;
}

export function chromeKindFor(platform: WindowPlatform | null): WindowChromeKind {
  if (platform === 'macos') return 'overlay';
  if (platform === 'linux' || platform === 'windows') return 'frameless';
  return 'none';
}

/**
 * Dev builds only: draw the chrome of a platform in a browser, for review and
 * the e2e shots (`?window-chrome=linux|windows|macos`, or
 * `window.__PARACORD_WINDOW_CHROME__ = { platform, state }` before the app
 * loads). A production build ignores both.
 */
export interface WindowChromePreview {
  platform: WindowPlatform;
  state?: WindowState;
  focused?: boolean;
}

declare global {
  interface Window {
    __PARACORD_WINDOW_CHROME__?: WindowChromePreview;
  }
}

/** The event a dev preview sends to change the window's state (`detail`: a patch). */
export const WINDOW_CHROME_PREVIEW_EVENT = 'paracord:window-chrome';

function readPreview(): WindowChromePreview | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  if (window.__PARACORD_WINDOW_CHROME__) return window.__PARACORD_WINDOW_CHROME__;
  const asked = new URLSearchParams(window.location.search).get('window-chrome');
  if (asked === 'linux' || asked === 'windows' || asked === 'macos') return { platform: asked };
  return null;
}

const preview = readPreview();

function initialPlatform(): WindowPlatform | null {
  if (preview) return preview.platform;
  if (!isTauri() || typeof navigator === 'undefined') return null;
  return platformFromUserAgent(navigator.userAgent);
}

const platform = initialPlatform();

export const useWindowChromeStore = create<WindowChromeState>((set) => ({
  platform,
  kind: chromeKindFor(platform),
  state: preview?.state ?? 'normal',
  focused: preview?.focused ?? true,
  setWindow: (patch) => set(patch),
}));

/** True when a dev preview, not a real window, drives the chrome. */
export function isWindowChromePreview(): boolean {
  return preview !== null;
}
