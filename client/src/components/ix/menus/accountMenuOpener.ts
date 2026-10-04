import { toggleSheet } from '../../glass/sheets';

/** The toolbar's avatar button (the account menu's anchor). */
export const ACCOUNT_MENU_ANCHOR = '[data-ix-account-anchor]';

/**
 * The toolbar's avatar calls this. The account menu is open while
 * `glassStore.sheet === 'account'` (its one page, Reminders, is a sheet), so
 * opening it is a store write: a keyboard shortcut or another surface can open
 * it without a handle on the menu. A second call closes it.
 */
export function openAccountMenu(): void {
  toggleSheet('account');
}
