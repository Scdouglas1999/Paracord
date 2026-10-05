/**
 * Menus on a phone are bottom action sheets (docs/index-spec.md §9: "menus are
 * bottom action sheets (radius 20, rows 52)"; IX-16). The Index menu
 * (`IxMenuSurface`) and the shared context menu (`ui/ContextMenu`) both switch
 * to it under `useIsPhone()`; the look is ix-phone.css (`.ix-menu--sheet`,
 * `.ix-action-sheet`, `.ix-action-scrim`).
 *
 * It rises from below the screen's foot on the spring and drops back on the
 * ease; the hold below keeps it mounted for the whole drop.
 */

/** The action sheet's rise (ms). */
export const ACTION_SHEET_IN_MS = 110;
/** Its drop (ms): the CSS animation. */
export const ACTION_SHEET_OUT_MS = 75;
/** How long a closing action sheet stays mounted: a little longer than the drop. */
export const ACTION_SHEET_EXIT_MS = 80;
