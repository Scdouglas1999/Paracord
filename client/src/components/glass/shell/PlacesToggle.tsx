import { ChevronLeft, PanelLeft } from 'lucide-react';
import { GlassButton } from '../primitives';
import { useGlassStore } from '../../../stores/glassStore';
import { usePhoneNavStore } from './phoneNav';
import { useGlassLayout } from './useGlassLayout';

/**
 * The button that brings places back (docs/glass-spec.md §3, §8).
 *
 * Compact (768 to 859px): places is an overlay, this opens it from the
 * conversation's header. Phone: places is its own screen and this is the back
 * button that returns to it. Renders nothing on the wide frame, where places is
 * a pane and there is nothing to open. The conversation header puts it first
 * in its row; on a page with no header the frame gives it a row of its own.
 */
export function PlacesToggle({ className }: { className?: string }) {
  const layout = useGlassLayout();
  const open = useGlassStore((s) => s.placesOverlayOpen);
  const setOpen = useGlassStore((s) => s.setPlacesOverlayOpen);
  const showPlaces = usePhoneNavStore((s) => s.showPlaces);
  if (layout === 'phone') {
    return (
      <GlassButton
        variant="icon"
        aria-label="Back to places"
        title="Places"
        className={className}
        onClick={showPlaces}
      >
        <ChevronLeft size={20} aria-hidden />
      </GlassButton>
    );
  }
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
