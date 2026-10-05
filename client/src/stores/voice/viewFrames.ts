import {
  MAX_VIEW_SAMPLE_FPS,
  tapEngineFrames,
  type EngineFrameTapDeps,
  type StreamFrame,
} from '../../lib/media/engineFrameTap';
import type { MediaEngine, VideoTapRoute } from '../../lib/media/mediaEngine';
import { useVoiceStore } from '../voiceStore';
import type { MediaViewState } from './viewSessions';

export { MAX_VIEW_SAMPLE_FPS };

export interface ViewFrameOptions {
  /** Frames a second wanted (capped at 4). */
  fps?: number;
  /**
   * Where the frames come from, each time the view (re)attaches: `frames` (the
   * browser), `native-surface` (the desktop app's stills), or why there are
   * none (`no-route`, `no-track`). Never switched mid-stream.
   */
  onRoute?: (route: VideoTapRoute) => void;
  /** The largest still wanted on the desktop app's native route, each way
   * (proportions kept). Frames on the browser arrive at their own size. */
  size?: { width: number; height: number };
  /** For tests. */
  deps?: EngineFrameTapDeps;
}

/**
 * Sample the watched stream as `ImageBitmap`s (the subscriber owns each and
 * must `close()` it): a clip's thumbnail reads one. Follows the view across
 * its engines: when a call joined or left moves a watch from its own session
 * onto the call (or back), the tap moves with it. Nothing is delivered while
 * the view is not live. The call view renders the stream itself with
 * `watchView.engine.subscribeVideo`.
 */
export function subscribeViewFrames(
  onFrame: (frame: StreamFrame) => void,
  options: ViewFrameOptions = {},
): () => void {
  const cap = MAX_VIEW_SAMPLE_FPS;
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
      const tap = tapEngineFrames(engine, view.streamerId, 'screen', onFrame, fps, options.deps, options.size);
      current = { engine, streamerId: view.streamerId, release: () => tap.release() };
      void tap.route.then((route) => { if (!stopped) options.onRoute?.(route); });
    }
  };

  const select = (state: ReturnType<typeof useVoiceStore.getState>) => state.watchView;
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
