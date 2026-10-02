import { useEffect, useRef } from 'react';
import { Maximize2 } from 'lucide-react';

import { useVoiceStore, type MediaViewState } from '../../../stores/voiceStore';
import { subscribeViewFrames } from '../../../stores/voice/viewFrames';
import type { PillTarget } from './model';

/**
 * The pill's 256x144 stream preview (docs/glass-spec.md §5: "click to watch").
 *
 * It draws the frames the media layer already receives: the watched stream when
 * this stream is the one being watched, else the room's ambient view of it
 * (`subscribeViewFrames`, docs/design/glass-g6-checkpoint.md). It never opens a
 * view of its own: an ambient view is one per client and belongs to the room
 * light (WP-G8), and a watch belongs to the stage (WP-G14). With no frames (no
 * view of this stream, the desktop app's native surface route, or a view that is
 * still connecting) it shows the room's tint, and the label still says whose
 * screen it is.
 *
 * It is the second door to an action the bar's Watch button already opens, so a
 * screen reader hears one button, not two with the same name (glass-g22
 * checkpoint, "left for others"): while that button is on screen the preview is
 * `redundant`, hidden from the accessibility tree and out of the tab order, and
 * stays a big target for the mouse. Where the bar has no Watch button (a phone
 * with the stage already open) the preview is the only door and keeps its name.
 */

const WIDTH = 512;
const HEIGHT = 288;

/** Does this view carry this stream, and is it live? */
function carries(view: MediaViewState | null, target: PillTarget, streamerId: string): boolean {
  return Boolean(
    view
    && view.phase === 'live'
    && view.channelId === target.channelId
    && view.streamerId === streamerId
    && view.scope.serverId === target.serverId,
  );
}

/** The kind of view that can feed this preview right now, if any. */
function feedFor(
  watch: MediaViewState | null,
  ambient: MediaViewState | null,
  target: PillTarget,
  streamerId: string,
): 'watch' | 'ambient' | null {
  if (carries(watch, target, streamerId)) return 'watch';
  if (carries(ambient, target, streamerId)) return 'ambient';
  return null;
}

export interface PillPreviewProps {
  target: PillTarget;
  streamerId: string;
  /** "Vincent's screen". */
  label: string;
  onWatch: () => void;
  /** The bar's own Watch button is drawn: this one is only for the mouse. */
  redundant?: boolean;
}

export function PillPreview({ target, streamerId, label, onWatch, redundant = false }: PillPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const watchView = useVoiceStore((state) => state.watchView);
  const ambientView = useVoiceStore((state) => state.ambientView);
  const feed = feedFor(watchView, ambientView, target, streamerId);
  // Re-subscribe only when the source changes, not on every view state change.
  const engine = feed === 'watch' ? watchView?.engine : feed === 'ambient' ? ambientView?.engine : null;

  useEffect(() => {
    if (!feed) return undefined;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    return subscribeViewFrames(
      feed,
      ({ bitmap }) => {
        // Cover the box, keeping the picture's proportions.
        const scale = Math.max(WIDTH / bitmap.width, HEIGHT / bitmap.height);
        const w = bitmap.width * scale;
        const h = bitmap.height * scale;
        context.drawImage(bitmap, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
        bitmap.close();
      },
      { fps: 4 },
    );
  }, [feed, engine]);

  return (
    <button
      type="button"
      className="glass-pill__preview glass-focusable"
      aria-label={`Watch ${label.replace(/^Your screen$/, 'your screen')}`}
      aria-hidden={redundant || undefined}
      tabIndex={redundant ? -1 : undefined}
      onClick={onWatch}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="glass-pill__preview-shade" aria-hidden="true" />
      <span className="glass-pill__preview-label">{label}</span>
      <Maximize2 className="glass-pill__preview-expand" size={15} strokeWidth={1.7} aria-hidden="true" />
    </button>
  );
}
