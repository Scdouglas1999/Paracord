// WebCodecs VP9 simulcast encoder.
// Encodes VideoFrame inputs into VP9 at multiple simulcast layers.

/** Configuration for a single simulcast layer. */
export interface SimulcastLayerConfig {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

/** Top-level encoder configuration. */
export interface VideoEncoderConfig {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  codec?: 'vp9' | 'av1' | 'h264' | string;
}

/** Predefined simulcast layer definitions (low, medium, high). */
export const SIMULCAST_LAYERS: readonly SimulcastLayerConfig[] = [
  { width: 320, height: 180, frameRate: 15, bitrate: 150_000 },   // Layer 0: Low
  { width: 640, height: 360, frameRate: 30, bitrate: 500_000 },   // Layer 1: Medium
  { width: 1280, height: 720, frameRate: 30, bitrate: 1_500_000 }, // Layer 2: High
] as const;

/** VP9 codec string: Profile 0, Level 1.0, 8-bit. */
const VP9_CODEC = 'vp09.00.10.08';
const H264_CODEC = 'avc1.640028';
const AV1_CODEC = 'av01.0.10M.08';

/** Interval between forced keyframes, in seconds. */
const KEYFRAME_INTERVAL_S = 5;

/** Metadata attached to each encoded chunk for downstream consumers. */
export interface EncodedVideoChunkWithMeta {
  chunk: EncodedVideoChunk;
  layerIndex: number;
  isKeyframe: boolean;
  codec: 'vp9' | 'av1' | 'h264' | string;
}

/**
 * State for a single simulcast layer encoder.
 * Each layer maintains its own WebCodecs VideoEncoder and downscale canvas.
 */
interface LayerState {
  encoder: VideoEncoder;
  config: SimulcastLayerConfig;
  layerIndex: number;
  codec: 'vp9' | 'av1' | 'h264' | string;
  frameCount: number;
  frameDivisor: number;
  lastKeyframeTime: number;
  /** OffscreenCanvas used to downscale frames for this layer. */
  scaleCanvas: OffscreenCanvas;
  scaleCtx: OffscreenCanvasRenderingContext2D;
}

/**
 * VP9 simulcast video encoder using the WebCodecs API.
 *
 * Accepts raw VideoFrame objects (from camera or screen capture) and
 * encodes them into VP9 at up to three simulcast layers. Encoded chunks
 * are emitted via registered callbacks with layer metadata attached.
 */
export class MediaVideoEncoder {
  private layers: LayerState[] = [];
  private encodedCallbacks: Array<(data: EncodedVideoChunkWithMeta) => void> = [];
  private closed = false;
  private activeLayerCount: number;
  private keyframeRequested: Set<number> = new Set();
  private activeCodec: 'vp9' | 'av1' | 'h264' | string;

  constructor(_config: VideoEncoderConfig) {
    this.activeCodec = this.normalizeCodec(_config.codec);
    // Determine how many simulcast layers to use based on input resolution.
    // Only enable layers whose resolution is <= the source resolution.
    this.activeLayerCount = SIMULCAST_LAYERS.filter(
      (l) => l.width <= _config.width && l.height <= _config.height,
    ).length;

    // Always have at least one layer.
    if (this.activeLayerCount === 0) {
      this.activeLayerCount = 1;
    }

    for (let i = 0; i < this.activeLayerCount; i++) {
      const layerConfig = SIMULCAST_LAYERS[i];
      this.initLayer(layerConfig, i, _config.frameRate);
    }
  }

  private initLayer(
    config: SimulcastLayerConfig,
    layerIndex: number,
    sourceFrameRate: number,
  ): void {
    const codec = this.resolveLayerCodec(config);
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (this.closed) return;
        const isKeyframe =
          chunk.type === 'key' ||
          (metadata?.decoderConfig !== undefined);

        const wrapped: EncodedVideoChunkWithMeta = {
          chunk,
          layerIndex,
          isKeyframe,
          codec,
        };

        for (const cb of this.encodedCallbacks) {
          cb(wrapped);
        }
      },
      error: (err) => {
        console.error(`[MediaVideoEncoder] Layer ${layerIndex} error:`, err);
      },
    });

    this.configureEncoder(encoder, config, codec);

    // Create an OffscreenCanvas for downscaling source frames to this layer's resolution.
    const scaleCanvas = new OffscreenCanvas(config.width, config.height);
    const scaleCtx = scaleCanvas.getContext('2d');
    if (!scaleCtx) {
      throw new Error(`Failed to get 2d context for layer ${layerIndex} scale canvas`);
    }

    // Calculate frame divisor: if source is 30fps but layer is 15fps, only encode every 2nd frame.
    const frameDivisor = Math.max(1, Math.round(sourceFrameRate / config.frameRate));

    const state: LayerState = {
      encoder,
      config,
      layerIndex,
      codec,
      frameCount: 0,
      frameDivisor,
      lastKeyframeTime: 0,
      scaleCanvas,
      scaleCtx,
    };

    this.layers.push(state);
  }

  /**
   * Encode a VideoFrame across all active simulcast layers.
   * The caller retains ownership of the frame and must close it when done.
   * This method creates scaled copies internally.
   */
  encode(frame: VideoFrame): void {
    if (this.closed) return;

    for (const layer of this.layers) {
      layer.frameCount++;

      // Skip frames to match the layer's target frame rate.
      if (layer.frameCount % layer.frameDivisor !== 0) {
        continue;
      }

      if (layer.encoder.state === 'closed') continue;

      // Check encoder queue depth to avoid overwhelming it.
      if (layer.encoder.encodeQueueSize > 5) {
        continue;
      }

      // Determine if this frame should be a keyframe.
      const now = frame.timestamp / 1_000_000; // timestamp is in microseconds
      const forceKeyframe =
        this.keyframeRequested.has(layer.layerIndex) ||
        now - layer.lastKeyframeTime >= KEYFRAME_INTERVAL_S ||
        layer.lastKeyframeTime === 0;

      if (forceKeyframe) {
        layer.lastKeyframeTime = now;
        this.keyframeRequested.delete(layer.layerIndex);
      }

      // Downscale the source frame to the layer resolution via OffscreenCanvas.
      let layerFrame: VideoFrame;

      if (
        frame.displayWidth === layer.config.width &&
        frame.displayHeight === layer.config.height
      ) {
        // No scaling needed -- clone the frame so we have an independent copy.
        layerFrame = new VideoFrame(frame, { timestamp: frame.timestamp });
      } else {
        layer.scaleCtx.drawImage(
          frame,
          0,
          0,
          layer.config.width,
          layer.config.height,
        );
        layerFrame = new VideoFrame(layer.scaleCanvas, {
          timestamp: frame.timestamp,
        });
      }

      try {
        layer.encoder.encode(layerFrame, { keyFrame: forceKeyframe });
      } finally {
        layerFrame.close();
      }
    }
  }

  /** Register a callback for encoded video chunks with layer metadata. */
  onEncoded(cb: (data: EncodedVideoChunkWithMeta) => void): void {
    this.encodedCallbacks.push(cb);
  }

  get codec(): 'vp9' | 'av1' | 'h264' | string {
    return this.activeCodec;
  }

  /** Request a keyframe on a specific simulcast layer (or all layers if index is omitted). */
  requestKeyframe(layerIndex?: number): void {
    if (layerIndex !== undefined) {
      this.keyframeRequested.add(layerIndex);
    } else {
      for (const layer of this.layers) {
        this.keyframeRequested.add(layer.layerIndex);
      }
    }
  }

  /** Get the number of active simulcast layers. */
  get layerCount(): number {
    return this.activeLayerCount;
  }

  /** Close all encoders and release resources. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const layer of this.layers) {
      if (layer.encoder.state !== 'closed') {
        layer.encoder.close();
      }
    }
    this.layers = [];
    this.encodedCallbacks = [];
    this.keyframeRequested.clear();
  }

  private normalizeCodec(codec?: string): 'vp9' | 'av1' | 'h264' | string {
    switch ((codec ?? 'vp9').trim().toLowerCase()) {
      case 'av1':
        return 'av1';
      case 'h264':
        return 'h264';
      case 'vp9':
      default:
        return 'vp9';
    }
  }

  private resolveLayerCodec(config: SimulcastLayerConfig): 'vp9' | 'av1' | 'h264' | string {
    const requested = this.activeCodec;
    if (requested === 'vp9') {
      return requested;
    }

    const probe = new VideoEncoder({
      output: () => {},
      error: () => {},
    });
    try {
      this.configureEncoder(probe, config, requested);
      return requested;
    } catch {
      this.activeCodec = 'vp9';
      return 'vp9';
    } finally {
      try {
        probe.close();
      } catch {
        // ignore
      }
    }
  }

  private configureEncoder(
    encoder: VideoEncoder,
    config: SimulcastLayerConfig,
    codec: 'vp9' | 'av1' | 'h264' | string,
  ): void {
    const baseConfig = {
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,
      framerate: config.frameRate,
      latencyMode: 'realtime' as const,
      scalabilityMode: 'L1T1',
    };
    switch (codec) {
      case 'h264':
        encoder.configure({
          ...baseConfig,
          codec: H264_CODEC,
          avc: { format: 'annexb' },
        });
        break;
      case 'av1':
        encoder.configure({
          ...baseConfig,
          codec: AV1_CODEC,
        });
        break;
      case 'vp9':
      default:
        encoder.configure({
          ...baseConfig,
          codec: VP9_CODEC,
        });
        break;
    }
  }
}
