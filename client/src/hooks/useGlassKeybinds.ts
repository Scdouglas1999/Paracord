import { useEffect } from 'react';

import { triggerClip } from '../lib/media/clips/useClip';
import { useGlassStore } from '../stores/glassStore';

/**
 * The stage's keys (docs/glass-spec.md §9): S sidebar, T theater, H hide chat,
 * C clip, Esc stop watching. Bound on `window` while a stage is on screen (the
 * stage mounts this), so every handler on the way (a menu's, a dialog's focus
 * trap, the message box's, the voice keybinds) has had the key first and can
 * claim it with `preventDefault`.
 *
 * A key is somebody else's, and the stage leaves it alone, when:
 *   - it comes with Ctrl, Alt or Meta (those are the app's shortcuts), or repeats;
 *   - focus is in something you type into (input, textarea, select, contenteditable);
 *   - a menu, dialog, listbox or stream popover is open on screen;
 *   - a sheet (search, people…) is open over the conversation.
 *
 * Esc while browsing puts the places panel away first; the next Esc stops
 * watching. Stop watching never leaves a call.
 *
 * C is WP-G16's `triggerClip()`: the same as pressing Clip, for the stream on
 * the stage (what cannot be clipped is said in a toast, as the button says it).
 */

export type GlassKeyAction = 'browse' | 'theater' | 'chat' | 'clip' | 'stop';

export interface GlassKeybindOptions {
  /** A stage is on screen. */
  enabled: boolean;
  /** The phone stage has no browse and its own full screen: Esc and C apply. */
  phone: boolean;
  /**
   * A stream is on the stage (the default). The call itself has no stream: no
   * theater, no chat to hide beside it, nothing to clip, so T, H and C stay free.
   */
  stream?: boolean;
  /** Stop watching (closes the stage and stops the watch). */
  onStop: () => void;
}

/** Which stage action a key press asks for, or null. Pure. */
export function glassKeyAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>): GlassKeyAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.key) {
    case 'Escape':
      return 'stop';
    case 's':
    case 'S':
      return 'browse';
    case 't':
    case 'T':
      return 'theater';
    case 'h':
    case 'H':
      return 'chat';
    case 'c':
    case 'C':
      return 'clip';
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
          // Browsing is a layer over the stage: Esc puts the places panel away first.
          if (glass.browseOpen) glass.setBrowseOpen(false);
          else onStop();
          return;
        case 'browse':
          if (phone) return;
          event.preventDefault();
          glass.toggleBrowse();
          return;
        case 'theater':
          if (phone || !stream) return;
          event.preventDefault();
          glass.setStageMode(glass.stage.mode === 'theater' ? 'side' : 'theater');
          return;
        case 'chat':
          // H only means something in theater; elsewhere the key stays free.
          if (phone || !stream || glass.stage.mode !== 'theater') return;
          event.preventDefault();
          glass.toggleChatHidden();
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
