import { PanelLeft } from 'lucide-react';
import { GlassButton } from '../primitives';
import { useGlassStore } from '../../../stores/glassStore';
import { useGlassLayout } from './useGlassLayout';

/**
 * The header button that opens the places overlay below 860px (spec §3).
 * Renders nothing on the wide frame (places is a pane there) and on the phone
 * frame (which keeps its own navigation until WP-G20). The conversation header
 * (the stub today, WP-G11's ConversationHeader next) puts it first in its row.
 */
export function PlacesToggle({ className }: { className?: string }) {
  const layout = useGlassLayout();
  const open = useGlassStore((s) => s.placesOverlayOpen);
  const setOpen = useGlassStore((s) => s.setPlacesOverlayOpen);
  if (layout !== 'compact') return null;
  return (
    <GlassButton
      variant="icon"
      aria-label="Show places"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Places"
      className={className}
      onClick={() => setOpen(!open)}
    >
      <PanelLeft size={18} aria-hidden />
    </GlassButton>
  );
}
