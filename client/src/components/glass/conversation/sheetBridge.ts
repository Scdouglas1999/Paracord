import { useGlassStore, type GlassSheet } from '../../../stores/glassStore';
import { useUIStore, type ContextPanelMode } from '../../../stores/uiStore';

/**
 * INTERIM (WP-G11, deleted by WP-G18): the header's door to the sheets.
 *
 * The Glass contract is `glassStore.openSheet('search' | 'people' | 'account')`
 * and a Sheets slot that renders what is open. Until WP-G18 fills that slot,
 * the sheets stub still hosts today's ContextPanel, driven by
 * `uiStore.contextPanelMode`. So a header button does both: it states the
 * intent on `glassStore` (the contract) and drives the panel that can show it
 * today. When WP-G18 lands it replaces this file with a store-only version (or
 * inlines it); the header calls nothing else.
 *
 * What is not covered yet, on purpose:
 *   - `people` in a server channel: no Lantern surface shows a member list
 *     (docs/lantern-stage-spec.md §6.5 removed it), so the button records the
 *     intent and nothing opens until the people sheet exists (WP-G18).
 *   - `account`: opens user settings, the one account surface that stands
 *     outside the places panel. Status and the custom status stay in the places
 *     panel's account plate until WP-G9/G18.
 */

export type HeaderSheet = Extract<GlassSheet, 'search' | 'people' | 'account'>;

export interface HeaderSheetContext {
  /** A group DM's "people" is its recipients panel, which exists today. */
  isGroupDm?: boolean;
}

/** The ContextPanel mode that shows this sheet today, if there is one. */
function panelModeFor(sheet: HeaderSheet, ctx: HeaderSheetContext): Exclude<ContextPanelMode, null> | null {
  if (sheet === 'search') return 'search';
  if (sheet === 'people' && ctx.isGroupDm) return 'recipients';
  return null;
}

/** Whether the surface this sheet button controls is open right now. */
export function useHeaderSheetOpen(sheet: HeaderSheet, ctx: HeaderSheetContext = {}): boolean {
  const mode = useUIStore((s) => s.contextPanelMode);
  const settingsOpen = useUIStore((s) => s.userSettingsOpen);
  if (sheet === 'account') return settingsOpen;
  const panel = panelModeFor(sheet, ctx);
  return panel !== null && mode === panel;
}

/** Open the sheet, or close it when it is already the one showing. */
export function toggleHeaderSheet(sheet: HeaderSheet, ctx: HeaderSheetContext = {}): void {
  const glass = useGlassStore.getState();
  const ui = useUIStore.getState();

  if (sheet === 'account') {
    glass.openSheet('account');
    ui.setUserSettingsOpen(true);
    return;
  }

  const panel = panelModeFor(sheet, ctx);
  if (panel !== null && ui.contextPanelMode === panel) {
    glass.closeSheet();
    ui.setContextPanelMode(null);
    return;
  }
  glass.openSheet(sheet);
  if (panel !== null) ui.setContextPanelMode(panel);
}

/**
 * Show one of today's ContextPanel modes from the channel menu (pins, threads,
 * media, leaderboard). WP-G18 turns these into sheets of their own.
 */
export function toggleContextPanel(mode: Exclude<ContextPanelMode, null>): void {
  useUIStore.getState().toggleContextPanelMode(mode);
}
