import type {
  MediaEngine,
  MediaStreamCapabilities,
  MediaStreamDiagnostics,
  PublishedTrackDescriptor,
  ScreenShareConfig,
  ScreenShareSource,
  ScreenShareThumbnail,
  TrackSubscriptionRequest,
} from './mediaEngine';
import { MediaVideoDecoder, isWebCodecsDecodeSupported } from './video/videoDecoder';
import { CanvasRenderer } from './video/canvasRenderer';
import { NativeVideoTile } from './video/nativeVideoTile';
import { logVoiceDiagnostic } from '../desktopDiagnostics';
import { unwrapDeliveredMediaSenderKey } from './mediaSenderKeyEnvelope';
import {
  parsePulledVideoFrameBinary,
  type ParsedPulledVideoFrame,
  type PulledVideoFrameFormat,
} from './video/pulledVideoFrame';
import {
  parseRoomIdFromToken,
  parseUserIdFromToken,
  selectPublishedLayer,
  wrapSenderKeyForRecipients,
} from './engineShared';

import type { Channel as TauriChannel } from '@tauri-apps/api/core';

// Tauri API imports - these resolve at runtime in the Tauri environment
let invoke: (cmd: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array) => Promise<unknown>;
let listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
let ChannelCtor: typeof TauriChannel | undefined;

// Dynamic import to avoid bundling issues in browser builds
const tauriReady = (async () => {
  try {
    const core = await import('@tauri-apps/api/core');
    const event = await import('@tauri-apps/api/event');
    invoke = core.invoke;
    listen = event.listen;
    ChannelCtor = core.Channel;
  } catch {
    // Not in Tauri environment
  }
})();

type UnlistenFn = () => void;

type PulledEncodedFrameResponse = ParsedPulledVideoFrame;

/**
 * Payload delivered to a video subscription channel's `onmessage`. Tauri ships
 * `InvokeResponseBody::Raw` bodies as real ArrayBuffers over the custom-protocol
 * fetch path (even when normal IPC runs on postMessage); a JSON number array
 * only appears if the transport regresses.
 */
type VideoFrameChannelMessage = ArrayBuffer | Uint8Array | number[];
/** The concrete Tauri channel handed to `media_register_stream_video_subscription`. */
type VideoFrameChannel = TauriChannel<VideoFrameChannelMessage>;
/**
 * Minimal structural view of a frame channel so the subscription driver can be
 * unit-tested with a plain object (and so it never has to know the concrete
 * Tauri `Channel` type).
 */
interface VideoFrameSink {
  onmessage: (message: VideoFrameChannelMessage) => void;
}

type ExportedSenderKey = {
  epoch: number;
  rawKey: number[];
};

type SessionParticipantCapabilities = {
  userId: string;
  sessionId: string;
  videoCapabilities: Array<{
    codec: 'vp9' | 'av1' | 'h264' | string;
    encode: boolean;
    decode: boolean;
    // Split per contract C3 (was a single hardwareAccelerated flag). Only the
    // decode sets of these are consumed by codec negotiation here.
    encodeHardware: boolean;
    decodeHardware: boolean;
  }>;
};

interface NativeVideoSubscription {
  decoder?: MediaVideoDecoder;
  renderer: CanvasRenderer;
  /** Push channel the native side sends this track's frames over. Reused across
   * re-registrations (layer/viewport/bandwidth changes) so there is exactly one
   * channel per subscription; dropped on unregister. Present ONLY on the
   * `webcodecs-passthrough` route — the `native-surface` route carries no frame
   * channel (spec §2), which is what the channel-guarded re-register paths key
   * off to skip a native subscription. */
  channel?: VideoFrameChannel;
  /** Native platform surface for the `native-surface` route (spec §3.6). Owns
   * geometry/visibility reporting; frames never cross IPC. Mutually exclusive
   * with {@link channel}. */
  nativeTile?: NativeVideoTile;
  streamId?: string;
  trackId?: string;
  activeLayer?: number;
  stop: () => void;
}

let nativeStreamCapabilitiesPromise: Promise<MediaStreamCapabilities> | null = null;

type ViewerDecodeSupport = {
  vp9: boolean;
  h264: boolean;
  av1: boolean;
};

let viewerDecodeSupportPromise: Promise<ViewerDecodeSupport> | null = null;

function getViewerDecodeSupport(): Promise<ViewerDecodeSupport> {
  if (!viewerDecodeSupportPromise) {
    // Functional probes (real keyframe must actually decode), not just
    // isConfigSupported claims — these capabilities drive codec negotiation,
    // and WebKitGTK has approved H264 configs it then failed to decode.
    viewerDecodeSupportPromise = Promise.all([
      isWebCodecsDecodeSupported('vp9'),
      isWebCodecsDecodeSupported('h264'),
      isWebCodecsDecodeSupported('av1'),
    ]).then(([vp9, h264, av1]) => ({ vp9, h264, av1 }));
  }
  return viewerDecodeSupportPromise;
}

async function mergeNativeAndViewerCapabilities(
  nativeCapabilities: MediaStreamCapabilities,
): Promise<MediaStreamCapabilities> {
  const { vp9: vp9Decode, h264: h264Decode, av1: av1Decode } =
    await getViewerDecodeSupport();
  const webviewDecode = new Map<string, boolean>([
    ['vp9', vp9Decode],
    ['h264', h264Decode],
    ['av1', av1Decode],
  ]);
  const nativeSurfaceAvailable = Boolean(nativeCapabilities.nativeDesktopRenderer);

  return {
    ...nativeCapabilities,
    video: nativeCapabilities.video.map((capability) => {
      const codec = String(capability.codec).toLowerCase();
      const webview = webviewDecode.get(codec);
      if (webview == null) {
        return capability;
      }
      return {
        ...capability,
        // `decode` is advertised to the relay and used by local codec
        // negotiation, so it must mean "this client can display this codec",
        // not merely "Rust can decode it". A native decoder is displayable only
        // when the native desktop renderer is available; otherwise the encoded
        // WebCodecs/canvas path is the only visible route. This is what keeps a
        // Linux host from choosing AV1 NVENC when its own webview cannot decode
        // AV1 and the native GTK surface host is unavailable.
        //
        // Webview-contributed decode is decode-only and NOT hardware (contract
        // C3): "unknown is not hardware". The native side's own hardware flags
        // pass through the spread unchanged; we never fabricate acceleration
        // from a WebCodecs decode claim.
        decode: webview || (nativeSurfaceAvailable && capability.decode),
      };
    }),
  };
}

let warnedPostMessageTransport = false;

/** Raw (unencoded / natively-decoded) frame formats. These no longer cross the
 * subscription channel at all — the native-surface route owns them (spec §2). A
 * raw frame seen here is a native-route regression: hard-fail, never paint. */
const RAW_FRAME_FORMATS = new Set<PulledVideoFrameFormat>(['i420', 'raw', 'bgra', 'rgba']);

function normalizeChannelFrame(
  message: unknown,
  onRawFrameRegression?: (frame: PulledEncodedFrameResponse) => void,
): PulledEncodedFrameResponse | null {
  if (!message) {
    return null;
  }
  let frame: PulledEncodedFrameResponse | null;
  let overJsonTransport = false;
  if (message instanceof Uint8Array) {
    frame = parsePulledVideoFrameBinary(message);
  } else if (message instanceof ArrayBuffer) {
    frame = parsePulledVideoFrameBinary(message);
  } else if (Array.isArray(message)) {
    // Tauri channels deliver `InvokeResponseBody::Raw` bodies as real
    // ArrayBuffers over the custom-protocol fetch path. A JSON number array only
    // appears if that path regressed to serializing every frame through JSON;
    // encoded frames survive the tax (a few KB), so keep decoding them with a
    // one-time warning below.
    frame = parsePulledVideoFrameBinary(Uint8Array.from(message as number[]));
    overJsonTransport = true;
  } else {
    console.error(
      '[media] video frame channel delivered an unrecognized payload; frame dropped',
      typeof message,
    );
    return null;
  }
  if (!frame) {
    return null;
  }
  // This channel is encoded-passthrough ONLY. Native decode and every raw pixel
  // format now belong to the native-surface route, which owns delivery entirely
  // on the native side — nothing but geometry/stats crosses IPC there (spec §2).
  // A raw-format frame arriving here therefore means the native route regressed
  // into pushing decoded frames over the channel again: fail loudly and drop,
  // never paint a multi-MB frame (no silent fallback).
  if (RAW_FRAME_FORMATS.has(frame.format)) {
    onRawFrameRegression?.(frame);
    return null;
  }
  if (overJsonTransport && !warnedPostMessageTransport) {
    warnedPostMessageTransport = true;
    console.warn(
      '[media] video frame channel delivered a JSON number array instead of an ArrayBuffer. ' +
        'The ipc custom-protocol fetch path is unavailable in this webview session — encoded ' +
        'frame delivery works but pays a JSON serialization tax.',
    );
    logVoiceDiagnostic('[media] video frame channel on JSON-array transport (fetch path unavailable)');
  }
  return frame;
}

function rendererCanvasSize(renderer: CanvasRenderer): { width: number; height: number } {
  const canvas = renderer.canvasElement;
  const clientWidth = canvas?.clientWidth ?? canvas?.width ?? 0;
  const clientHeight = canvas?.clientHeight ?? canvas?.height ?? 0;
  const ratio = typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;
  return {
    width: Math.max(1, Math.round(clientWidth * ratio)),
    height: Math.max(1, Math.round(clientHeight * ratio)),
  };
}

function normalizeNativeRelayEndpoint(endpoint: string): string {
  if (!endpoint) return '';
  const trimmed = endpoint.trim();
  if (!trimmed) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname;
    const port =
      parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    if (!host || !port) return trimmed;
    if (host.includes(':') && !host.startsWith('[')) {
      return `[${host}]:${port}`;
    }
    return `${host}:${port}`;
  } catch {
    return trimmed;
  }
}

/**
 * Render frames pushed by the native side over a Tauri {@link VideoFrameSink}.
 *
 * The native encoder/decoder pushes each packed binary frame the moment it is
 * stored (no polling); the channel's `onmessage` is this subscription's single
 * ingress. Natively-decoded frames (`format === 'i420'`) and local raw preview
 * frames (`format === 'bgra' | 'rgba'`) are drawn straight to the canvas,
 * bypassing WebCodecs entirely. Encoded frames are fed to a
 * {@link MediaVideoDecoder}.
 *
 * Backpressure/stale handling: channel messages arrive in order, but a
 * (re)subscribe replays the latest stored frame, so an already-rendered
 * sequence can arrive again — anything not strictly newer than the last
 * rendered sequence is dropped. Coalescing of a burst is handled downstream:
 * the renderer keeps only the latest pending frame and the WebCodecs decoder
 * drops frames once its queue is deep.
 */
export function startPulledEncodedVideoSubscription(
  label: string,
  channel: VideoFrameSink,
  decoderRef: { current: MediaVideoDecoder | null; codec: string | null },
  renderer: CanvasRenderer,
  onFrame?: () => void,
  onDecodedFrame?: () => void,
  getRenderingEnabled?: () => boolean,
  requestKeyframe?: () => void,
): () => void {
  let stopped = false;
  let lastSequence: number | null = null;
  let sawDecodedFrame = false;
  let reportedDecoderUnavailable = false;
  let reportedRawFrameRegression = false;
  const shouldRender = () => !stopped && (getRenderingEnabled?.() ?? true);

  const onRawFrameRegression = (frame: PulledEncodedFrameResponse) => {
    // Raw pixels no longer cross this channel — the native-surface route decodes
    // and presents them natively (spec §2). A raw frame here is a native-route
    // regression; fail loudly and drop rather than paint it (no silent fallback).
    if (!reportedRawFrameRegression) {
      reportedRawFrameRegression = true;
      console.error(
        '[media] raw frame on encoded-passthrough channel: native route regression — dropping frames',
        { label, format: frame.format, width: frame.width, height: frame.height },
      );
      logVoiceDiagnostic('[media] raw frame on encoded-passthrough channel: native route regression', {
        label,
        codec: decoderRef.codec,
        format: frame.format,
        width: frame.width,
        height: frame.height,
      });
    }
  };

  const attachDecoder = (decoder: MediaVideoDecoder) => {
    decoder.onError((error) => {
      logVoiceDiagnostic('[media] webview video decoder failed at runtime', {
        label,
        codec: decoderRef.codec,
        error: error.message,
      });
    });
    decoder.onKeyframeNeeded(() => {
      requestKeyframe?.();
    });
    decoder.onDecoded((frame) => {
      if (!shouldRender()) {
        frame.close();
        return;
      }
      if (!sawDecodedFrame) {
        sawDecodedFrame = true;
        logVoiceDiagnostic('[media] native video subscription received first decoded frame', {
          label,
          width: frame.displayWidth,
          height: frame.displayHeight,
          timestamp: frame.timestamp,
        });
        onDecodedFrame?.();
      }
      renderer.renderFrame(frame);
      onFrame?.();
    });
  };

  if (decoderRef.current) {
    attachDecoder(decoderRef.current);
  }

  const processFrame = (frame: PulledEncodedFrameResponse) => {
    lastSequence = frame.sequence;
    // Encoded-passthrough only: raw/natively-decoded frames were filtered out in
    // normalizeChannelFrame (spec §2), so every frame reaching here is an encoded
    // bitstream headed for the WebCodecs decoder.
    if (!decoderRef.current || frame.codec !== decoderRef.codec) {
      decoderRef.current?.close();
      try {
        decoderRef.current = new MediaVideoDecoder({ codec: String(frame.codec) });
      } catch (err) {
        decoderRef.current = null;
        decoderRef.codec = null;
        // No silent route change: this codec was negotiated from advertised
        // capabilities, so failing to configure a decoder for it is a real
        // defect that must stay visible, not be papered over with a
        // different decode path.
        if (!reportedDecoderUnavailable) {
          reportedDecoderUnavailable = true;
          console.error(
            `[media] webview video decoder failed to configure for negotiated codec "${frame.codec}"`,
            err,
          );
          logVoiceDiagnostic('[media] webview video decoder unavailable for negotiated codec', {
            label,
            codec: frame.codec,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      decoderRef.codec = String(frame.codec);
      sawDecodedFrame = false;
      attachDecoder(decoderRef.current);
      logVoiceDiagnostic('[media] native video decoder prepared codec', {
        label,
        codec: frame.codec,
      });
    }
    decoderRef.current.decode(frame.data, frame.timestampUs, frame.isKeyframe);
  };

  channel.onmessage = (message) => {
    if (stopped || !shouldRender()) {
      return;
    }
    const frame = normalizeChannelFrame(message, onRawFrameRegression);
    if (!frame) {
      return;
    }
    // Drop a replayed/duplicate frame: a (re)subscribe re-pushes the latest
    // stored frame, so ignore anything not strictly newer than what we drew.
    if (lastSequence != null && frame.sequence <= lastSequence) {
      return;
    }
    processFrame(frame);
  };

  return () => {
    stopped = true;
    // Detach so a replay or late push after teardown is ignored.
    channel.onmessage = () => {};
  };
}

function attachStreamVisibilityControls(
  canvas: HTMLCanvasElement,
  renderer: CanvasRenderer,
  reportVisibility: (visible: boolean) => void,
): { cleanup: () => void; isRenderingEnabled: () => boolean } {
  let intersectionVisible = true;
  let renderingEnabled = true;

  const isRenderingEnabled = () => renderingEnabled;

  const applyVisibility = () => {
    const docVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const nextEnabled = docVisible && intersectionVisible;
    if (nextEnabled === renderingEnabled) {
      return;
    }
    renderingEnabled = nextEnabled;
    renderer.setRenderingEnabled(nextEnabled);
    // Report both directions so the native side can stop decoding/pushing frames
    // for a hidden track and resume (re-pushing the stored frame) when shown
    // again (contract C2).
    reportVisibility(nextEnabled);
  };

  const onVisibilityChange = () => {
    applyVisibility();
  };

  let intersectionObserver: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        intersectionVisible = entries.some(
          (entry) => entry.isIntersecting && entry.intersectionRatio > 0,
        );
        applyVisibility();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    cleanup: () => {
      intersectionObserver?.disconnect();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      renderer.setRenderingEnabled(true);
    },
    isRenderingEnabled,
  };
}

/**
 * Tauri desktop media engine.
 * Communicates with the Rust native media engine via Tauri IPC commands.
 * The native side handles QUIC transport, Opus encoding, and P2P connections.
 */
export class TauriMediaEngine implements MediaEngine {
  private unlisteners: UnlistenFn[] = [];
  private listenerPromises: Promise<void>[] = [];
  private videoSubscriptions = new Map<string, NativeVideoSubscription>();
  private publishedTracks = new Map<string, PublishedTrackDescriptor>();
  private publishedTrackListenersReady = false;
  private pendingPublishedVideoTrackWaits = new Map<
    string,
    Set<(track: PublishedTrackDescriptor) => void>
  >();

  private publishedVideoWaitKey(
    publisherUserId: string,
    preferredTrackId?: 'camera' | 'screen',
  ): string {
    return `${publisherUserId}:${preferredTrackId ?? 'any'}`;
  }
  private localUserId: string | null = null;
  private localRoomId: string | null = null;
  private sessionParticipantCapabilities = new Map<string, SessionParticipantCapabilities>();

  // Screen share state for the native desktop capture path
  private screenShareEndedCb: (() => void) | null = null;
  private screenAudioActive = false;
  private screenEventUnlisten: UnlistenFn | null = null;
  private transportLostUnlisten: UnlistenFn | null = null;
  private transportLostCb: ((reason: string) => void) | null = null;
  private disconnecting = false;
  // Remote screen-share audio tracks we've registered for. Playback happens in
  // the native cpal mixer (contract C4); the webview only drives the relay
  // track subscription, so we track subscribers to unregister on teardown.
  private screenShareAudioSubscribers = new Set<string>();

  // Native camera capture state. There is no JS getUserMedia / frame-extraction
  // path anymore (contract CAM4): capture, encode, and the self-view all live in
  // Rust. The webview only toggles capture and listens for hard errors.
  private cameraEventUnlisten: (() => void) | null = null;
  private cameraFailureCb: ((error: Error) => void) | null = null;

  async connect(endpoint: string, token: string, certHash?: string): Promise<void> {
    await tauriReady;
    if (!certHash) {
      throw new Error('native media server did not provide a TLS certificate pin');
    }
    this.localUserId = parseUserIdFromToken(token);
    this.localRoomId = parseRoomIdFromToken(token);
    // Wait for all pending listener registrations to complete before
    // starting the session so we don't miss early events on cold boot.
    if (this.listenerPromises.length > 0) {
      await Promise.all(this.listenerPromises);
      this.listenerPromises = [];
    }
    const relayEndpoint = normalizeNativeRelayEndpoint(endpoint);
    try {
      const advertisedCapabilities = await this.getStreamCapabilities().catch(() => null);
      await invoke('start_voice_session', {
        endpoint: relayEndpoint,
        token,
        certHash,
        roomId: '',
        advertisedCapabilities,
      });
      await this.initializePublishedTrackListeners();
      await this.initializeMediaKeyListeners();
      await this.initializeTransportListeners();
      const tracks = await this.listPublishedTracks().catch(() => []);
      for (const track of tracks) {
        this.publishedTracks.set(`${track.streamId}:${track.trackId}`, track);
      }
      const participants = await this.listSessionParticipantCapabilities().catch(() => []);
      this.sessionParticipantCapabilities.clear();
      for (const participant of participants) {
        this.sessionParticipantCapabilities.set(participant.userId, participant);
      }
      await this.announceWrappedLocalSenderKeys().catch(() => {});
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `native session start failed (relay=${relayEndpoint}, source=${endpoint}): ${reason}`
      );
    }
  }

  async disconnect(): Promise<void> {
    await tauriReady;
    this.disconnecting = true;
    this.transportLostCb = null;
    this.clearVideoSubscriptions();
    this.clearScreenShareAudioSubscriptions();
    this.cleanupScreenShare();
    this.screenAudioActive = false;
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];
    this.screenEventUnlisten = null;
    this.cameraEventUnlisten = null;
    this.transportLostUnlisten = null;
    this.publishedTracks.clear();
    this.sessionParticipantCapabilities.clear();
    this.publishedTrackListenersReady = false;
    this.localUserId = null;
    this.localRoomId = null;
    await invoke('stop_voice_session');
    this.disconnecting = false;
  }

  setMute(muted: boolean): void {
    invoke('voice_set_mute', { muted });
  }

  setDeaf(deafened: boolean): void {
    invoke('voice_set_deaf', { deafened });
  }

  /**
   * Enable/disable the local camera.
   *
   * Native-only (contract CAM4): there is no getUserMedia / canvas / raw-RGBA
   * path. Rust opens the camera via nokhwa, encodes off the session lock, and
   * publishes the track; the self-view renders the exact published bitstream
   * through the same pull-store subscription remote viewers use (contract CAM3).
   *
   * `deviceId` is a native camera id from {@link listCameraDevices} (falls back
   * to the default camera when omitted). The extra optional argument keeps this
   * assignable to the `MediaEngine.enableVideo(enabled)` signature.
   */
  async enableVideo(enabled: boolean, deviceId?: string): Promise<void> {
    await tauriReady;
    if (enabled) {
      await this.ensureNativeCameraEventListener();
      try {
        await invoke('voice_enable_video', {
          enabled: true,
          deviceId: deviceId ?? null,
          quality: null,
        });
      } catch (err) {
        logVoiceDiagnostic('[media] native camera enable failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    } else {
      await invoke('voice_enable_video', { enabled: false, deviceId: null, quality: null });
    }
  }

  /** Enumerate native capture cameras for device selection (contract CAM1). */
  async listCameraDevices(): Promise<Array<{ id: string; label: string }>> {
    await tauriReady;
    const devices = await invoke('camera_list_devices');
    return (devices as Array<{ id: string; label: string }>) ?? [];
  }

  /** Register a callback fired when native camera capture fails hard. */
  onCameraFailure(cb: (error: Error) => void): void {
    this.cameraFailureCb = cb;
  }

  /**
   * Subscribe an error listener for the native camera pipeline so an open/format
   * failure surfaces (fail-loudly) instead of a silently dead tile.
   */
  private async ensureNativeCameraEventListener(): Promise<void> {
    if (!listen || this.cameraEventUnlisten) return;
    this.cameraEventUnlisten = await listen('native_camera_event', (event) => {
      const payload = event.payload as { kind?: string; message?: string | null };
      if (payload.kind === 'error') {
        const message = payload.message ?? 'unknown camera error';
        logVoiceDiagnostic('[media] native camera error', { message });
        this.cameraFailureCb?.(new Error(message));
      }
    });
    this.unlisteners.push(this.cameraEventUnlisten);
  }

  async startScreenShare(config: ScreenShareConfig): Promise<void> {
    await tauriReady;

    if (!invoke) {
      throw new Error('Tauri IPC not available — cannot start screen share');
    }

    this.cleanupScreenShare();
    this.screenAudioActive = false;
    await this.ensureNativeScreenShareEventListener();
    const resolvedCodec = config.preferredCodec ?? (await this.choosePreferredScreenCodec());
    if (!resolvedCodec) {
      throw new Error(
        'No locally displayable screen-share codec is available. The native encoder can produce video, ' +
          'but this desktop client cannot render any common codec with its current WebCodecs/native-surface routes.',
      );
    }

    const targetFps = config.maxFrameRate ?? 30;
    await invoke('screen_share_start', {
      request: {
        sourceId: config.sourceId ?? null,
        maxFrameRate: targetFps,
        maxWidth: config.maxWidth ?? null,
        maxHeight: config.maxHeight ?? null,
        maxBitrateBps: config.maxBitrateBps ?? null,
        contentHint: config.contentHint ?? null,
        preferredCodec: resolvedCodec,
        captureAudio: config.audio,
      },
    });

    if (config.audio) {
      const audioReady = await this.enableNativeScreenAudio();
      if (!audioReady) {
        // Fail loudly to the diagnostics log; the voice store surfaces the
        // video-only state to the UI via isScreenShareAudioActive() (W9/C4).
        logVoiceDiagnostic(
          '[media] native system audio capture unavailable; streaming video-only',
        );
      }
      this.screenAudioActive = audioReady;
    } else {
      await invoke('voice_set_screen_audio_enabled', { enabled: false }).catch(() => { });
      this.screenAudioActive = false;
    }
  }

  async stopScreenShare(): Promise<void> {
    this.cleanupScreenShare();
    this.screenAudioActive = false;
    if (!invoke) return;
    await invoke('screen_share_stop').catch(() => { });
  }

  supportsNativeSourcePicker(): boolean {
    return true;
  }

  async listScreenShareSources(): Promise<ScreenShareSource[]> {
    await tauriReady;
    const sources = await invoke('screen_share_list_sources');
    return (sources as ScreenShareSource[]) ?? [];
  }

  async getScreenShareSourceThumbnail(sourceId: string): Promise<ScreenShareThumbnail | null> {
    await tauriReady;
    const thumbnail = await invoke('screen_share_source_thumbnail', { sourceId });
    return (thumbnail as ScreenShareThumbnail | null) ?? null;
  }

  isScreenShareAudioActive(): boolean {
    return this.screenAudioActive;
  }

  onScreenShareEnded(cb: () => void): void {
    this.screenShareEndedCb = cb;
  }

  private cleanupScreenShare(): void {
    this.disableNativeScreenAudio();
  }

  private async ensureNativeScreenShareEventListener(): Promise<void> {
    if (!listen) return;

    if (!this.screenEventUnlisten) {
      this.screenEventUnlisten = await listen('native_screen_share_event', (event) => {
        const payload = event.payload as { kind?: string; message?: string | null };
        if (payload.kind === 'error') {
          console.warn('[TauriMediaEngine] Native screen share error:', payload.message ?? 'unknown error');
          return;
        }
        if (payload.kind === 'ended') {
          this.cleanupScreenShare();
          this.screenAudioActive = false;
          this.screenShareEndedCb?.();
        }
      });
      this.unlisteners.push(this.screenEventUnlisten);
    }
  }

  /**
   * Enable native stereo system-audio capture for the active screen share.
   *
   * Per contract C4 the native capture loop (audio_capture.rs) delivers 48kHz
   * stereo 20ms frames straight into the session's screen_audio_tx — there is no
   * JS audio round-trip. The webview only issues the consent gate and enables
   * the screen-audio track; the receive side is played by the native cpal mixer.
   */
  private async enableNativeScreenAudio(): Promise<boolean> {
    try {
      // Consent gate + enable the screen-audio track. Native capture starts with
      // screen_share_start's captureAudio flag; nothing streams over IPC here.
      await invoke('set_system_audio_capture_enabled', { enabled: true });
      await invoke('voice_set_screen_audio_enabled', { enabled: true });
      this.screenAudioActive = true;
      return true;
    } catch (err) {
      logVoiceDiagnostic('[media] native system audio enable failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.disableNativeScreenAudio();
      return false;
    }
  }

  private disableNativeScreenAudio(): void {
    this.screenAudioActive = false;
    if (!invoke) return;
    invoke('stop_system_audio_capture').catch(() => {});
    invoke('set_system_audio_capture_enabled', { enabled: false }).catch(() => {});
    invoke('voice_set_screen_audio_enabled', { enabled: false }).catch(() => {});
  }

  onSpeakingChange(cb: (speakers: Map<string, number>) => void): void {
    const p = tauriReady.then(async () => {
      const unlisten = await listen('media_speaking_change', (event) => {
        const payload = event.payload;
        const speakers =
          payload && typeof payload === 'object'
            ? new Map(Object.entries(payload as Record<string, number>))
            : new Map<string, number>();
        cb(speakers);
      });
      this.unlisteners.push(unlisten);
    });
    this.listenerPromises.push(p);
  }

  onParticipantJoin(cb: (userId: string) => void): void {
    const p = tauriReady.then(async () => {
      const unlisten = await listen('media_participant_join', (event) => {
        cb(event.payload as string);
      });
      this.unlisteners.push(unlisten);
    });
    this.listenerPromises.push(p);
  }

  onParticipantLeave(cb: (userId: string) => void): void {
    const p = tauriReady.then(async () => {
      const unlisten = await listen('media_participant_leave', (event) => {
        cb(event.payload as string);
      });
      this.unlisteners.push(unlisten);
    });
    this.listenerPromises.push(p);
  }

  onTransportLost(cb: (reason: string) => void): void {
    this.transportLostCb = cb;
  }

  // getVolume is retained for interface compatibility. Stream audio is decoded
  // and mixed natively (contract C4); volume is applied via setSourceVolume →
  // voice_set_source_volume on the audio actor.
  subscribeScreenShareAudio(userId: string, getVolume: () => number): () => void {
    let registered: { streamId: string; trackId: string } | null = null;
    this.screenShareAudioSubscribers.add(userId);
    // Apply the caller's current volume immediately and keep it in sync.
    this.setSourceVolume(userId, getVolume());
    const volumeTimer = setInterval(() => {
      if (!this.screenShareAudioSubscribers.has(userId)) return;
      this.setSourceVolume(userId, getVolume());
    }, 100);

    void tauriReady.then(async () => {
      if (!this.screenShareAudioSubscribers.has(userId)) {
        return;
      }
      const tracks = await this.listPublishedTracks().catch(() => []);
      const audioTrack = tracks.find(
        (track) =>
          String(track.publisherUserId) === userId &&
          track.trackId === 'screen-audio' &&
          track.kind === 'audio',
      );
      if (audioTrack && this.screenShareAudioSubscribers.has(userId)) {
        registered = { streamId: audioTrack.streamId, trackId: audioTrack.trackId };
        await this.registerTrackSubscription({
          streamId: audioTrack.streamId,
          trackId: audioTrack.trackId,
          requestedLayer: 0,
        }).catch(() => {});
      }
    });

    return () => {
      clearInterval(volumeTimer);
      this.screenShareAudioSubscribers.delete(userId);
      if (registered) {
        void this.unregisterTrackSubscription(registered.streamId, registered.trackId).catch(() => {});
        registered = null;
      }
    };
  }

  setSourceVolume(userId: string, gain: number): void {
    void tauriReady.then(() =>
      invoke('voice_set_source_volume', {
        userId,
        ssrc: null,
        gain: Math.min(2, Math.max(0, gain)),
      }).catch(() => {}),
    );
  }

  private clearScreenShareAudioSubscriptions(): void {
    this.screenShareAudioSubscribers.clear();
  }

  private async initializeTransportListeners(): Promise<void> {
    if (!listen) return;

    if (!this.transportLostUnlisten) {
      this.transportLostUnlisten = await listen('media_transport_lost', (event) => {
        if (this.disconnecting) return;
        const reason =
          typeof event.payload === 'string'
            ? event.payload
            : 'Native voice connection lost';
        this.transportLostCb?.(reason);
      });
      this.unlisteners.push(this.transportLostUnlisten);
    }

    // Stream audio is decoded and played by the native cpal mixer (contract
    // C4). The media_stream_audio_pcm JSON event and its WebAudio playback path
    // are intentionally gone — no per-sample JSON round trip through the webview.

    const bandwidthUnlisten = await listen('media_bandwidth_feedback', (event) => {
      const payload = event.payload as { availableKbps?: number } | null;
      const availableKbps = Number(payload?.availableKbps ?? 0);
      if (!Number.isFinite(availableKbps) || availableKbps <= 0) return;
      void this.applyBandwidthFeedback(availableKbps).catch(() => {});
    });
    this.unlisteners.push(bandwidthUnlisten);
  }

  private async applyBandwidthFeedback(availableKbps: number): Promise<void> {
    for (const [, sub] of this.videoSubscriptions) {
      if (!sub.streamId || !sub.trackId || !sub.channel) continue;
      const track = this.publishedTracks.get(`${sub.streamId}:${sub.trackId}`);
      if (!track?.layers.length) continue;
      const sortedLayers = [...track.layers].sort(
        (a, b) => (a.maxBitrateKbps ?? 0) - (b.maxBitrateKbps ?? 0),
      );
      let targetLayer = sortedLayers[0]?.layerId ?? 0;
      for (const layer of sortedLayers) {
        if ((layer.maxBitrateKbps ?? 0) <= availableKbps) {
          targetLayer = layer.layerId;
        }
      }
      if (sub.activeLayer === targetLayer) continue;
      sub.activeLayer = targetLayer;
      const viewport = rendererCanvasSize(sub.renderer);
      await invoke('media_register_stream_video_subscription', {
        streamId: sub.streamId,
        trackId: sub.trackId,
        ssrc: track.layers.find((layer) => layer.layerId === targetLayer)?.ssrc,
        preferEncoded: await isWebCodecsDecodeSupported(track.codec ?? 'vp9'),
        channel: sub.channel,
      }).catch(() => {});
      await this.registerTrackSubscription({
        streamId: sub.streamId,
        trackId: sub.trackId,
        requestedLayer: targetLayer,
        activeLayer: targetLayer,
        viewport,
      }).catch(() => {});
    }
  }

  async getStreamCapabilities(): Promise<MediaStreamCapabilities> {
    await tauriReady;
    if (!nativeStreamCapabilitiesPromise) {
      nativeStreamCapabilitiesPromise = (async () => {
        const nativeCapabilities = (await invoke(
          'media_get_stream_capabilities',
        )) as MediaStreamCapabilities;
        return mergeNativeAndViewerCapabilities(nativeCapabilities);
      })();
    }
    return nativeStreamCapabilitiesPromise;
  }

  async getStreamingDiagnostics(): Promise<MediaStreamDiagnostics> {
    await tauriReady;
    const diagnostics = (await invoke('media_get_stream_diagnostics')) as MediaStreamDiagnostics;
    const preferredCommonCodec = await this.choosePreferredScreenCodec().catch(() => null);
    const localUserId = String(this.localUserId ?? '');
    const localTracks = (diagnostics.publishedTracks ?? []).filter(
      (track) => String(track.publisherUserId) === localUserId,
    );
    const cameraTrack =
      localTracks.find((track) => track.trackId === 'camera') ??
      localTracks.find((track) => track.streamId.includes(':camera'));
    const screenTrack =
      localTracks.find((track) => track.trackId === 'screen') ??
      localTracks.find((track) => track.streamId.includes(':screen'));
    return {
      ...diagnostics,
      localPublishCodecs: {
        preferredCommonCodec,
        cameraCodec: cameraTrack?.codec ?? null,
        screenCodec: screenTrack?.codec ?? null,
      },
    };
  }

  async listPublishedTracks(): Promise<PublishedTrackDescriptor[]> {
    await tauriReady;
    const tracks = (await invoke('media_list_published_tracks')) as PublishedTrackDescriptor[] | null;
    if (tracks) {
      this.publishedTracks.clear();
      for (const track of tracks) {
        this.publishedTracks.set(`${track.streamId}:${track.trackId}`, track);
      }
      return tracks;
    }
    return Array.from(this.publishedTracks.values());
  }

  /** Whether we publish this track ourselves (self-view). */
  private isOwnPublishedTrack(streamId: string, trackId: string): boolean {
    const track = this.publishedTracks.get(`${streamId}:${trackId}`);
    return (
      !!track &&
      this.localUserId != null &&
      String(track.publisherUserId) === String(this.localUserId)
    );
  }

  async registerTrackSubscription(request: TrackSubscriptionRequest): Promise<void> {
    await tauriReady;
    // Never subscribe to our own tracks at the relay: the self-view is fed
    // the encoded frames directly from the encoder, so a relay subscription
    // would just loop the identical bitstream back over the network and
    // decode every frame twice.
    if (this.isOwnPublishedTrack(request.streamId, request.trackId)) {
      return;
    }
    await invoke('media_register_track_subscription', {
      request: {
        streamId: request.streamId,
        trackId: request.trackId,
        requestedLayer: request.requestedLayer ?? null,
        activeLayer: request.activeLayer ?? null,
        viewportWidth: request.viewport?.width ?? null,
        viewportHeight: request.viewport?.height ?? null,
      },
    });
  }

  async unregisterTrackSubscription(streamId: string, trackId: string): Promise<void> {
    await tauriReady;
    if (this.isOwnPublishedTrack(streamId, trackId)) {
      return;
    }
    await invoke('media_unregister_track_subscription', { streamId, trackId });
  }

  private clearVideoSubscriptions(): void {
    for (const [, sub] of this.videoSubscriptions) {
      sub.stop();
      sub.decoder?.close();
      sub.renderer.destroy();
    }
    this.videoSubscriptions.clear();
    this.keyframeRequestAt.clear();
  }

  // Last keyframe request per `${streamId}:${trackId}`, so a flurry of decoder
  // desync events collapses to at most one request per 500ms per track (W3/C2).
  private keyframeRequestAt = new Map<string, number>();

  /** Ask the publisher for a fresh keyframe (contract C2), debounced per track.
   * The native side sets its force-keyframe flag for a locally-published track,
   * or forwards a RequestKeyframe control message upstream otherwise. */
  private requestKeyframe(streamId: string, trackId: string): void {
    const key = `${streamId}:${trackId}`;
    const now = Date.now();
    const last = this.keyframeRequestAt.get(key) ?? 0;
    if (now - last < 500) {
      return;
    }
    this.keyframeRequestAt.set(key, now);
    void invoke('media_request_keyframe', { streamId, trackId }).catch((err) => {
      logVoiceDiagnostic('[media] media_request_keyframe failed', {
        streamId,
        trackId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private pickPublishedVideoTrack(
    publisherUserId: string,
    tracks: PublishedTrackDescriptor[],
    preferredTrackId?: 'camera' | 'screen',
  ): PublishedTrackDescriptor | null {
    const publisherTracks = tracks.filter(
      (track) =>
        String(track.publisherUserId) === publisherUserId &&
        track.kind === 'video',
    );
    if (preferredTrackId) {
      return (
        publisherTracks.find((track) => track.trackId === preferredTrackId) ??
        null
      );
    }
    return (
      publisherTracks.find((track) => track.trackId === 'screen') ??
      publisherTracks.find((track) => track.trackId === 'camera') ??
      publisherTracks[0] ??
      null
    );
  }

  private notifyPublishedVideoTrackWaiters(track: PublishedTrackDescriptor): void {
    if (track.kind !== 'video') {
      return;
    }
    const userId = String(track.publisherUserId);
    const keys = [
      this.publishedVideoWaitKey(userId),
      this.publishedVideoWaitKey(userId, track.trackId === 'camera' ? 'camera' : undefined),
      this.publishedVideoWaitKey(userId, track.trackId === 'screen' ? 'screen' : undefined),
    ];
    for (const key of keys) {
      const waiters = this.pendingPublishedVideoTrackWaits.get(key);
      if (!waiters) continue;
      for (const resolve of waiters) {
        resolve(track);
      }
      this.pendingPublishedVideoTrackWaits.delete(key);
    }
  }

  private async waitForPublishedVideoTrack(
    publisherUserId: string,
    timeoutMs = 10000,
    preferredTrackId?: 'camera' | 'screen',
  ): Promise<PublishedTrackDescriptor | null> {
    await this.initializePublishedTrackListeners();
    const waitKey = this.publishedVideoWaitKey(publisherUserId, preferredTrackId);

    const cached = this.pickPublishedVideoTrack(
      publisherUserId,
      [...this.publishedTracks.values()],
      preferredTrackId,
    );
    if (cached) {
      return cached;
    }

    const tracks = await this.listPublishedTracks().catch(() => []);
    for (const track of tracks) {
      this.publishedTracks.set(`${track.streamId}:${track.trackId}`, track);
    }
    const listed = this.pickPublishedVideoTrack(publisherUserId, tracks, preferredTrackId);
    if (listed) {
      return listed;
    }

    if (!listen) {
      return null;
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (track: PublishedTrackDescriptor | null) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        const waiters = this.pendingPublishedVideoTrackWaits.get(waitKey);
        waiters?.delete(notify);
        if (waiters?.size === 0) {
          this.pendingPublishedVideoTrackWaits.delete(waitKey);
        }
        resolve(track);
      };

      const notify = (track: PublishedTrackDescriptor) => {
        if (preferredTrackId && track.trackId !== preferredTrackId) {
          return;
        }
        finish(track);
      };

      let waiters = this.pendingPublishedVideoTrackWaits.get(waitKey);
      if (!waiters) {
        waiters = new Set();
        this.pendingPublishedVideoTrackWaits.set(waitKey, waiters);
      }
      waiters.add(notify);

      const timeoutId = window.setTimeout(() => finish(null), timeoutMs);
    });
  }

  private async initializePublishedTrackListeners(): Promise<void> {
    if (!listen) return;
    if (this.publishedTrackListenersReady) {
      return;
    }

    const publishUnlisten = await listen('media_track_publish', (event) => {
      const track = event.payload as PublishedTrackDescriptor | null;
      if (!track?.streamId || !track.trackId) return;
      this.publishedTracks.set(`${track.streamId}:${track.trackId}`, track);
      this.notifyPublishedVideoTrackWaiters(track);
      if (String(track.publisherUserId) === String(this.localUserId ?? '')) {
        void this.announceWrappedTrackKey(track).catch(() => {});
      }
      const userId = String(track.publisherUserId);
      const existing =
        this.videoSubscriptions.get(`${userId}:${track.trackId}`) ??
        (track.trackId === 'screen' || track.trackId === 'camera'
          ? this.videoSubscriptions.get(userId)
          : undefined);
      if (!existing) {
        return;
      }
      // Don't overwrite a camera subscription with a screen publish (or vice versa)
      // when both are active under distinct keys.
      if (existing.trackId && existing.trackId !== track.trackId && this.videoSubscriptions.has(`${userId}:${existing.trackId}`)) {
        return;
      }
      const viewport = rendererCanvasSize(existing.renderer);
      const selectedLayer = selectPublishedLayer(track, viewport.width, viewport.height);
      if (!selectedLayer) {
        return;
      }
      existing.streamId = track.streamId;
      existing.trackId = track.trackId;
      existing.activeLayer = selectedLayer.layerId;
      const existingChannel = existing.channel;
      if (existingChannel) {
        void isWebCodecsDecodeSupported(track.codec ?? 'vp9')
          .then((preferEncoded) =>
            invoke('media_register_stream_video_subscription', {
              streamId: track.streamId,
              trackId: track.trackId,
              ssrc: selectedLayer.ssrc,
              preferEncoded,
              channel: existingChannel,
            }),
          )
          .catch(() => {});
      }
      void this.registerTrackSubscription({
        streamId: track.streamId,
        trackId: track.trackId,
        requestedLayer: selectedLayer.layerId,
        viewport,
      }).catch(() => {});
    });

    const unpublishUnlisten = await listen('media_track_unpublish', (event) => {
      const payload = event.payload as { streamId?: string; trackId?: string } | null;
      if (!payload?.streamId || !payload.trackId) return;
      this.publishedTracks.delete(`${payload.streamId}:${payload.trackId}`);
    });

    this.publishedTrackListenersReady = true;
    this.unlisteners.push(publishUnlisten, unpublishUnlisten);
  }

  private async initializeMediaKeyListeners(): Promise<void> {
    if (!listen) return;

    const audioKeyUnlisten = await listen('media_key_deliver', (event) => {
      const payload = event.payload as {
        senderUserId?: string;
        epoch?: number;
        ciphertext?: number[];
      } | null;
      if (!payload?.senderUserId || payload.epoch == null || !Array.isArray(payload.ciphertext)) {
        return;
      }
      void unwrapDeliveredMediaSenderKey(
        this.audioKeyScope(),
        payload.senderUserId,
        Uint8Array.from(payload.ciphertext),
      )
        .then((decrypted) =>
          invoke('media_apply_audio_sender_key', {
            senderUserId: payload.senderUserId,
            epoch: decrypted.epoch || payload.epoch,
            rawKey: Array.from(decrypted.rawKey),
          }),
        )
        .catch(() => {});
    });

    const streamKeyUnlisten = await listen('media_stream_key_deliver', (event) => {
      const payload = event.payload as {
        streamId?: string;
        trackId?: string;
        senderUserId?: string;
        epoch?: number;
        ciphertext?: number[];
      } | null;
      if (
        !payload?.streamId ||
        !payload.trackId ||
        !payload.senderUserId ||
        payload.epoch == null ||
        !Array.isArray(payload.ciphertext)
      ) {
        return;
      }
      void unwrapDeliveredMediaSenderKey(
        this.trackKeyScope(payload.streamId, payload.trackId),
        payload.senderUserId,
        Uint8Array.from(payload.ciphertext),
      )
        .then((decrypted) =>
          invoke('media_apply_track_sender_key', {
            streamId: payload.streamId,
            trackId: payload.trackId,
            epoch: decrypted.epoch || payload.epoch,
            rawKey: Array.from(decrypted.rawKey),
          }),
        )
        .catch(() => {});
    });
    const participantJoinUnlisten = await listen('media_participant_join', (event) => {
      const userId = String(event.payload ?? '');
      if (!userId || userId === String(this.localUserId ?? '')) {
        return;
      }
      void this.announceWrappedLocalSenderKeys([userId]).catch(() => {});
    });
    const participantJoinDetailsUnlisten = await listen('media_participant_join_details', (event) => {
      const payload = event.payload as SessionParticipantCapabilities | null;
      if (!payload?.userId || payload.userId === String(this.localUserId ?? '')) {
        return;
      }
      this.sessionParticipantCapabilities.set(payload.userId, payload);
    });
    const participantLeaveUnlisten = await listen('media_participant_leave', (event) => {
      const userId = String(event.payload ?? '');
      if (userId) {
        this.sessionParticipantCapabilities.delete(userId);
      }
      void this.announceWrappedLocalSenderKeys().catch(() => {});
    });
    const requestStreamKeyUnlisten = await listen('media_request_stream_key', (event) => {
      const payload = event.payload as {
        streamId?: string;
        trackId?: string;
        recipientUserId?: string;
      } | null;
      if (!payload?.streamId || !payload.trackId || !payload.recipientUserId) {
        return;
      }
      const track = this.publishedTracks.get(`${payload.streamId}:${payload.trackId}`);
      if (!track || String(track.publisherUserId) !== String(this.localUserId ?? '')) {
        return;
      }
      void this.announceWrappedTrackKey(track, [payload.recipientUserId]).catch(() => {});
    });

    this.unlisteners.push(
      audioKeyUnlisten,
      streamKeyUnlisten,
      participantJoinUnlisten,
      participantJoinDetailsUnlisten,
      participantLeaveUnlisten,
      requestStreamKeyUnlisten,
    );
  }

  /**
   * Re-register a subscription's stream channel to force the native side to
   * re-push its latest stored frame. Used to repaint a stream that was hidden
   * (its live frames were dropped) the instant it becomes visible again.
   */
  private replayStreamVideoFrame(userId: string): void {
    const sub = this.videoSubscriptions.get(userId);
    if (!sub?.streamId || !sub.trackId || !sub.channel) {
      return;
    }
    const track = this.publishedTracks.get(`${sub.streamId}:${sub.trackId}`);
    const ssrc =
      (sub.activeLayer != null
        ? track?.layers.find((layer) => layer.layerId === sub.activeLayer)?.ssrc
        : undefined) ?? track?.layers[0]?.ssrc;
    if (ssrc == null) {
      return;
    }
    const { streamId, trackId, channel } = sub;
    void isWebCodecsDecodeSupported(track?.codec ?? 'vp9')
      .then((preferEncoded) =>
        invoke('media_register_stream_video_subscription', {
          streamId,
          trackId,
          ssrc,
          preferEncoded,
          channel,
        }),
      )
      .catch(() => {});
  }

  subscribeVideo(
    userId: string,
    canvas: HTMLCanvasElement,
    onFrame?: () => void,
    options?: { preferredTrackId?: 'camera' | 'screen' },
  ): () => void {
    let disposed = false;
    const preferredTrackId = options?.preferredTrackId;
    // Camera and screen can be subscribed concurrently for the same publisher;
    // key the map so they don't tear each other down.
    const subscriptionKey = preferredTrackId ? `${userId}:${preferredTrackId}` : userId;
    const existing = this.videoSubscriptions.get(subscriptionKey);
    if (existing) {
      existing.stop();
      existing.renderer.destroy();
      this.videoSubscriptions.delete(subscriptionKey);
    }

    void tauriReady.then(async () => {
      if (disposed) return;
      try {
        logVoiceDiagnostic('[media] starting native remote video subscription', {
          userId,
          preferredTrackId: preferredTrackId ?? null,
        });
        const renderer = new CanvasRenderer(canvas);
        // On becoming visible again, replay the latest stored frame by
        // re-registering (the native side re-pushes it), so a paused/off-screen
        // stream repaints immediately instead of waiting for the sender's next
        // frame — which for a static screen share could be seconds away.
        let resumeSubscription = () => {};
        // Signals the native side to stop/resume decode+push for this track
        // (contract C2). Set once streamId/trackId are known below; a no-op until
        // then (the native side hasn't started this track's decode yet).
        let notifyNativeVisibility = (_visible: boolean) => {};
        const visibility = attachStreamVisibilityControls(canvas, renderer, (visible) => {
          notifyNativeVisibility(visible);
          if (visible) {
            resumeSubscription();
          }
        });
        const publishedTrack = await this.waitForPublishedVideoTrack(
          userId,
          10000,
          preferredTrackId,
        );
        let subscription: NativeVideoSubscription;
        // Teardowns that must survive a watchdog channel rebuild (W6): the
        // visibility/resize observers and the stall timer are torn down only
        // when the whole subscription stops, not when its channel is swapped.
        const teardowns: Array<() => void> = [];
        let lastFrameAt = Date.now();
        const markFrame = () => {
          lastFrameAt = Date.now();
          onFrame?.();
        };
        if (publishedTrack && !disposed && ChannelCtor) {
          const ChannelCtorRef = ChannelCtor;
          const viewport = rendererCanvasSize(renderer);
          const selectedLayer = selectPublishedLayer(publishedTrack, viewport.width, viewport.height);
          const streamId = publishedTrack.streamId;
          const trackId = publishedTrack.trackId;
          const label = `remote:${streamId}:${trackId}`;
          // Route chosen ONCE at subscribe time (spec §2): the functional
          // WebCodecs probe decides `webcodecs-passthrough` vs `native-surface`.
          // No runtime switching, no silent fallback — a route that cannot be
          // established is a loud error for this subscription (spec §0/§3.7).
          const preferEncoded = await isWebCodecsDecodeSupported(
            publishedTrack.codec ?? 'vp9',
          );
          const streamCaps = await this.getStreamCapabilities().catch(() => null);
          const nativeSurfaceAvailable = Boolean(streamCaps?.nativeDesktopRenderer);
          // Underlay (Linux GTK): the surface composites BELOW the webview, so
          // the tile must punch a transparent hole in the DOM (via the event
          // below). Do NOT run DOM occlusion blanking here: body portals
          // (device picker, tooltips, topbar overlays with inset-0 backdrops)
          // used to hide the entire GL tile → black stream, and visibility-flip
          // repaints glued hover chrome into the video. Opaque portal/tooltip
          // CSS keeps UI above the live underlay instead.
          const nativeRenderUnderlay = Boolean(streamCaps?.nativeRenderUnderlay);
          if (preferEncoded) {
          let driverStop = () => {};
          // A fresh decoder chain per channel: reattaching a driver to an
          // existing decoder would double-register its onDecoded callback and
          // render (then close) each frame twice. On a rebuild we close the old
          // decoder and let the new channel lazily reconfigure — which also
          // forces the keyframe resync a post-stall stream needs anyway.
          let decoderRef = {
            current: null as MediaVideoDecoder | null,
            codec: null as string | null,
          };
          const startDriverOnChannel = (driverChannel: VideoFrameChannel) => {
            driverStop();
            decoderRef.current?.close();
            decoderRef = { current: null, codec: null };
            driverStop = startPulledEncodedVideoSubscription(
              label,
              driverChannel,
              decoderRef,
              renderer,
              markFrame,
              undefined,
              visibility.isRenderingEnabled,
              () => this.requestKeyframe(streamId, trackId),
            );
          };
          const registerStreamOnChannel = async (
            registerChannel: VideoFrameChannel,
            ssrc: number | undefined,
          ) => {
            await invoke('media_register_stream_video_subscription', {
              streamId,
              trackId,
              ssrc,
              // Decode in the webview (GPU, tiny IPC payloads) whenever this
              // webview supports the codec; native decode is the fallback.
              preferEncoded: await isWebCodecsDecodeSupported(publishedTrack.codec ?? 'vp9'),
              channel: registerChannel,
            });
          };

          // One channel per subscription: the native side pushes this track's
          // frames here and re-pushes the latest frame on every (re)register.
          const channel = new ChannelCtorRef<VideoFrameChannelMessage>();
          if (selectedLayer) {
            await registerStreamOnChannel(channel, selectedLayer.ssrc);
          }
          await this.registerTrackSubscription({
            streamId,
            trackId,
            requestedLayer: selectedLayer?.layerId,
            viewport,
          }).catch((error) => {
            logVoiceDiagnostic('[media] failed to register native track subscription', {
              userId,
              streamId,
              trackId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          startDriverOnChannel(channel);
          subscription = {
            renderer,
            channel,
            streamId,
            trackId,
            activeLayer: selectedLayer?.layerId,
            stop: () => {
              driverStop();
              decoderRef.current?.close();
            },
          };
          resumeSubscription = () => this.replayStreamVideoFrame(userId);
          notifyNativeVisibility = (visible: boolean) => {
            void invoke('media_set_stream_visibility', { streamId, trackId, visible }).catch(
              (err) => {
                logVoiceDiagnostic('[media] media_set_stream_visibility failed', {
                  streamId,
                  trackId,
                  visible,
                  error: err instanceof Error ? err.message : String(err),
                });
              },
            );
          };

          // W6: index-ordered channel delivery means one lost __TAURI_CHANNEL__
          // fetch stalls the subscription forever. If a visible, still-published
          // track goes silent for 4s, rebuild it on a fresh channel and force a
          // re-push. Invisible streams are intentionally quiet — don't rebuild.
          const stallTimer = setInterval(() => {
            if (this.videoSubscriptions.get(subscriptionKey) !== subscription) {
              return;
            }
            if (!(visibility.isRenderingEnabled?.() ?? true)) {
              lastFrameAt = Date.now();
              return;
            }
            if (Date.now() - lastFrameAt < 4000) {
              return;
            }
            const track = this.publishedTracks.get(`${streamId}:${trackId}`);
            if (!track) {
              return;
            }
            const ssrc =
              (subscription.activeLayer != null
                ? track.layers.find((layer) => layer.layerId === subscription.activeLayer)?.ssrc
                : undefined) ?? track.layers[0]?.ssrc;
            if (ssrc == null) {
              return;
            }
            logVoiceDiagnostic('[media] video subscription stalled 4s; re-registering on a fresh channel', {
              userId,
              streamId,
              trackId,
            });
            lastFrameAt = Date.now();
            const freshChannel = new ChannelCtorRef<VideoFrameChannelMessage>();
            subscription.channel = freshChannel;
            startDriverOnChannel(freshChannel);
            void registerStreamOnChannel(freshChannel, ssrc).catch(() => {});
          }, 1000);
          teardowns.push(() => clearInterval(stallTimer));
          } else if (nativeSurfaceAvailable) {
            // native-surface route (spec §2/§3.6): the functional WebCodecs
            // probe failed for this codec, so the native side decodes and
            // presents this track on a platform surface. Nothing but geometry
            // and visibility crosses IPC — no frame channel and no raw-frame
            // watchdog (the native side owns delivery). The relay track
            // subscription below shares the keyframe/layer/viewport plumbing
            // with the passthrough route; the tile owns visibility.
            // Underlay hole-punch: tell the tile's component (StreamViewer)
            // when the surface below is actually visible, so it can clear its
            // backgrounds down to the GL underlay — and restore its opaque
            // backdrop the moment the surface hides. Overlay platforms never
            // dispatch this: there the surface floats above the webview and a
            // transparent tile would just expose the page background.
            const dispatchUnderlayVisibility = (visible: boolean) => {
              if (!nativeRenderUnderlay) return;
              canvas.dispatchEvent(
                new CustomEvent('paracord:native-surface-visibility', {
                  detail: { visible },
                  bubbles: true,
                }),
              );
            };
            const nativeTile = new NativeVideoTile({
              element: canvas,
              streamId,
              trackId,
              invoke,
              // Underlay: never blank the GL surface for DOM overlays. Stage
              // chrome and body portals paint above the hole; solid CSS keeps
              // them readable. (Re-enable `'underlay'` only with center-only
              // sampling — see nativeVideoTile — and never for inset-0 backdrops.)
              occlusion: nativeRenderUnderlay ? false : true,
              onAttached: () => {
                // No per-frame IPC signal exists on this route: a created
                // surface is the "track is live" edge, so reveal the tile
                // region the native surface composites over.
                markFrame();
              },
              onVisibilityChange: (visible) => {
                // The tile is the single source of visibility here (intersection
                // + occlusion + document visibility); drive the native
                // decode-pause exactly as the channel route does (contract C2).
                // Flips are rare and load-bearing (an occluded tile means a
                // hidden surface), so each one goes to the diagnostics log.
                logVoiceDiagnostic('[media] native tile visibility', {
                  streamId,
                  trackId,
                  visible,
                });
                dispatchUnderlayVisibility(visible);
                void invoke('media_set_stream_visibility', {
                  streamId,
                  trackId,
                  visible,
                }).catch((err) => {
                  logVoiceDiagnostic('[media] media_set_stream_visibility failed', {
                    streamId,
                    trackId,
                    visible,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              },
            });
            // Relay track subscription (keyframe / layer / viewport plumbing) is
            // identical to the passthrough route; only the final mile differs.
            await this.registerTrackSubscription({
              streamId,
              trackId,
              requestedLayer: selectedLayer?.layerId,
              viewport,
            }).catch((error) => {
              logVoiceDiagnostic('[media] failed to register native track subscription', {
                userId,
                streamId,
                trackId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            // Failure law (spec §3.7): a surface that cannot be created or kept
            // is a loud, user-visible subscription error — never a raw-IPC
            // fallback (that path is deleted). Tear the subscription down when
            // the native side names this track.
            // The webview sees no frames on this route; the native side emits a
            // one-time first-presented-frame event per surface. Feed it to the
            // same onFrame edge the passthrough route drives per frame, so
            // "track is live" state reflects actual presentation, not merely a
            // created surface.
            let firstFrameUnlisten: UnlistenFn | null = null;
            if (listen) {
              firstFrameUnlisten = await listen('media_native_render_first_frame', (event) => {
                const payload = event.payload as {
                  streamId?: string;
                  trackId?: string;
                } | null;
                if (payload?.streamId !== streamId || payload?.trackId !== trackId) {
                  return;
                }
                markFrame();
              });
              this.unlisteners.push(firstFrameUnlisten);
            }
            let failureUnlisten: UnlistenFn | null = null;
            if (listen) {
              failureUnlisten = await listen('media_native_render_failed', (event) => {
                const payload = event.payload as {
                  streamId?: string;
                  trackId?: string;
                  reason?: string;
                } | null;
                if (payload?.streamId !== streamId || payload?.trackId !== trackId) {
                  return;
                }
                const reason = payload?.reason ?? 'unknown native render failure';
                console.error(
                  '[media] native surface render failed — tearing down subscription (no raw-IPC fallback)',
                  { userId, streamId, trackId, reason },
                );
                logVoiceDiagnostic('[media] native surface render failed', {
                  userId,
                  streamId,
                  trackId,
                  reason,
                });
                const current = this.videoSubscriptions.get(subscriptionKey);
                if (current === subscription) {
                  current.stop();
                  current.renderer.destroy();
                  this.videoSubscriptions.delete(subscriptionKey);
                }
              });
              this.unlisteners.push(failureUnlisten);
            }
            subscription = {
              renderer,
              streamId,
              trackId,
              activeLayer: selectedLayer?.layerId,
              nativeTile,
              stop: () => {
                if (firstFrameUnlisten) {
                  firstFrameUnlisten();
                }
                if (failureUnlisten) {
                  failureUnlisten();
                }
                // Close the underlay hole so the tile's opaque backdrop is
                // back before (or as) the native surface disappears.
                dispatchUnderlayVisibility(false);
                nativeTile.destroy();
              },
            };
            // Create the surface now. A subscribe-time attach failure is loud and
            // leaves the DOM poster/backdrop showing (spec §3.7) — never raw IPC.
            try {
              await nativeTile.attach();
            } catch (err) {
              console.error(
                '[media] native_render_attach failed — no raw-IPC fallback (spec §3.7)',
                {
                  userId,
                  streamId,
                  trackId,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
              logVoiceDiagnostic('[media] native_render_attach failed', {
                userId,
                streamId,
                trackId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else {
            const codec = publishedTrack.codec ?? 'unknown';
            logVoiceDiagnostic('[media] no render route for published video track', {
              userId,
              streamId,
              trackId,
              codec,
              webCodecsDecode: false,
              nativeDesktopRenderer: false,
            });
            console.error(
              `[media] no render route for ${codec} video track: WebCodecs cannot decode it and native desktop rendering is unavailable`,
              { userId, streamId, trackId },
            );
            subscription = {
              renderer,
              streamId,
              trackId,
              activeLayer: selectedLayer?.layerId,
              stop: () => {},
            };
          }
        } else {
          logVoiceDiagnostic('[media] no published native track announced before subscription timeout', {
            userId,
          });
          subscription = {
            renderer,
            stop: () => {},
          };
        }
        let resizeObserver: ResizeObserver | null = null;
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const updateViewportSubscription = () => {
          const current = this.videoSubscriptions.get(subscriptionKey);
          if (!current?.streamId || !current.trackId) {
            return;
          }
          const track = this.publishedTracks.get(`${current.streamId}:${current.trackId}`);
          if (!track) {
            return;
          }
          const viewport = rendererCanvasSize(current.renderer);
          // Always refresh the relay's viewport hint so its per-viewer layer
          // selection is capped to the tile size (spec §4.2/I4). This is
          // independent of the client's local layer guess and applies to BOTH the
          // passthrough and native-surface routes — the native-surface route has
          // no frame channel to swap, but the relay still needs the tile dims.
          void this.registerTrackSubscription({
            streamId: current.streamId,
            trackId: current.trackId,
            viewport,
          }).catch(() => {});

          // Passthrough route only: when the client's local layer guess changes,
          // swap the stream channel's ssrc so the native decoder is fed the newly
          // selected layer. (Relay-driven selection still owns forwarding; this
          // just keeps the receive-side channel's expected ssrc current.)
          if (!current.channel) {
            return;
          }
          const selectedLayer = selectPublishedLayer(track, viewport.width, viewport.height);
          if (!selectedLayer || current.activeLayer === selectedLayer.layerId) {
            return;
          }
          current.activeLayer = selectedLayer.layerId;
          const { streamId: currentStreamId, trackId: currentTrackId, channel: currentChannel } = current;
          void isWebCodecsDecodeSupported(track.codec ?? 'vp9')
            .then((preferEncoded) =>
              invoke('media_register_stream_video_subscription', {
                streamId: currentStreamId,
                trackId: currentTrackId,
                ssrc: selectedLayer.ssrc,
                preferEncoded,
                channel: currentChannel,
              }),
            )
            .catch(() => {});
        };
        if (!disposed && typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) {
              clearTimeout(resizeTimer);
            }
            resizeTimer = setTimeout(updateViewportSubscription, 120);
          });
          resizeObserver.observe(canvas);
          teardowns.push(() => {
            if (resizeTimer) {
              clearTimeout(resizeTimer);
            }
            resizeObserver?.disconnect();
          });
        }
        teardowns.push(() => visibility.cleanup());
        const originalStop = subscription.stop;
        subscription.stop = () => {
          for (const teardown of teardowns) {
            teardown();
          }
          originalStop();
        };
        // The consumer may have unsubscribed while the async setup above was in
        // flight (waitForPublishedVideoTrack can block up to 10s). The
        // unsubscribe closure already ran and found no map entry to stop, so if
        // we store this subscription now its renderer RAF / frame-poll loop
        // would run forever against a detached canvas. Drop it instead.
        if (disposed) {
          subscription.stop();
          subscription.renderer.destroy();
          return;
        }
        this.videoSubscriptions.set(subscriptionKey, subscription);
      } catch (err) {
        logVoiceDiagnostic('[media] failed to start native remote video subscription', {
          userId,
          preferredTrackId: preferredTrackId ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return () => {
      disposed = true;
      const current = this.videoSubscriptions.get(subscriptionKey);
      if (current) {
        if (current.streamId && current.trackId) {
          void this.unregisterTrackSubscription(current.streamId, current.trackId).catch(() => {});
          // Only the passthrough route registered a stream video subscription;
          // a native-surface subscription (no channel) is torn down via the
          // tile's native_render_detach in current.stop() below (spec §3.6).
          if (current.channel) {
            void invoke('media_unregister_stream_video_subscription', {
              streamId: current.streamId,
              trackId: current.trackId,
            }).catch(() => {});
          }
        }
        current.stop();
        current.decoder?.close();
        current.renderer.destroy();
        this.videoSubscriptions.delete(subscriptionKey);
      }
    };
  }

  subscribeLocalPublishedScreen(canvas: HTMLCanvasElement, onFrame?: () => void): () => void {
    if (!this.localUserId) {
      return () => {};
    }
    // Self-preview uses the same channel-push path but is skipped when StreamViewer hides it.
    return this.subscribeVideo(this.localUserId, canvas, onFrame);
  }

  private async listSessionParticipantCapabilities(): Promise<SessionParticipantCapabilities[]> {
    await tauriReady;
    const participants = await invoke('media_list_session_participant_capabilities');
    return ((participants as SessionParticipantCapabilities[] | null) ?? []).filter(
      (participant) => participant.userId && participant.userId !== String(this.localUserId ?? ''),
    );
  }

  private pickBestCommonCodec(
    localCapabilities: MediaStreamCapabilities,
    participants: SessionParticipantCapabilities[],
  ): 'av1' | 'h264' | 'vp9' | null {
    const localEncoders = localCapabilities.video
      .filter((capability) => capability.encode)
      .map((capability) => ({
        codec: String(capability.codec).toLowerCase(),
        encodeHardware: Boolean(capability.encodeHardware),
      }));
    if (!localEncoders.length) {
      return null;
    }

    const hasLocalEncoder = (
      codec: 'av1' | 'h264' | 'vp9',
      requireHardware: boolean,
    ) =>
      localEncoders.some(
        (capability) =>
          capability.codec === codec &&
          (!requireHardware || capability.encodeHardware),
      );

    const localCodecSet = new Set(
      localEncoders.map((capability) => capability.codec),
    );

    // The host watches their own stream too (the self-view consumes the same
    // bitstream viewers receive), so a codec this client cannot decode would
    // render for everyone EXCEPT the person streaming. Local decode support
    // constrains the choice exactly like a remote viewer's.
    const localDecoderSet = new Set(
      localCapabilities.video
        .filter((capability) => capability.decode)
        .map((capability) => String(capability.codec).toLowerCase()),
    );

    const remoteDecoderSets = participants.map(
      (participant) =>
        new Set(
          participant.videoCapabilities
            .filter((capability) => capability.decode)
            .map((capability) => String(capability.codec).toLowerCase()),
        ),
    );
    const codecPreference: Array<'av1' | 'h264' | 'vp9'> = ['av1', 'h264', 'vp9'];
    for (const requireHardware of [true, false]) {
      for (const codec of codecPreference) {
        if (!hasLocalEncoder(codec, requireHardware) || !localDecoderSet.has(codec)) {
          continue;
        }
        if (remoteDecoderSets.every((supported) => supported.size === 0 || supported.has(codec))) {
          return codec;
        }
      }
    }
    for (const codec of codecPreference) {
      if (localCodecSet.has(codec) && localDecoderSet.has(codec)) {
        return codec;
      }
    }
    return null;
  }

  private async choosePreferredScreenCodec(): Promise<'av1' | 'h264' | 'vp9' | null> {
    const localCapabilities = await this.getStreamCapabilities().catch(() => null);
    if (!localCapabilities) {
      return null;
    }
    const participants =
      this.sessionParticipantCapabilities.size > 0
        ? Array.from(this.sessionParticipantCapabilities.values())
        : await this.listSessionParticipantCapabilities().catch(() => []);
    return this.pickBestCommonCodec(localCapabilities, participants);
  }

  private audioKeyScope(): string {
    return `room:${this.localRoomId ?? 'unknown'}:audio`;
  }

  private trackKeyScope(streamId: string, trackId: string): string {
    return `stream:${streamId}:${trackId}`;
  }

  private async listSessionParticipants(): Promise<string[]> {
    await tauriReady;
    const participants = await invoke('media_list_session_participants');
    return ((participants as string[] | null) ?? []).filter(
      (userId) => userId && userId !== String(this.localUserId ?? ''),
    );
  }

  private async buildWrappedRecipients(
    scope: string,
    senderKey: ExportedSenderKey,
    recipientUserIds: string[],
  ): Promise<Array<{ recipientUserId: string; ciphertext: number[] }>> {
    const wrapped = await wrapSenderKeyForRecipients(
      scope,
      Uint8Array.from(senderKey.rawKey),
      senderKey.epoch,
      recipientUserIds,
    );
    return wrapped.map((entry) => ({
      recipientUserId: entry.recipientUserId,
      ciphertext: Array.from(entry.wrapped),
    }));
  }

  private async announceWrappedAudioSenderKey(
    recipientUserIds?: string[],
  ): Promise<void> {
    const recipients = recipientUserIds ?? (await this.listSessionParticipants());
    if (!recipients.length) {
      return;
    }
    const senderKey = (await invoke('media_export_audio_sender_key')) as ExportedSenderKey;
    const encryptedKeys = await this.buildWrappedRecipients(
      this.audioKeyScope(),
      senderKey,
      recipients,
    );
    if (!encryptedKeys.length) {
      return;
    }
    await invoke('media_send_audio_key_announce', {
      epoch: senderKey.epoch,
      encryptedKeys,
    });
  }

  private async announceWrappedTrackKey(
    track: PublishedTrackDescriptor,
    recipientUserIds?: string[],
  ): Promise<void> {
    const recipients = recipientUserIds ?? (await this.listSessionParticipants());
    if (!recipients.length) {
      return;
    }
    const senderKey = (await invoke('media_export_track_sender_key', {
      streamId: track.streamId,
      trackId: track.trackId,
    })) as ExportedSenderKey;
    const encryptedKeys = await this.buildWrappedRecipients(
      this.trackKeyScope(track.streamId, track.trackId),
      senderKey,
      recipients,
    );
    if (!encryptedKeys.length) {
      return;
    }
    await invoke('media_send_track_key_announce', {
      streamId: track.streamId,
      trackId: track.trackId,
      codec: track.codec ?? null,
      epoch: senderKey.epoch,
      encryptedKeys,
    });
  }

  private async announceWrappedLocalSenderKeys(recipientUserIds?: string[]): Promise<void> {
    const recipients = recipientUserIds ?? (await this.listSessionParticipants());
    if (!recipients.length) {
      return;
    }
    await this.announceWrappedAudioSenderKey(recipients);
    const localUserId = String(this.localUserId ?? '');
    const localTracks = Array.from(this.publishedTracks.values()).filter(
      (track) => String(track.publisherUserId) === localUserId,
    );
    for (const track of localTracks) {
      await this.announceWrappedTrackKey(track, recipients);
    }
  }
}
