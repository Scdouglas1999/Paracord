import { isMacOS } from '../../../lib/keyboardShortcuts';

/** "Ctrl K" (or "⌘K" on macOS): the spec's spelling for a shortcut shown beside a row. */
export function modHint(key: string): string {
  return isMacOS() ? `⌘${key}` : `Ctrl ${key}`;
}
