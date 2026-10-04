/**
 * The dock (docs/index-spec.md §4.8; owner: IX-6). Contract: `DockSlotProps` in
 * components/ix/shell/slots.ts. Mounted by the shell at the sidebar's foot.
 *
 *   DockSlot ............ the toolbar "Servers": People, the servers, `+`; also mounts
 *                         the Add a server sheet and the server menu it opens
 *   openAddServer ....... open the Add a server sheet from anywhere (on Create, Join or Discover)
 *   useGoToPlace ........ switch place the way a click on the dock does (shortcuts use it)
 *   placeKeyAction ...... Ctrl+Alt+Up/Down and Ctrl+1…9, as pure functions (`hooks/useKeyboardNavigation`)
 */
export { Dock as DockSlot } from './Dock';
export type { DockSlotProps } from '../shell/slots';
export { closeAddServer, openAddServer, useAddServerStore } from './addServerStore';
export type { AddServerTab } from './addServerStore';
export { nthServer, placeKeyAction, stepPlace } from './dockModel';
export type { PlaceKeyAction } from './dockModel';
export { useGoToPlace } from './usePlaceNavigation';
