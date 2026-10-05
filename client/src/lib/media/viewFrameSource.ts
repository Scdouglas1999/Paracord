/**
 * The watched stream as a frame source (a clip's thumbnail reads one still),
 * through `subscribeViewFrames`, which follows the view across its engines.
 *
 * Two routes, one per engine and never switched:
 *   - `frames` (the browser client): decoded frames reach JavaScript; the tap
 *     hands them over.
 *   - `native-surface` (the desktop app): no frame reaches JavaScript; the tap
 *     reads stills of what the native side drew, at `size` at most.
 * `no-route` and `no-track` deliver nothing.
 */
import type { VideoTapRoute } from './mediaEngine';
import { subscribeViewFrames } from '../../stores/voice/viewFrames';
import type { FrameSource } from './frameSource';

export interface ViewFrameSource extends FrameSource {
  readonly kind: 'stream';
  /** The route the view's track took, once known. */
  readonly route: VideoTapRoute | null;
}

/** How long `getLatestFrame` waits for the next frame of a stream. */
const LATEST_FRAME_WAIT_MS = 2_000;

export function createViewFrameSource(size: { width: number; height: number }): ViewFrameSource {
  let route: VideoTapRoute | null = null;

  const source: ViewFrameSource = {
    kind: 'stream',
    // A stream's size is whatever layer arrives.
    width: 0,
    height: 0,
    get route() {
      return route;
    },
    subscribe(onFrame, hz) {
      let stopped = false;
      const release = subscribeViewFrames(
        (frame) => {
          if (stopped) frame.bitmap.close();
          else onFrame(frame.bitmap);
        },
        {
          fps: hz,
          size,
          onRoute: (next) => {
            route = next;
          },
        },
      );
      return () => {
        stopped = true;
        release();
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
