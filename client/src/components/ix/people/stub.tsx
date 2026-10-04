import { PlacesPanel } from '../../glass/places';
import { ErrorBoundary } from '../../ErrorBoundary';

/**
 * STUB (IX-4). Owner: IX-14, which replaces this file with the People sidebar
 * (index-spec §6.6): header, "Search people", Friends and Inbox rows, Messages.
 *
 * `SidebarSlot` renders it for `{ kind: 'people' }`, inside the pane (the
 * scroller; padding 16 12 8). Until IX-14 it shows the Glass places panel, which
 * draws Home's conversations from the route.
 */
export function PeopleSidebar() {
  return (
    <ErrorBoundary variant="section" label="People">
      <PlacesPanel presentation="pane" />
    </ErrorBoundary>
  );
}
