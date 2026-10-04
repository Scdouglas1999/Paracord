import { PlacesPanel } from '../../glass/places';
import { ErrorBoundary } from '../../ErrorBoundary';
import { PeopleSidebar } from '../people';
import type { SidebarSlotProps } from '../shell/slots';

/**
 * STUB (IX-4). Owner: IX-5, which replaces this file with the Index sidebar
 * (index-spec §4.1–4.7): header, search field, the inline card slot
 * (`<CardSlot place={place} position="inline" />` under the search), channels,
 * rooms, add-ons, coming up.
 *
 * Keep the People dispatch: `{ kind: 'people' }` renders IX-14's `PeopleSidebar`.
 *
 * Until IX-5 lands it shows the Glass places panel, which reads the route, not
 * `place` (so a pane sliding out shows the new route's server for its 450ms).
 */
export function SidebarSlot({ place }: SidebarSlotProps) {
  if (place.kind === 'people') return <PeopleSidebar />;
  return (
    <ErrorBoundary variant="section" label="Channels">
      <PlacesPanel presentation="pane" />
    </ErrorBoundary>
  );
}
