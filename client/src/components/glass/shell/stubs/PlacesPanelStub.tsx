import { UnifiedSidebar } from '../../../layout/sidebar/UnifiedSidebar';
import { ErrorBoundary } from '../../../ErrorBoundary';
import type { PlacesPanelProps } from '../slots';

/**
 * STUB (WP-G7) for `components/glass/places` — WP-G9 replaces it with the
 * places panel of spec §3.1.
 *
 * Renders today's navigation (the Lantern `UnifiedSidebar`: servers, rooms,
 * the call dock and the account plate) always expanded, inside the pane the
 * shell paints. `glass-stub-places` is the hook for the adapter rules in
 * styles/glass-layout.css that fit the sidebar to the pane; they match nothing
 * once this stub is gone.
 */
export function PlacesPanel({ presentation }: PlacesPanelProps) {
  return (
    <div className="glass-stub-places" data-presentation={presentation}>
      {/* The places panel owns navigation; if it throws, the rest of the app
          must stay reachable rather than lose the whole shell. */}
      <ErrorBoundary variant="section" label="the places panel">
        <UnifiedSidebar alwaysExpanded />
      </ErrorBoundary>
    </div>
  );
}
