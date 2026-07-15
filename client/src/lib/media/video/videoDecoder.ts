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
    'avc1.64002a',
    'avc1.640034',
    'avc1.640033',
    'avc1.640032',
    'avc1.640028',
    'avc1.64001f',
    'avc1.4d401f',
    'avc1.42E01E',
  ],
} as const;

const decodeSupportCache = new Map<string, Promise<boolean>>();
/** The exact codec string the functional probe validated for a codec family,
 * cached so the runtime decoder configures with the same string the probe
 * proved decodable (W5). */
const validatedCodecStrings = new Map<string, string>();

/** The codec string {@link isWebCodecsDecodeSupported} validated for `codec`
 * (family key like 'vp9'), or null if none was validated yet. */
export function getValidatedDecoderCodecString(codec: string): string | null {
  return validatedCodecStrings.get(codec.trim().toLowerCase()) ?? null;
}

/** Fetch one real encoded keyframe from the native encoder for `codec`, or
 * null when unavailable (not running under Tauri, or no local encoder). */
async function fetchDecodeProbeFrame(key: string): Promise<Uint8Array | null> {
  try {
    const mod = await import('@tauri-apps/api/core');
    const raw = await mod.invoke('media_generate_decode_probe', { codec: key });
    if (raw instanceof ArrayBuffer && raw.byteLength > 0) {
      return new Uint8Array(raw);
    }
    if (raw instanceof Uint8Array && raw.byteLength > 0) {
      return raw;
    }
    // Tauri's postMessage IPC transport encodes binary responses as JSON
    // number arrays; the probe must still run there.
    if (Array.isArray(raw) && raw.length > 0) {
      return Uint8Array.from(raw as number[]);
    }
    return null;
  } catch {
    return null;
  }
}

/** Configure a decoder for `codecString` and require it to actually produce a
 * decoded frame from a real keyframe. Resolves false on error or timeout. */
function decodesProbeFrame(codecString: string, key: string, probe: Uint8Array): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let decoder: VideoDecoder | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        decoder?.close();
      } catch {
        // Already closed.
      }
      resolve(ok);
    };
    timer = setTimeout(() => settle(false), 3000);
    try {
      decoder = new VideoDecoder({
        output: (frame) => {
          frame.close();
          settle(true);
        },
        error: () => settle(false),
      });
      const decoderConfig = { codec: codecString } satisfies Record<string, unknown>;
      if (key === 'h264') {
        (decoderConfig as { avc?: { format: 'annexb' } }).avc = { format: 'annexb' };
      }
      decoder.configure(decoderConfig as Parameters<VideoDecoder['configure']>[0]);
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: probe }));
      decoder
        .flush()
        .then(() => settle(false)) // flushed without ever emitting a frame
        .catch(() => settle(false));
    } catch {
      settle(false);
    }
  });
}

/**
 * Whether this webview can decode the given codec family ('vp9' | 'h264' |
 * 'av1') with WebCodecs. Used both for advertised decode capabilities (which
 * drive codec negotiation) and to decide between encoded passthrough and
 * native in-process decoding. Result is cached per codec.
 *
 * This is a FUNCTIONAL check, not just `isConfigSupported`: when the native
 * side can produce a real keyframe for the codec, the decoder must actually
 * decode it. WebKitGTK has been observed to approve an H264 config and then
 * fail every real frame with "Decode error" — trusting the claim made the
 * host stream a picture it could not show itself.
 */
export function isWebCodecsDecodeSupported(codec: string): Promise<boolean> {
  const key = codec.trim().toLowerCase();
  let cached = decodeSupportCache.get(key);
  if (!cached) {
    cached = (async () => {
      if (
        typeof VideoDecoder === 'undefined' ||
        typeof VideoDecoder.isConfigSupported !== 'function'
      ) {
        return false;
      }
      // Probe WITHOUT a hardwareAcceleration constraint: some UAs report
      // `supported: false` for 'prefer-hardware' when only a software
      // decoder exists.
      let configurable: string | null = null;
      const candidates = CODEC_CANDIDATES[key] ?? [codec];
      for (const candidate of candidates) {
        try {
          const decoderConfig = { codec: candidate } satisfies Record<string, unknown>;
          if (key === 'h264') {
            (decoderConfig as { avc?: { format: 'annexb' } }).avc = { format: 'annexb' };
          }
          const result = await VideoDecoder.isConfigSupported(
            decoderConfig as Parameters<typeof VideoDecoder.isConfigSupported>[0],
          );
          if (result.supported) {
            configurable = candidate;
            break;
          }
        } catch {
          // Malformed/unknown codec string for this UA; try the next candidate.
        }
      }
      if (!configurable || typeof EncodedVideoChunk === 'undefined') {
        return false;
      }
      const probe = await fetchDecodeProbeFrame(key);
      if (!probe) {
        // No local encoder to generate a probe frame — the config-level claim
        // is the best available evidence.
        validatedCodecStrings.set(key, configurable);
        return true;
      }
      const verdict = await decodesProbeFrame(configurable, key, probe);
      if (verdict) {
        validatedCodecStrings.set(key, configurable);
      }
      if (!verdict) {
        console.error(
          `[media] webview claims WebCodecs ${key} support but failed to decode a real keyframe; ` +
            'excluding it from decode capabilities',
        );
      }
      return verdict;
    })();
    decodeSupportCache.set(key, cached);
  }
  return cached;
}

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
  private errorCallbacks: Array<(error: Error) => void> = [];
  private keyframeNeededCallbacks: Array<() => void> = [];
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
        this.notifyKeyframeNeeded();
        const error = err instanceof Error ? err : new Error(String(err));
        for (const cb of this.errorCallbacks) {
          cb(error);
        }
      },
    });
  }

  private configureDecoder(): void {
    if (this.decoder.state === 'closed') return;
    const normalizedCodec = this.codec.trim().toLowerCase();
    // Configure with the exact string the functional probe validated first, so
    // the runtime decoder uses a config already proven to decode a real
    // keyframe on this UA (W5), then fall back to the generic candidate list.
    const validated = getValidatedDecoderCodecString(this.codec);
    const candidates = [
      ...(validated ? [validated] : []),
      ...(CODEC_CANDIDATES[normalizedCodec] ??
        CODEC_CANDIDATES[normalizedCodec.replace(/[^a-z0-9]/g, '')] ??
        [this.codec]),
    ];
    let lastError: unknown = null;

    for (const codec of candidates) {
      try {
        const decoderConfig = {
          codec,
          // Match the probe, which validates WITHOUT a hardwareAcceleration
          // constraint: forcing 'prefer-hardware' here can reject a config the
          // probe proved decodable when only a software decoder exists (W5).
          hardwareAcceleration: 'no-preference',
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

    // If we need a keyframe and this is not one, discard until we get one and
    // ask upstream to send one (W3b): without a keyframe request the stream can
    // stay stuck dropping deltas forever.
    if (this.needsKeyframe && !isKey) {
      this.notifyKeyframeNeeded();
      return;
    }

    if (isKey) {
      this.needsKeyframe = false;
    }

    // Avoid overwhelming the decoder. Dropping a DELTA breaks the prediction
    // chain, so mark the stream desynchronized and request a fresh keyframe
    // (W4) rather than silently corrupting subsequent frames. Keyframes are
    // never dropped for queue depth — they are the resync point.
    if (!isKey && this.decoder.decodeQueueSize > 10) {
      this.needsKeyframe = true;
      this.notifyKeyframeNeeded();
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

  /** Register a callback for decoder runtime failures. */
  onError(cb: (error: Error) => void): void {
    this.errorCallbacks.push(cb);
  }

  /** Register a callback fired whenever the decoder needs a fresh keyframe to
   * (re)synchronize: on a runtime error, when a delta is discarded while
   * awaiting a keyframe, or when a delta is dropped for a deep queue (W3/W4).
   * Consumers debounce and forward this to the upstream keyframe request. */
  onKeyframeNeeded(cb: () => void): void {
    this.keyframeNeededCallbacks.push(cb);
  }

  private notifyKeyframeNeeded(): void {
    for (const cb of this.keyframeNeededCallbacks) {
      cb();
    }
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
    this.errorCallbacks = [];
    this.keyframeNeededCallbacks = [];
  }
}
