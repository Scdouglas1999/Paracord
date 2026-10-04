/**
 * Index menus (docs/index-spec.md §6.2-6.6, §6.9; owner IX-9): the server menu,
 * channel menu, People menu, account menu and the profile card, all mounted once
 * by the sheet slot (`MenuHost`) and opened through the functions below.
 *
 *   openServerMenu(server, anchor)        the header's "...", a right click on the
 *                                         header or a dock mark   (IX-5, IX-6)
 *   openChannelMenu({ subject, summary }, anchor)   the large / folded title   (IX-15)
 *   openPeopleMenu(anchor)                the People header's "..."          (IX-14)
 *   openAccountMenu()                     the toolbar's avatar               (IX-4)
 *   openProfileCard(user, { x, y })       a face, anywhere
 *   openHelp()                            Keyboard shortcuts (also Ctrl /)
 *   openCreateChannel({ guildId, scope, kind, parentId? })   a category's "+"
 *
 * `MenuAnchor` is `{ element, align?: 'start' | 'end' }` (under a button) or
 * `{ x, y }` (at the pointer); `anchorFromEvent(event)` makes one from a click or
 * a right click. See docs/design/index-checkpoints/IX-9.md.
 */
export { ACCOUNT_MENU_ANCHOR, openAccountMenu } from './accountMenuOpener';
export { anchorFromEvent } from './anchor';
export type { MenuAnchor } from './anchor';
export {
  closeCreateChannel,
  closeHelp,
  closeMenu,
  closeProfileCard,
  openChannelMenu,
  openCreateChannel,
  openDmPicker,
  openHelp,
  openInvite,
  openPeopleMenu,
  openProfileCard,
  openServerMenu,
  useMenuHostStore,
  useServerMenuOpenFor,
} from './hostStore';
export type {
  ChannelMenuRequest,
  ChannelMenuSubject,
  CreateChannelRequest,
  InviteRequest,
  ProfileSubject,
  ServerRef,
} from './hostStore';
export { buildServerMenu, serverLink, useServerMenu } from './ServerMenu';
export type { ServerMenuActions, ServerMenuInput } from './ServerMenu';
export { buildChannelMenu, channelLink } from './ChannelMenu';
export type { ChannelMenuActions, ChannelMenuInput } from './ChannelMenu';
export { buildPeopleMenu } from './PeopleMenu';
export { IxMenu, IxMenuItems, IxMenuSurface } from './IxMenu';
export type { IxMenuEntry, IxMenuItemEntry, MenuCloseReason } from './IxMenu';
