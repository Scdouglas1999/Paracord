import { ChevronLeft } from 'lucide-react';
import { GlassButton } from '../primitives';
import { usePhoneNavStore } from './phoneNav';
import { useGlassLayout } from './useGlassLayout';

/**
 * The button that brings places back (docs/glass-spec.md §8).
 *
 * Phone: places is its own screen and this is the back button that returns to
 * it. Renders nothing on any wider window: the Index frame (IX-4) always shows
 * the sidebar as a column there, and the Glass compact overlay this used to open
 * below 860px is retired (docs/index-spec.md §3). The conversation header puts
 * it first in its row.
 */
export function PlacesToggle({ className }: { className?: string }) {
  const layout = useGlassLayout();
  const showPlaces = usePhoneNavStore((s) => s.showPlaces);
  if (layout !== 'phone') return null;
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
