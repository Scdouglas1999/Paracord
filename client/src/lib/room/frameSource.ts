/**
 * The frame source contract (docs/design/glass-plan.md §1.2, "Frame source
 * contract").
 *
 * Room light, the stream thumbnail, the ambient spill behind the stage and the
 * pill's preview all want the same thing: a small, steady trickle of decoded
 * frames from somewhere, at a rate the CONSUMER picks. This is the seam. A
 * consumer never asks where the frames come from; a source never asks who is
 * looking.
 *
 * Implementations (each owned by the package that has the pixels):
 *   - stream   the joined call's screen share or camera (WP-G6's tap, at most
 *              4 Hz, extending `lib/media/roomFrameTap.ts`)
 *   - image    a still, such as a server banner or icon
 *   - fixture  a looping canvas scene for review shots with no media server
 *              (`fixtureFrameSource.ts`, DEV builds only)
 *
 * Ownership: every bitmap handed to `onFrame` belongs to that subscriber, who
 * must `close()` it. `getLatestFrame()` returns a fresh bitmap the caller also
 * owns and must close. Two subscribers never share a bitmap, so one closing its
 * copy cannot blank the other.
 */
export interface FrameSource {
  /** Where the pixels come from. Consumers may show it; they never branch on it. */
  readonly kind: 'stream' | 'image' | 'fixture';
  /** Intrinsic size of every frame this source produces, in pixels. */
  readonly width: number;
  readonly height: number;
  /**
   * Start delivering frames to `onFrame`, at most `hz` per second. Delivery
   * begins with one frame as soon as one exists. The source does no work while
   * it has no subscriber; the returned function unsubscribes and, for the last
   * subscriber, stops the source.
   */
  subscribe(onFrame: (frame: ImageBitmap) => void, hz: number): () => void;
  /**
   * The most recent frame, or `null` when the source has produced none yet. For
   * a one-off read (a thumbnail on mount) where a subscription would be
   * overkill. The caller owns the bitmap.
   */
  getLatestFrame(): Promise<ImageBitmap | null>;
}
