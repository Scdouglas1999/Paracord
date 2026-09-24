/**
 * One simulcast layer's outbound video, serialised and bounded.
 *
 * A `VideoEncoder`'s output callback is synchronous and publishing a frame is
 * not: a keyframe is encrypted and then written to a **fresh WebTransport
 * unidirectional stream**, which the browser will refuse once the connection's
 * uni-stream credit runs out ("Failed to create send stream."). Calling the
 * publish path straight from the callback therefore did two bad things at once:
 * every frame raced every other frame onto the transport, and every refusal
 * became an unhandled promise rejection — 299 of 552 stream opens in one
 * measured screen-share run, surfacing as uncaught page errors.
 *
 * This queue is the fix, and it is deliberately small: one send in flight, a
 * short backlog behind it, and no rejection that escapes.
 *
 * **Back-pressure.** When the backlog is full the queue drops frames rather
 * than growing, because video is live and a late frame is worth nothing:
 *
 * - a keyframe clears the delta frames waiting behind it — none of them can be
 *   decoded without a keyframe that is now newer than they are — and takes
 *   their place;
 * - a delta frame arriving into a full queue is dropped, and so is every delta
 *   after it until the next keyframe: each one predicts from the frame before
 *   it, so once one is missing the rest decode to garbage or, in a WebCodecs
 *   decoder, to "Decoding error" and a decoder that is closed for good. The
 *   queue reports the break once (`onChainBroken`) so the publisher can encode
 *   a keyframe now instead of at its next scheduled one.
 *
 * A send that fails breaks the chain the same way.
 *
 * **One queue per layer.** Every simulcast layer is its own chain. A shared
 * queue let one layer's keyframe clear another layer's deltas (and another
 * layer's keyframe), and let a slow keyframe stream on one layer starve the
 * rest — which is how a viewer came to be sent a keyframe and then a delta that
 * did not follow from it.
 */

/** One queued frame, with the one fact back-pressure needs to know about it. */
interface QueuedFrame<T> {
  frame: T;
  isKeyframe: boolean;
}

export interface VideoSendQueueOptions {
  /**
   * How many frames may wait behind the one being sent. Two is a beat of slack
   * for a transport that stutters, and far short of a visible delay.
   */
  depth?: number;
  /**
   * Told when a send fails — the first failure of a run, and then every
   * `errorReportInterval`th, so a transport that is refusing every stream says
   * so once rather than thousands of times.
   */
  onError?: (error: unknown, stats: VideoSendQueueStats) => void;
  /**
   * Told when a frame of this layer's chain is lost (dropped for back-pressure
   * or refused by the transport). Deltas are withheld from then until the next
   * keyframe; the listener should ask the encoder for one.
   */
  onChainBroken?: (stats: VideoSendQueueStats) => void;
}

export interface VideoSendQueueStats {
  /** Frames dropped for back-pressure. */
  dropped: number;
  /** Sends that rejected. */
  failed: number;
  /** Sends that have rejected in an unbroken run up to now. */
  consecutiveFailures: number;
  /** Times the chain broke and the queue began waiting for a keyframe. */
  chainBreaks: number;
}

/** How many failures apart the repeat reports are. */
const ERROR_REPORT_INTERVAL = 60;

export class VideoSendQueue<T> {
  private readonly queue: Array<QueuedFrame<T>> = [];
  private readonly depth: number;
  private readonly onError?: VideoSendQueueOptions['onError'];
  private readonly onChainBroken?: VideoSendQueueOptions['onChainBroken'];
  private pump: Promise<void> | null = null;
  private stopped = false;
  private awaitingKeyframe = false;
  private dropped = 0;
  private failed = 0;
  private consecutiveFailures = 0;
  private chainBreaks = 0;

  constructor(
    private readonly send: (frame: T) => Promise<void>,
    options: VideoSendQueueOptions = {},
  ) {
    this.depth = Math.max(1, options.depth ?? 2);
    this.onError = options.onError;
    this.onChainBroken = options.onChainBroken;
  }

  get stats(): VideoSendQueueStats {
    return {
      dropped: this.dropped,
      failed: this.failed,
      consecutiveFailures: this.consecutiveFailures,
      chainBreaks: this.chainBreaks,
    };
  }

  /** How many frames are waiting. Exposed for tests and diagnostics. */
  get depthNow(): number {
    return this.queue.length;
  }

  /**
   * Hand one encoded frame to the transport, eventually.
   *
   * Returns nothing on purpose: there is no promise here for a caller to forget
   * to await, which is the bug this class exists to make unrepresentable.
   */
  enqueue(frame: T, isKeyframe: boolean): void {
    if (this.stopped) return;

    if (!isKeyframe && this.awaitingKeyframe) {
      // The chain this delta belongs to is already broken.
      this.dropped += 1;
      return;
    }

    if (this.queue.length >= this.depth) {
      if (!isKeyframe) {
        this.dropped += 1;
        this.breakChain('tail');
        return;
      }
      // A keyframe supersedes everything waiting: the deltas behind it are
      // undecodable now, and an older keyframe is simply older.
      this.dropped += this.queue.length;
      this.queue.length = 0;
    }

    if (isKeyframe) this.awaitingKeyframe = false;
    this.queue.push({ frame, isKeyframe });
    if (!this.pump) this.pump = this.drain();
  }

  /** Resolve once everything queued has been sent (or dropped). */
  async idle(): Promise<void> {
    while (this.pump) await this.pump;
  }

  /**
   * Forget everything queued and refuse anything further — the session is over,
   * or the track was replaced and its frames belong to a transport that has
   * gone.
   */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const next = this.queue.shift();
        if (!next) break;
        try {
          await this.send(next.frame);
          this.consecutiveFailures = 0;
        } catch (error) {
          this.recordFailure(error);
        }
      }
    } finally {
      this.pump = null;
      // A frame enqueued while the last send was in flight starts the pump
      // again; without this it would wait for the next frame to arrive.
      if (this.queue.length > 0 && !this.stopped) this.pump = this.drain();
    }
  }

  /**
   * A frame of the chain is gone. `lostAt` says where: `'tail'` for a frame
   * that never joined the queue (everything queued came before it and is still
   * good), `'head'` for the frame just taken off the front (everything queued
   * came after it, so the deltas up to the next queued keyframe are not).
   * Deltas are then withheld until a keyframe starts a new chain.
   */
  private breakChain(lostAt: 'head' | 'tail'): void {
    if (lostAt === 'head') {
      const restart = this.queue.findIndex((queued) => queued.isKeyframe);
      const orphaned = restart === -1 ? this.queue.length : restart;
      this.dropped += orphaned;
      this.queue.splice(0, orphaned);
      // The keyframe that restarts the chain is already waiting.
      if (restart !== -1) return;
    }
    if (this.awaitingKeyframe) return;
    this.awaitingKeyframe = true;
    this.chainBreaks += 1;
    this.onChainBroken?.(this.stats);
  }

  private recordFailure(error: unknown): void {
    this.failed += 1;
    this.consecutiveFailures += 1;

    // The session ending is not a transport failure: every in-flight send
    // rejects with it, and there is nothing to report or retry.
    if (error instanceof DOMException && error.name === 'AbortError') {
      this.stop();
      return;
    }

    this.breakChain('head');

    if (
      this.consecutiveFailures === 1 ||
      this.consecutiveFailures % ERROR_REPORT_INTERVAL === 0
    ) {
      this.onError?.(error, this.stats);
    }
  }
}
