// WebCodecs video decoder.
// One instance per remote video stream. Accepts encoded chunks
// and outputs VideoFrame objects for rendering.

import { logVoiceDiagnostic } from '../../desktopDiagnostics';

/** Configuration for the video decoder. */
export interface VideoDecoderConfig {
  codec: string;
}

const CODEC_CANDIDATES: Record<string, readonly string[]> = {
  vp9: [
    'vp09.00.10.08',
    'vp09.00.41.08',
    'vp09.00.51.08',
  ],
  av1: [
    'av01.0.08M.08',
    'av01.0.10M.08',
    'av01.0.12M.08',
  ],
  h264: [
    'avc1.640028',
    'avc1.64001f',
    'avc1.4d401f',
    'avc1.42E01E',
  ],
} as const;

/**
 * WebCodecs video decoder.
 *
 * Manages a single WebCodecs VideoDecoder instance for one remote
 * participant's video stream. Handles keyframe requirements, stream
 * resets, and proper frame lifecycle.
 */
export class MediaVideoDecoder {
  private decoder: VideoDecoder;
  private decodedCallbacks: Array<(frame: VideoFrame) => void> = [];
  private codec: string;
  private closed = false;
  private needsKeyframe = true;
  private configuredCodec: string | null = null;

  constructor(config: VideoDecoderConfig) {
    this.codec = config.codec || 'vp9';

    this.decoder = this.createDecoder();
    this.configureDecoder();
  }

  private createDecoder(): VideoDecoder {
    return new VideoDecoder({
      output: (frame) => {
        if (this.closed) {
          frame.close();
          return;
        }

        for (const cb of this.decodedCallbacks) {
          cb(frame);
        }
        // Note: The last consumer callback is responsible for closing the frame,
        // or the CanvasRenderer will close it after drawing. If no callbacks are
        // registered, we close the frame here to prevent leaks.
        if (this.decodedCallbacks.length === 0) {
          frame.close();
        }
      },
      error: (err) => {
        console.error('[MediaVideoDecoder] Decoder error:', err);
        logVoiceDiagnostic('[media] video decoder runtime error', {
          codec: this.configuredCodec ?? this.codec,
          error: err instanceof Error ? err.message : String(err),
        });
        // On error, require a new keyframe to resynchronize.
        this.needsKeyframe = true;
      },
    });
  }

  private configureDecoder(): void {
    if (this.decoder.state === 'closed') return;
    const normalizedCodec = this.codec.trim().toLowerCase();
    const candidates =
      CODEC_CANDIDATES[normalizedCodec] ??
      CODEC_CANDIDATES[normalizedCodec.replace(/[^a-z0-9]/g, '')] ??
      [this.codec];
    let lastError: unknown = null;

    for (const codec of candidates) {
      try {
        const decoderConfig = {
          codec,
          hardwareAcceleration: 'prefer-hardware',
          optimizeForLatency: true,
          // Let the decoder infer resolution from the bitstream.
          // VP9 carries resolution in each keyframe.
        } satisfies Record<string, unknown>;
        if (this.codec.trim().toLowerCase() === 'h264') {
          (decoderConfig as { avc?: { format: 'annexb' } }).avc = { format: 'annexb' };
        }
        this.decoder.configure(decoderConfig as Parameters<VideoDecoder['configure']>[0]);
        this.configuredCodec = codec;
        if (codec !== this.codec) {
          logVoiceDiagnostic('[media] video decoder configured with fallback codec', {
            requested: this.codec,
            configured: codec,
          });
        }
        return;
      } catch (err) {
        lastError = err;
      }
    }

    logVoiceDiagnostic('[media] video decoder configure failed', {
      requested: this.codec,
      candidates,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError instanceof Error
      ? lastError
      : new Error(`No supported decoder codec string found for ${this.codec}`);
  }

  /**
   * Decode an encoded video frame.
   *
   * @param data - The encoded bitstream data.
   * @param timestamp - Presentation timestamp in microseconds.
   * @param isKey - Whether this chunk is a keyframe.
   */
  decode(data: Uint8Array, timestamp: number, isKey: boolean): void {
    if (this.closed) return;
    if (this.decoder.state === 'closed') return;

    // If we need a keyframe and this is not one, discard until we get one.
    if (this.needsKeyframe && !isKey) {
      return;
    }

    if (isKey) {
      this.needsKeyframe = false;
    }

    // Avoid overwhelming the decoder.
    if (this.decoder.decodeQueueSize > 10) {
      return;
    }

    const chunk = new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp,
      data,
    });

    try {
      this.decoder.decode(chunk);
    } catch (err) {
      console.error('[MediaVideoDecoder] Failed to submit chunk:', err);
      logVoiceDiagnostic('[media] video decoder submit failed', {
        codec: this.configuredCodec ?? this.codec,
        timestamp,
        isKey,
        byteLength: data.byteLength,
        error: err instanceof Error ? err.message : String(err),
      });
      // If decoding fails, we need a fresh keyframe.
      this.needsKeyframe = true;
    }
  }

  /** Register a callback for decoded VideoFrame objects. */
  onDecoded(cb: (frame: VideoFrame) => void): void {
    this.decodedCallbacks.push(cb);
  }

  /** Whether the decoder is waiting for a keyframe to start/resume decoding. */
  get awaitingKeyframe(): boolean {
    return this.needsKeyframe;
  }

  /**
   * Reset the decoder state. Call this when the remote stream
   * switches simulcast layers or recovers from an error.
   * After reset, the decoder waits for a new keyframe.
   */
  reset(): void {
    if (this.closed) return;

    this.needsKeyframe = true;

    if (this.decoder.state !== 'closed') {
      try {
        this.decoder.reset();
        this.configureDecoder();
      } catch {
        // If reset fails, recreate the decoder entirely.
        try {
          this.decoder.close();
        } catch {
          // Already closed.
        }
        this.decoder = this.createDecoder();
        this.configureDecoder();
      }
    }
  }

  /**
   * Flush the decoder, processing all queued frames.
   * Returns a promise that resolves when the flush completes.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.decoder.state === 'closed') return;

    try {
      await this.decoder.flush();
    } catch {
      // Flush can fail if the decoder was reset concurrently.
    }
  }

  /** Close the decoder and release all resources. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        // Already closed.
      }
    }
    this.decodedCallbacks = [];
  }
}
