/**
 * A live stream as a frame source: the ambient view (the current server's
 * busiest stream) or the watch view (the stream on the stage), through
 * WP-G6's `subscribeViewFrames`, which follows the view across its engines.
 *
 * Two routes, decided once per track by the engine and never switched:
 *   - `frames`: decoded frames reach JavaScript; the tap hands them over.
 *   - `native-surface` (the desktop app when WebCodecs cannot decode): no
 *     frame reaches JavaScript, so the room asks the shell for its downsample
 *     of the surface instead (`nativeSample.ts`).
 * `no-route` and `no-track` deliver nothing, and the room says it is waiting.
 */
import type { VideoTapRoute } from '../media/mediaEngine';
import { subscribeViewFrames } from '../../stores/voice/viewFrames';
import type { MediaViewKind } from '../../stores/voice/viewSessions';
import { useVoiceStore } from '../../stores/voiceStore';
import type { FrameSource } from './frameSource';
import { startNativeSampling } from './nativeSample';

export interface ViewFrameSource extends FrameSource {
  readonly kind: 'stream';
  /** The route the view's track took, once known. */
  readonly route: VideoTapRoute | null;
}

/** How long `getLatestFrame` waits for the next frame of a stream. */
const LATEST_FRAME_WAIT_MS = 2_000;

export function createViewFrameSource(view: MediaViewKind, streamerId: string): ViewFrameSource {
  let route: VideoTapRoute | null = null;

  const source: ViewFrameSource = {
    kind: 'stream',
    // A stream's size is whatever layer arrives; the room crops to 16:9 anyway.
    width: 0,
    height: 0,
    get route() {
      return route;
    },
    subscribe(onFrame, hz) {
      let stopNative: (() => void) | null = null;
      let stopped = false;
      const release = subscribeViewFrames(
        view,
        (frame) => {
          if (stopped) frame.bitmap.close();
          else onFrame(frame.bitmap);
        },
        {
          fps: hz,
          onRoute: (next) => {
            route = next;
            stopNative?.();
            stopNative = null;
            if (next !== 'native-surface' || stopped) return;
            const state = useVoiceStore.getState();
            const engine = (view === 'watch' ? state.watchView : state.ambientView)?.engine;
            if (!engine) return;
            stopNative = startNativeSampling({ engine, streamerId, hz, onFrame });
          },
        },
      );
      return () => {
        stopped = true;
        release();
        stopNative?.();
        stopNative = null;
      };
    },
    getLatestFrame() {
      return new Promise<ImageBitmap | null>((resolve) => {
        let done = false;
        const finish = (frame: ImageBitmap | null) => {
          if (done) {
            frame?.close();
            return;
          }
          done = true;
          clearTimeout(timer);
          queueMicrotask(() => stop());
          resolve(frame);
        };
        const timer = setTimeout(() => finish(null), LATEST_FRAME_WAIT_MS);
        const stop = source.subscribe((frame) => finish(frame), 4);
      });
    },
  };
  return source;
}
