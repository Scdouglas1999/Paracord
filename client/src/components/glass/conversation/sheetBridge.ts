import { useGlassStore, type GlassSheet } from '../../../stores/glassStore';
import type { ContextPanelMode } from '../../../stores/uiStore';
import { toggleChannelSheet, toggleSheet, type ChannelSheetPage } from '../sheets';

/**
 * The Glass header's door to the sheets (WP-G11; store-only since WP-G18). Still
 * used by the Glass `ConversationHeader` and `HeaderAvatar` until IX-15 replaces
 * them; the Index toolbar and menus call `components/glass/sheets` directly.
 *
 * The Sheets slot (`components/glass/sheets`) renders whatever
 * `glassStore.sheet` names, so a header button only has to say which: search,
 * people or the account menu. The channel menu's rows name a page of the
 * channel sheet (pins, threads, media, leaderboard, notifications). Nothing here
 * drives the old ContextPanel any more.
 */

export type HeaderSheet = Extract<GlassSheet, 'search' | 'people' | 'account'>;

export interface HeaderSheetContext {
  /**
   * Kept so the header's calls still type-check. A group message no longer
   * needs its own panel mode: the people sheet chooses what to show from the
   * conversation it is over.
   */
  isGroupDm?: boolean;
}

/** Whether the sheet this button controls is open right now. */
export function useHeaderSheetOpen(sheet: HeaderSheet, _context: HeaderSheetContext = {}): boolean {
  return useGlassStore((s) => s.sheet === sheet);
}

/** Open the sheet, or close it when it is already the one showing. */
export function toggleHeaderSheet(sheet: HeaderSheet, _context: HeaderSheetContext = {}): void {
  toggleSheet(sheet);
}

/**
 * Show a page from the channel menu (pins, threads, media, leaderboard,
 * notifications), or close the sheet when that page is already showing.
 * `economy` is the leaderboard's older name.
 */
export function toggleContextPanel(mode: Exclude<ContextPanelMode, null> | ChannelSheetPage): void {
  switch (mode) {
    case 'search':
      toggleSheet('search');
      return;
    case 'recipients':
      toggleSheet('people');
      return;
    case 'economy':
      toggleChannelSheet('leaderboard');
      return;
    default:
      toggleChannelSheet(mode);
  }
}
