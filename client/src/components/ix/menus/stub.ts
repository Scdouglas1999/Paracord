import { toggleSheet } from '../../glass/sheets';

/**
 * STUB (IX-4). Owner: IX-9, which moves the account menu here (index-spec §6.4)
 * and replaces this file.
 *
 * The toolbar's avatar calls `openAccountMenu()`. Today it opens the Glass
 * account menu, which `Sheets` renders as a popover; that popover anchors to
 * `.glass-header__avatar` (the old conversation header's face, when one is on
 * screen). IX-9: anchor the Index account menu to `ACCOUNT_MENU_ANCHOR`, the
 * toolbar's avatar button.
 */
export function openAccountMenu(): void {
  toggleSheet('account');
}

/** The toolbar's avatar button (the account menu's anchor). */
export const ACCOUNT_MENU_ANCHOR = '[data-ix-account-anchor]';
