import { useEffect } from 'react';

import { triggerClip } from '../lib/media/clips/useClip';
import { useGlassStore } from '../stores/glassStore';

/**
 * The call view's keys (docs/index-spec.md §7.4): Esc (full screen -> the
 * layout under it; theater -> main -> closed), T theater, H the chat column,
 * F full screen and C clip (a stream in focus). Glass's S
 * (browse) is retired. Bound on `window` while the call view is on screen (it
 * mounts this), so every handler on the way (a menu's, a dialog's focus trap,
 * the message box's, the voice keybinds) has had the key first and can claim
 * it with `preventDefault`.
 *
 * A key is somebody else's, and the view leaves it alone, when:
 *   - it comes with Ctrl, Alt or Meta (those are the app's shortcuts), or repeats;
 *   - focus is in something you type into (input, textarea, select, contenteditable):
 *     the chat column's message box keeps every letter;
 *   - a menu, dialog, listbox or stream popover is open on screen;
 *   - a sheet (search, people…) is open.
 *
 * Esc never leaves a call: closing the view keeps it (§7.3). C is the same as
 * pressing Clip, for the stream in focus (what cannot be clipped is said in a
 * toast, as the button says it). The phone has no theater and no chat column,
 * and its full screen is the sheet's own (sideways, or its Full screen
 * control), so F is the desktop's and the browser's. In full screen T goes to
 * theater (leaving full screen) and H waits: there is no chat column there.
 */

export type GlassKeyAction = 'theater' | 'chat' | 'clip' | 'fullscreen' | 'stop';

export interface GlassKeybindOptions {
  /** The call view is on screen. */
  enabled: boolean;
  /** The phone's call has no theater and no chat column: Esc and C apply. */
  phone: boolean;
  /** A stream is in focus (the default): C clips it. Without one C stays free. */
  stream?: boolean;
  /** Close the view (stops watching; never leaves the call). */
  onStop: () => void;
}

/** Which stage action a key press asks for, or null. Pure. */
export function glassKeyAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>): GlassKeyAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.key) {
    case 'Escape':
      return 'stop';
    case 't':
    case 'T':
      return 'theater';
    case 'h':
    case 'H':
      return 'chat';
    case 'c':
    case 'C':
      return 'clip';
    case 'f':
    case 'F':
      return 'fullscreen';
    default:
      return null;
  }
}

const LAYERS =
  '[data-stream-overlay-portal], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** Whether a key press is somebody else's: typing, or a layer above the stage is open. */
export function keyBelongsElsewhere(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  }
  const layers = document.querySelectorAll<HTMLElement>(LAYERS);
  // Only a layer that is actually on screen claims the key.
  return [...layers].some((layer) => layer.getClientRects().length > 0 && getComputedStyle(layer).visibility !== 'hidden');
}

export function useGlassKeybinds({ enabled, phone, stream = true, onStop }: GlassKeybindOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const action = glassKeyAction(event);
      if (!action) return;
      if (keyBelongsElsewhere(event)) return;
      const glass = useGlassStore.getState();
      if (glass.stage.mode === 'none' || glass.sheet !== null) return;

      switch (action) {
        case 'stop':
          event.preventDefault();
          // Full screen steps back to the layout under it, theater to main;
          // the next Esc closes the view.
          if (glass.stage.fullscreen) glass.setStageFullscreen(false);
          else if (glass.stage.mode === 'theater' && !phone) glass.setStageMode('main');
          else onStop();
          return;
        case 'theater':
          if (phone) return;
          event.preventDefault();
          glass.setStageMode(glass.stage.mode === 'theater' ? 'main' : 'theater');
          return;
        case 'chat':
          if (phone || glass.stage.fullscreen) return;
          event.preventDefault();
          glass.toggleChat();
          return;
        case 'fullscreen':
          if (phone || !stream) return;
          event.preventDefault();
          glass.setStageFullscreen(!glass.stage.fullscreen);
          return;
        case 'clip':
          if (!stream) return;
          event.preventDefault();
          void triggerClip();
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, phone, stream, onStop]);
}
