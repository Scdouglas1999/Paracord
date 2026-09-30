import { StreamViewer } from '../../../voice/StreamViewer';
import { ErrorBoundary } from '../../../ErrorBoundary';
import { useGlassStore } from '../../../../stores/glassStore';
import type { StageProps } from '../slots';

/**
 * STUB (WP-G7) for `components/glass/stage` — WP-G14 (side by side) and WP-G15
 * (theater, browse, the pill-to-stage move) replace it.
 *
 * Renders today's `StreamViewer` for the target inside the stage surface the
 * shell paints, with "Stop watching" wired to `glassStore.closeStage`. Nothing
 * opens the stage yet (Watch arrives with the pill, WP-G12); until then stream
 * viewing stays on the voice channel's own page. `StreamViewer` receives
 * through the call you are in, so this stub only shows a picture while you are
 * joined to `target.channelId`: watching without joining is WP-G6.
 */
export function Stage({ target, mode }: StageProps) {
  const closeStage = useGlassStore((s) => s.closeStage);
  return (
    <div className="glass-stub-stage" data-mode={mode}>
      <ErrorBoundary variant="section" label="the stream">
        <StreamViewer streamerId={target.streamerId} onStopWatching={closeStage} />
      </ErrorBoundary>
    </div>
  );
}
