import { PeopleSidebar } from '../people';
import type { SidebarSlotProps } from '../shell/slots';
import { ServerSidebar } from './ServerSidebar';

/**
 * The sidebar slot (docs/index-spec.md §4.1-4.7; contract `SidebarSlotProps` in
 * components/ix/shell/slots.ts). Mounted once per pane by the frame: the pane is
 * the scroller (padding 16 12 8, a flex column whose children never shrink) and
 * this renders what is in it, for the place it is given and never the route's.
 *
 * `{ kind: 'people' }` is IX-14's `PeopleSidebar`; that dispatch is kept here.
 */
export function SidebarSlot({ place, leaving = false }: SidebarSlotProps) {
  if (place.kind === 'people') return <PeopleSidebar />;
  return <ServerSidebar guildId={place.guildId} leaving={leaving} />;
}
