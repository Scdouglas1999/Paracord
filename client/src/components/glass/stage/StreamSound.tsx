import { useCallback, useRef, useState } from 'react';
import { create } from 'zustand';
import { Volume1, Volume2, VolumeX } from 'lucide-react';

import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { cn } from '../../../lib/utils';
import { useVoiceStore } from '../../../stores/voiceStore';
import { StreamOverlayPortal, useAnchoredOverlayCoords, useOverlayDismiss } from '../../voice/streamOverlayPortal';

/**
 * The watched stream's sound and picture quality (from the Lantern stream
 * viewer): its own volume (0 to 100%, and mute), and which simulcast layer to
 * ask the relay for (Auto lets the relay choose for your connection).
 *
 * The volume is `voiceStore.watchVolume`: it applies to the watch now and to
 * the next one. The quality is asked of the watch's engine by the stream box
 * (`StreamSurface`), which knows the canvas it draws into.
 */

export const WATCH_QUALITIES = [
  { value: 'auto', label: 'Auto', layer: null },
  { value: 'low', label: 'Low', layer: 0 },
  { value: 'medium', label: 'Medium', layer: 1 },
  { value: 'high', label: 'High', layer: 2 },
  { value: 'source', label: 'Source', layer: 2 },
] as const;

export type WatchQuality = (typeof WATCH_QUALITIES)[number]['value'];

export const useWatchQualityStore = create<{ quality: WatchQuality; setQuality: (quality: WatchQuality) => void }>()(
  (set) => ({ quality: 'auto', setQuality: (quality) => set({ quality }) }),
);

/** The simulcast layer a quality asks for; null lets the relay choose. */
export function layerFor(quality: WatchQuality): number | null {
  return WATCH_QUALITIES.find((option) => option.value === quality)?.layer ?? null;
}

const PANEL_W = 264;

export function StreamSoundButton({ className }: { className?: string }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const volume = useVoiceStore((state) => state.watchVolume);
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cn('glass-stage__sbtn glass-focusable', className)}
        aria-label="Stream sound and quality"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={volume === 0 ? 'The stream is muted' : `Stream volume ${Math.round(volume * 100)}%`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
      </button>
      <StreamSoundMenu open={open} anchorRef={anchorRef} onClose={close} />
    </>
  );
}

function StreamSoundMenu({
  open,
  anchorRef,
  onClose,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const coords = useAnchoredOverlayCoords(open, anchorRef, 'below-end', PANEL_W, 10);
  const volume = useVoiceStore((state) => state.watchVolume);
  const setWatchVolume = useVoiceStore((state) => state.setWatchVolume);
  const quality = useWatchQualityStore((state) => state.quality);
  const setQuality = useWatchQualityStore((state) => state.setQuality);
  // What unmuting goes back to: the volume the stream had when it was muted.
  const lastHeard = useRef(1);
  const inside = useCallback(
    (target: Node) => Boolean(panelRef.current?.contains(target) || anchorRef.current?.contains(target)),
    [anchorRef],
  );
  useOverlayDismiss(open, onClose, inside, { escape: false });
  useFocusTrap(panelRef, open && coords !== null, onClose);
  if (!open || !coords) return null;
  const percent = Math.round(Math.min(1, volume) * 100);
  return (
    <StreamOverlayPortal
      panelRef={panelRef}
      role="dialog"
      aria-label="Stream sound and quality"
      className="glass-stage-popover"
      style={{ ...coords, width: PANEL_W }}
    >
      <div className="glass-stage-popover__body">
        <div className="glass-stage-popover__field">
          <span className="glass-stage-popover__kicker">Stream sound</span>
          <span className="glass-stage-popover__volume">
            <button
              type="button"
              className="glass-stage-popover__mute glass-focusable"
              aria-label={volume === 0 ? 'Unmute the stream' : 'Mute the stream'}
              aria-pressed={volume === 0}
              onClick={() => {
                if (volume === 0) {
                  setWatchVolume(lastHeard.current);
                  return;
                }
                lastHeard.current = volume;
                setWatchVolume(0);
              }}
            >
              {volume === 0 ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={percent}
              aria-label="Stream volume"
              aria-valuetext={`${percent}%`}
              className="glass-stage-popover__range glass-focusable"
              onChange={(event) => setWatchVolume(Number(event.target.value) / 100)}
            />
            <span className="glass-instrument glass-stage-popover__hint">{percent}%</span>
          </span>
        </div>
        <label className="glass-stage-popover__field">
          <span className="glass-stage-popover__kicker">Viewing quality</span>
          <select
            className="glass-stage-popover__select glass-focusable"
            value={quality}
            onChange={(event) => setQuality(event.target.value as WatchQuality)}
          >
            {WATCH_QUALITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </StreamOverlayPortal>
  );
}
