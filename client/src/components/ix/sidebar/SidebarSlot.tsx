import { PeopleSidebar } from '../people';
import { usePeopleMemory } from '../people/usePeopleMemory';
import type { SidebarSlotProps } from '../shell/slots';
import { ServerSidebar } from './ServerSidebar';

/**
 * The sidebar slot (docs/index-spec.md §4.1-4.7; contract `SidebarSlotProps` in
 * components/ix/shell/slots.ts). Mounted once per pane by the frame: the pane is
 * the scroller (padding 16 12 8, a flex column whose children never shrink) and
 * this renders what is in it, for the place it is given and never the route's.
 *
 * `{ kind: 'people' }` is IX-14's `PeopleSidebar`; that dispatch is kept here. The slot
 * is mounted for every place and every app route, so it is also where IX-14 asks for
 * the memory of where you were (`usePeopleMemory`: `/app` opens it).
 */
export function SidebarSlot({ place, leaving = false }: SidebarSlotProps) {
  usePeopleMemory(!leaving);
  if (place.kind === 'people') return <PeopleSidebar leaving={leaving} />;
  return <ServerSidebar guildId={place.guildId} leaving={leaving} />;
}
