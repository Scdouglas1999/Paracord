/**
 * A live stream as a frame source: the ambient view (the current server's
 * busiest stream) or the watch view (the stream on the stage), through
 * WP-G6's `subscribeViewFrames`, which follows the view across its engines.
 *
 * Two routes, one per engine and never switched:
 *   - `frames` (the browser client): decoded frames reach JavaScript; the tap
 *     hands them over.
 *   - `native-surface` (the desktop app): no frame reaches JavaScript; the tap
 *     reads stills of what the native side drew, at `size` at most.
 * `no-route` and `no-track` deliver nothing, and the room says it is waiting.
 */
import type { VideoTapRoute } from '../media/mediaEngine';
import { subscribeViewFrames } from '../../stores/voice/viewFrames';
import type { MediaViewKind } from '../../stores/voice/viewSessions';
import type { FrameSource } from './frameSource';

export interface ViewFrameSource extends FrameSource {
  readonly kind: 'stream';
  /** The route the view's track took, once known. */
  readonly route: VideoTapRoute | null;
}

/** How long `getLatestFrame` waits for the next frame of a stream. */
const LATEST_FRAME_WAIT_MS = 2_000;

/** What the room needs: its 32x18 grid, with room to average. */
export const ROOM_STILL_SIZE = { width: 64, height: 36 } as const;

export function createViewFrameSource(
  view: MediaViewKind,
  _streamerId: string,
  size: { width: number; height: number } = ROOM_STILL_SIZE,
): ViewFrameSource {
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
      let stopped = false;
      const release = subscribeViewFrames(
        view,
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
