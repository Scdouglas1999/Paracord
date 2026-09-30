import { useRef } from 'react';
import { PlacesPanel } from '../places';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { usePresence } from '../../../lib/motion';
import { cn } from '../../../lib/utils';

/**
 * The places panel as an overlay (docs/glass-spec.md §3: below about 860px it
 * "becomes an overlay opened from the header"; §6.3 browse on a narrow window).
 *
 * The same 316px pane as on the wide frame, 16px from the window on three
 * sides, over a scrim. It is modal: focus moves in on open, is trapped, and
 * returns on close; Escape and the scrim close it. It enters with a transform
 * slide and a fade and leaves the same way (only transform and opacity move).
 */
export function PlacesOverlay({
  open,
  onClose,
  browsing,
}: {
  open: boolean;
  onClose: () => void;
  /** Opened by browse (S) over a stage rather than from the header. */
  browsing: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(open);
  useFocusTrap(panelRef, open, onClose);

  if (!presence.mounted) return null;
  return (
    <div
      className={cn('glass-places-overlay', presence.exiting ? 'is-leaving' : 'is-entering')}
      onClick={onClose}
      {...presence.scenery}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Places"
        tabIndex={-1}
        className="glass-pane glass-pane--glow glass-places-overlay__pane"
        data-presentation={browsing ? 'browse' : 'overlay'}
        onClick={(e) => e.stopPropagation()}
      >
        <PlacesPanel presentation={browsing ? 'browse' : 'overlay'} onClose={onClose} />
      </div>
    </div>
  );
}
