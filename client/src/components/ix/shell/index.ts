/**
 * The Index shell's API for the packages that fill it (docs/design/index-plan.md
 * §1.3; checkpoint docs/design/index-checkpoints/IX-4.md).
 *
 * `IxFrame` itself is NOT exported here: it imports every slot, and the slots
 * import this barrel, so AppShell imports it by path
 * (`components/ix/shell/IxFrame`). Everything here is safe to import from a slot.
 *
 *   slots.ts ........ the slot props contract and the host ids
 *   place.ts ........ Place, placeKey, samePlace, placeOfPath, placeDirection
 *   usePlace.ts ..... useCurrentPlace, usePlaceOrder (dock order), usePlaceHue,
 *                     usePlaceName, useIxPlaceStore (the last place)
 *   IxShellContext .. useIxShell(): { layout, place, guildId, channelId }
 *   useIxLayout ..... 'wide' | 'narrow' | 'phone'
 *   toolbarStore .... useToolbar(page): what the page tells the toolbar
 *   TintLayers ...... a hue as crossfading layers (for a surface outside the frame
 *                     that wants the window's tint)
 */
export type {
  CallSlotProps,
  CardPosition,
  CardSlotProps,
  DockSlotProps,
  SheetSlotProps,
  SidebarSlotProps,
} from './slots';
export { IX_CALL_HOST_ID, IX_SHEET_HOST_ID } from './slots';
export { PEOPLE_PLACE, placeDirection, placeKey, placeOfPath, samePlace, serverPlace } from './place';
export type { Place } from './place';
export { useCurrentPlace, useIxPlaceStore, usePlaceHue, usePlaceName, usePlaceOrder } from './usePlace';
export { useIxShell, useOptionalIxShell } from './IxShellContext';
export type { IxShellValue } from './IxShellContext';
export { IX_NARROW_MAX_WIDTH, useIxLayout } from './useIxLayout';
export type { IxLayout } from './useIxLayout';
export { useToolbar, useToolbarStore } from './toolbarStore';
export type { ToolbarPage } from './toolbarStore';
export { TintLayers } from './TintLayers';
export type { TintLayersProps } from './TintLayers';
