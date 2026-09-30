import {
  AMBIENT_SAMPLE_MAX_FPS,
  MAX_VIEW_SAMPLE_FPS,
  tapEngineFrames,
  type EngineFrameTapDeps,
  type RoomFrame,
} from '../../lib/media/roomFrameTap';
import type { MediaEngine, VideoTapRoute } from '../../lib/media/mediaEngine';
import { useVoiceStore } from '../voiceStore';
import type { MediaViewKind, MediaViewState } from './viewSessions';

export { AMBIENT_SAMPLE_MAX_FPS, MAX_VIEW_SAMPLE_FPS };

export interface ViewFrameOptions {
  /** Frames a second wanted (capped: ambient 1, watch 4). */
  fps?: number;
  /**
   * Where the frames come from, each time the view (re)attaches: `frames`, or
   * why there are none (`native-surface` on the desktop's platform-surface
   * route, `no-route`, `no-track`). Never switched mid-stream.
   */
  onRoute?: (route: VideoTapRoute) => void;
  /** For tests. */
  deps?: EngineFrameTapDeps;
}

/**
 * Sample the watched stream or the ambient view as `ImageBitmap`s (the
 * subscriber owns each and must `close()` it). Follows the view across its
 * engines: when a call joined or left moves a watch from its own session onto
 * the call (or back), the tap moves with it. Nothing is delivered while the
 * view is not live.
 *
 * WP-G8 samples `ambient` (room light) and `watch` (the stage's glow) here;
 * WP-G14 renders the watched stream with `watchView.engine.subscribeVideo`.
 */
export function subscribeViewFrames(
  kind: MediaViewKind,
  onFrame: (frame: RoomFrame) => void,
  options: ViewFrameOptions = {},
): () => void {
  const cap = kind === 'ambient' ? AMBIENT_SAMPLE_MAX_FPS : MAX_VIEW_SAMPLE_FPS;
  const fps = Math.min(options.fps ?? cap, cap);
  let current: { engine: MediaEngine; streamerId: string; release: () => void } | null = null;
  let stopped = false;

  const sync = (view: MediaViewState | null) => {
    if (stopped) return;
    const engine = view?.phase === 'live' ? view.engine : null;
    if (current && (current.engine !== engine || current.streamerId !== view?.streamerId)) {
      current.release();
      current = null;
    }
    if (!current && engine && view) {
      const tap = tapEngineFrames(engine, view.streamerId, 'screen', onFrame, fps, options.deps);
      current = { engine, streamerId: view.streamerId, release: () => tap.release() };
      void tap.route.then((route) => { if (!stopped) options.onRoute?.(route); });
    }
  };

  const select = (state: ReturnType<typeof useVoiceStore.getState>) =>
    kind === 'watch' ? state.watchView : state.ambientView;
  sync(select(useVoiceStore.getState()));
  const unsubscribe = useVoiceStore.subscribe((state, previous) => {
    if (select(state) !== select(previous)) sync(select(state));
  });
  return () => {
    stopped = true;
    unsubscribe();
    current?.release();
    current = null;
  };
}
