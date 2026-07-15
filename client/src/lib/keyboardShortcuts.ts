import { isTauri } from './tauriEnv';

type TauriOsInternals = {
  os_type?: string;
};

/**
 * True when shortcuts should use macOS symbols (⌘, ⌥, ⇧, ⌃).
 * Uses Tauri OS plugin internals when available, otherwise navigator hints.
 */
export function isMacOS(): boolean {
  if (typeof window !== 'undefined') {
    const internals = (window as Window & { __TAURI_OS_PLUGIN_INTERNALS__?: TauriOsInternals })
      .__TAURI_OS_PLUGIN_INTERNALS__;
    if (internals?.os_type === 'macos' || internals?.os_type === 'ios') {
      return true;
    }
  }

  if (typeof navigator === 'undefined') return false;

  const platform = navigator.platform ?? '';
  if (/Mac|iPhone|iPad|iPod/.test(platform)) return true;

  // Tauri webview on macOS may not expose plugin internals in unit tests; fall back to UA.
  if (isTauri()) {
    const ua = navigator.userAgent ?? '';
    return /Macintosh|Mac OS X/.test(ua) && !/Windows/.test(ua);
  }

  return false;
}

const MAC_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Meta: '⌘',
  Cmd: '⌘',
  Command: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Enter: '↵',
  Return: '↵',
  Escape: 'Esc',
  Esc: 'Esc',
};

/** Format a single shortcut key label for the current OS. */
export function formatShortcutKey(key: string): string {
  if (isMacOS()) {
    return MAC_SYMBOLS[key] ?? key;
  }
  if (key === 'Mod') return 'Ctrl';
  if (key === 'Meta') return 'Win';
  return key;
}

/** Format shortcut parts for display (array or "Ctrl+Shift+M" string). */
export function formatShortcut(keys: string[] | string): string {
  const parts = Array.isArray(keys)
    ? keys
    : keys.split('+').map((part) => part.trim()).filter(Boolean);

  if (isMacOS()) {
    return parts.map(formatShortcutKey).join('');
  }
  return parts.map(formatShortcutKey).join('+');
}

/** Primary modifier + key, e.g. ⌘K on macOS or Ctrl+K elsewhere. */
export function formatModShortcut(key: string): string {
  return formatShortcut(['Mod', key]);
}
