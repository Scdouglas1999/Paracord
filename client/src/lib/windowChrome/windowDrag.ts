import { startWindowDrag, titleBarDoubleClick } from './windowActions';
import type { WindowPlatform } from './windowChromeStore';

/**
 * The page's drag regions (docs/design/index-checkpoints/window-chrome.md): a
 * press on one moves the window, a double click does what the desktop's title
 * bars do (window_chrome.rs reads the setting).
 *
 *   data-window-drag=""      only a press on this element itself
 *   data-window-drag="deep"  a press anywhere inside it
 *   data-window-drag="false" never inside it
 *
 * A control never drags: a button, link, field, anything focusable or with an
 * interactive role between the press and the region stops it (the same rules
 * as Tauri's own `data-tauri-drag-region`, which the app does not use: its
 * double click cannot follow the desktop's setting).
 *
 * macOS takes the double click on release, and only if the pointer has not
 * moved (a press that becomes a drag is not a double click), as its own title
 * bars do.
 */

export const WINDOW_DRAG_ATTRIBUTE = 'data-window-drag';

const CLICKABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY', 'VIDEO', 'AUDIO']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
  'slider',
  'textbox',
  'combobox',
]);

function isControl(element: HTMLElement): boolean {
  if (CLICKABLE_TAGS.has(element.tagName)) return true;
  if (element.isContentEditable) return true;
  const tabIndex = element.getAttribute('tabindex');
  if (tabIndex !== null && tabIndex !== '-1') return true;
  const role = element.getAttribute('role');
  return role !== null && INTERACTIVE_ROLES.has(role);
}

/** Whether a press with this composed path lands on a drag region. */
export function isDragRegion(path: readonly EventTarget[]): boolean {
  const target = path[0];
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const mode = node.getAttribute(WINDOW_DRAG_ATTRIBUTE);
    if (mode === null) {
      if (isControl(node)) return false;
      continue;
    }
    if (mode === 'false') return false;
    if (mode === 'deep') return true;
    return node === target;
  }
  return false;
}

/** Install the one document listener. Returns the uninstall. */
export function installWindowDrag(platform: WindowPlatform): () => void {
  let downX = 0;
  let downY = 0;

  const onDown = (event: MouseEvent) => {
    if (event.button !== 0 || (event.detail !== 1 && event.detail !== 2)) return;
    if (!isDragRegion(event.composedPath())) return;
    // No text selection, no focus change: this press belongs to the window.
    event.preventDefault();
    if (event.detail === 2) {
      if (platform === 'macos') {
        downX = event.clientX;
        downY = event.clientY;
        return;
      }
      void titleBarDoubleClick();
      return;
    }
    void startWindowDrag();
  };

  const onUp = (event: MouseEvent) => {
    if (event.button !== 0 || event.detail !== 2) return;
    if (event.clientX !== downX || event.clientY !== downY) return;
    if (!isDragRegion(event.composedPath())) return;
    void titleBarDoubleClick();
  };

  document.addEventListener('mousedown', onDown);
  if (platform === 'macos') document.addEventListener('mouseup', onUp);
  return () => {
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('mouseup', onUp);
  };
}
