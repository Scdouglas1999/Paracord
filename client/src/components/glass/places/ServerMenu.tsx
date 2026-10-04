/**
 * The server menu moved to components/ix/menus/ServerMenu.tsx (docs/index-spec.md
 * §6.2; WP IX-9): a popover rendered once by the sheet slot and opened through
 * `openServerMenu(server, anchor)`. This file keeps the old import path alive for
 * the Glass places panel, which IX-5 replaces; delete it with that panel.
 */
export { useServerMenu } from '../../ix/menus/ServerMenu';
export type { ServerMenuControl } from '../../ix/menus/ServerMenu';
export type { ServerRef } from '../../ix/menus/hostStore';
