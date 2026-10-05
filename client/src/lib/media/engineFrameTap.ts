/**
 * A read-only tap on the media pipeline: samples of a remote track as
 * `ImageBitmap`s, for a clip's thumbnail (`viewFrameSource.ts`).
 *
 * It **adds nothing to the delivery path**: it rides
 * `MediaEngine.tapVideoFrames` and never touches the decoder, the transport,
 * the relay or the tile the call view renders.
 */

import type { MediaEngine, VideoTapRoute } from './mediaEngine';

/** One sampled still. The caller owns the bitmap and must `close()` it. */
export interface StreamFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  capturedAt: number;
}

/**
 * The fastest any sampler may take frames from a stream: a thumbnail needs one
 * still, so four a second is already more than any consumer can use
 * (docs/design/glass-plan.md §1.2, "≤ 4 Hz ImageBitmaps").
 */
export const MAX_VIEW_SAMPLE_FPS = 4;

export interface EngineFrameTap {
  /** Where the frames come from: `frames` (decoded in the page) or
   * `native-surface` (stills of the desktop app's native video). */
  readonly route: Promise<VideoTapRoute>;
  release(): void;
}

export interface EngineFrameTapDeps {
  now: () => number;
  /** Decoded frame to bitmap. Injected so the tap is testable in jsdom. */
  toBitmap: (frame: VideoFrame) => Promise<ImageBitmap>;
  /** Timers for the native route's still polling. Injected for tests. */
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultTapDeps: EngineFrameTapDeps = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  toBitmap: (frame) => createImageBitmap(frame),
};

/** The size a sampler gets its stills at unless it asks. */
export const DEFAULT_STILL_SIZE = { width: 512, height: 288 } as const;

/**
 * Sample one remote track at no more than `fps` (capped at
 * {@link MAX_VIEW_SAMPLE_FPS}), as `ImageBitmap`s the subscriber owns and must
 * `close()`. Rides `MediaEngine.tapVideoFrames`: no canvas, no second decoder
 * when a surface already shows the track, and never a layer change for it.
 *
 * Two routes, one per engine:
 *   - `frames` (the browser): decoded frames arrive here; ones faster than
 *     the rate, or while a conversion is in flight, are closed at once, so a
 *     60 fps stream costs one `createImageBitmap` per sample and nothing else.
 *   - `native-surface` (the desktop app): no frame reaches the page, so the tap
 *     reads the native side's stills at the rate, at most `size` (proportions
 *     kept), skipping a still it already has (a still screen costs nothing).
 */
export function tapEngineFrames(
  engine: MediaEngine,
  userId: string,
  track: 'screen' | 'camera',
  onFrame: (frame: StreamFrame) => void,
  fps: number,
  deps: EngineFrameTapDeps = defaultTapDeps,
  size: { width: number; height: number } = DEFAULT_STILL_SIZE,
): EngineFrameTap {
  const rate = Math.max(0.1, Math.min(fps, MAX_VIEW_SAMPLE_FPS));
  const interval = 1000 / rate;
  const schedule = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const unschedule = deps.clearTimeout ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
  let stopped = false;
  let converting = false;
  let lastAt = -Infinity;
  let stillTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeq: number | undefined;
  const tap = engine.tapVideoFrames(userId, track, (frame) => {
    const at = deps.now();
    if (stopped || converting || at - lastAt < interval) {
      frame.close();
      return;
    }
    lastAt = at;
    converting = true;
    void deps
      .toBitmap(frame)
      .then((bitmap) => {
        if (stopped) {
          bitmap.close();
          return;
        }
        onFrame({ bitmap, width: bitmap.width, height: bitmap.height, capturedAt: Date.now() });
      })
      .catch(() => {
        /* a dropped sample is a dropped sample */
      })
      .finally(() => {
        frame.close();
        converting = false;
      });
  });

  const pollStill = async () => {
    stillTimer = null;
    if (stopped || !engine.readVideoStill) return;
    try {
      const still = await engine.readVideoStill(userId, track, size.width, size.height, lastSeq);
      if (still) {
        lastSeq = still.seq;
        if (stopped) still.bitmap.close();
        else onFrame({ bitmap: still.bitmap, width: still.bitmap.width, height: still.bitmap.height, capturedAt: Date.now() });
      }
    } catch (error) {
      // The shell could not read the frame back: loud, and the sampler stops
      // (a retry would fail the same way at the same rate).
      console.error('[media] the native video still could not be read; sampling stops', {
        userId,
        track,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!stopped) stillTimer = schedule(() => void pollStill(), interval);
  };
  void tap.route.then((route) => {
    if (route === 'native-surface' && !stopped) void pollStill();
  });

  return {
    route: tap.route,
    release: () => {
      if (stopped) return;
      stopped = true;
      if (stillTimer !== null) unschedule(stillTimer);
      stillTimer = null;
      tap.release();
    },
  };
}
