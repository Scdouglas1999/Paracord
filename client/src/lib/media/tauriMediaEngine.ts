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
import { MediaVideoDecoder } from './video/videoDecoder';
import { CanvasRenderer } from './video/canvasRenderer';
import { logVoiceDiagnostic } from '../desktopDiagnostics';
import { unwrapDeliveredMediaSenderKey } from './mediaSenderKeyEnvelope';
import type { PulledFrame } from './transport/protocol';
import {
  parseRoomIdFromToken,
  parseUserIdFromToken,
  selectPublishedLayer,
  wrapSenderKeyForRecipients,
} from './engineShared';

// Tauri API imports - these resolve at runtime in the Tauri environment
let invoke: (cmd: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array) => Promise<unknown>;
let listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;

// Dynamic import to avoid bundling issues in browser builds
const tauriReady = (async () => {
  try {
    const core = await import('@tauri-apps/api/core');
    const event = await import('@tauri-apps/api/event');
    invoke = core.invoke;
    listen = event.listen;
  } catch {
    // Not in Tauri environment
  }
})();

type UnlistenFn = () => void;
const VIDEO_POLL_INTERVAL_MS = 16;
const VIDEO_IDLE_POLL_INTERVAL_MS = 250;
const VP9_CODEC = 'vp09.00.10.08';
const H264_CODEC = 'avc1.640028';
const AV1_CODEC = 'av01.0.10M.08';

type PulledEncodedFrameResponse = PulledFrame;

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
    hardwareAccelerated: boolean;
  }>;
};

interface NativeVideoSubscription {
  decoder?: MediaVideoDecoder;
  renderer: CanvasRenderer;
  streamId?: string;
  trackId?: string;
  activeLayer?: number;
  stop: () => void;
}

let nativeStreamCapabilitiesPromise: Promise<MediaStreamCapabilities> | null = null;

async function probeVideoDecoderSupport(
  codec: string,
  opts?: { avcAnnexB?: boolean },
): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
    return false;
  }
  try {
    const config: Record<string, unknown> = {
      codec,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };
    if (opts?.avcAnnexB) {
      config.avc = { format: 'annexb' };
    }
    const support = await VideoDecoder.isConfigSupported(
      config as unknown as Parameters<typeof VideoDecoder.isConfigSupported>[0],
    );
    return Boolean(support?.supported);
  } catch {
    return false;
  }
}

async function mergeNativeAndViewerCapabilities(
  nativeCapabilities: MediaStreamCapabilities,
): Promise<MediaStreamCapabilities> {
  const [vp9Decode, h264Decode, av1Decode] = await Promise.all([
    probeVideoDecoderSupport(VP9_CODEC),
    probeVideoDecoderSupport(H264_CODEC, { avcAnnexB: true }),
    probeVideoDecoderSupport(AV1_CODEC),
  ]);
  const decodeSupport = new Map<string, boolean>([
    ['vp9', vp9Decode],
    ['h264', h264Decode],
    ['av1', av1Decode],
  ]);

  return {
    ...nativeCapabilities,
    video: nativeCapabilities.video.map((capability) => {
      const codec = String(capability.codec).toLowerCase();
      const canDecode = decodeSupport.get(codec);
      if (canDecode == null) {
        return capability;
      }
      return {
        ...capability,
        decode: canDecode,
        hardwareAccelerated:
          capability.hardwareAccelerated || (canDecode && (codec === 'h264' || codec === 'av1')),
      };
    }),
  };
}

function decodeBase64Frame(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
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
 * Poll the native engine for video frames and render them to `renderer`.
 *
 * Natively-decoded frames (`format === 'i420'`) are drawn straight to the
 * canvas via {@link CanvasRenderer.drawI420}, bypassing WebCodecs entirely.
 * Any other frame (including ones with no `format`, i.e. the historical encoded
 * path) is fed to a {@link MediaVideoDecoder}, which is (re)created on codec
 * change. Exported for unit testing of the per-frame render routing.
 */
export function startPulledEncodedVideoSubscription(
  label: string,
  pullFrame: (afterSequence: number | null) => Promise<PulledEncodedFrameResponse | null>,
  decoderRef: { current: MediaVideoDecoder | null; codec: string | null },
  renderer: CanvasRenderer,
  onFrame?: () => void,
  onDecodedFrame?: () => void,
): () => void {
  let stopped = false;
  let lastSequence: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollInFlight = false;
  let sawDecodedFrame = false;
  let pollCount = 0;
  let emptyPollCount = 0;

  const attachDecoder = (decoder: MediaVideoDecoder) => {
    decoder.onDecoded((frame) => {
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

  const scheduleNextPoll = (delayMs = VIDEO_POLL_INTERVAL_MS) => {
    if (stopped) return;
    timer = setTimeout(runPoll, delayMs);
  };

  const renderNativeI420Frame = (
    frame: PulledEncodedFrameResponse & { width: number; height: number },
  ) => {
    const pixels = decodeBase64Frame(frame.dataBase64);
    renderer.drawI420(pixels, frame.width, frame.height);
    if (!sawDecodedFrame) {
      sawDecodedFrame = true;
      logVoiceDiagnostic('[media] native video subscription received first decoded frame', {
        label,
        width: frame.width,
        height: frame.height,
        timestamp: frame.timestampUs,
      });
      onDecodedFrame?.();
    }
    onFrame?.();
  };

  const runPoll = async () => {
    if (stopped || pollInFlight) {
      scheduleNextPoll();
      return;
    }

    pollInFlight = true;
    pollCount += 1;
    if (pollCount <= 3) {
      logVoiceDiagnostic('[media] native encoded video poll start', {
        label,
        pollCount,
        afterSequence: lastSequence,
      });
    }
    try {
      const frame = await pullFrame(lastSequence);
      if (stopped) {
        return;
      }
      if (frame) {
        lastSequence = frame.sequence;
        emptyPollCount = 0;
        if (frame.format === 'i420' && frame.width && frame.height) {
          renderNativeI420Frame(frame as PulledEncodedFrameResponse & { width: number; height: number });
        } else {
          const encoded = decodeBase64Frame(frame.dataBase64);
          if (!decoderRef.current || frame.codec !== decoderRef.codec) {
            decoderRef.current?.close();
            decoderRef.current = new MediaVideoDecoder({ codec: frame.codec });
            decoderRef.codec = frame.codec;
            sawDecodedFrame = false;
            attachDecoder(decoderRef.current);
            logVoiceDiagnostic('[media] native video decoder prepared codec', {
              label,
              codec: frame.codec,
            });
          }
          decoderRef.current.decode(encoded, frame.timestampUs, frame.isKeyframe);
        }
      } else if (emptyPollCount < 5) {
        emptyPollCount += 1;
        logVoiceDiagnostic('[media] native encoded video poll returned no frame', {
          label,
          pollCount,
          afterSequence: lastSequence,
        });
      } else {
        emptyPollCount += 1;
      }
    } catch (err) {
      if (!stopped) {
        logVoiceDiagnostic('[media] native encoded video pull failed', {
          label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      pollInFlight = false;
      scheduleNextPoll(
        emptyPollCount > 0
          ? Math.min(VIDEO_IDLE_POLL_INTERVAL_MS, VIDEO_POLL_INTERVAL_MS * 2 ** Math.min(emptyPollCount, 4))
          : VIDEO_POLL_INTERVAL_MS,
      );
    }
  };

  void runPoll();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
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
  private localUserId: string | null = null;
  private localRoomId: string | null = null;
  private sessionParticipantCapabilities = new Map<string, SessionParticipantCapabilities>();

  // Screen share state for the native desktop capture path
  private screenShareEndedCb: (() => void) | null = null;
  private screenAudioAccumulator: number[] = [];
  private screenAudioActive = false;
  private screenEventUnlisten: UnlistenFn | null = null;
  private transportLostUnlisten: UnlistenFn | null = null;
  private streamAudioUnlisten: UnlistenFn | null = null;
  private transportLostCb: ((reason: string) => void) | null = null;
  private disconnecting = false;

  private screenShareAudioSubscriptions = new Map<
    string,
    {
      playbackContext: AudioContext;
      gainNode: GainNode;
      nextStartTime: number;
    }
  >();

  // Video frame extraction
  private videoStream: MediaStream | null = null;
  private videoFrameLoop: number | null = null;
  private videoSendInFlight = false;

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
    this.stopFrameExtraction();
    this.clearVideoSubscriptions();
    this.clearScreenShareAudioSubscriptions();
    this.cleanupScreenShare();
    this.screenAudioActive = false;
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];
    this.screenEventUnlisten = null;
    this.transportLostUnlisten = null;
    this.streamAudioUnlisten = null;
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

  async enableVideo(enabled: boolean): Promise<void> {
    if (enabled) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
        });
        this.videoStream = stream;
        await invoke('voice_enable_video', { enabled: true });
        this.startVideoFrameExtraction(stream, false);
      } catch (err) {
        console.error('[TauriMediaEngine] camera capture failed:', err);
        throw err instanceof Error ? err : new Error(String(err));
      }
    } else {
      this.stopVideoCapture();
      await invoke('voice_enable_video', { enabled: false });
    }
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

    const targetFps = config.maxFrameRate ?? 30;
    await invoke('screen_share_start', {
      request: {
        sourceId: config.sourceId ?? null,
        maxFrameRate: targetFps,
        maxWidth: config.maxWidth ?? null,
        maxHeight: config.maxHeight ?? null,
        maxBitrateBps: config.maxBitrateBps ?? null,
        contentHint: config.contentHint ?? null,
        preferredCodec: resolvedCodec ?? null,
        captureAudio: config.audio,
      },
    });

    if (config.audio) {
      if (this.usesIntegratedScreenAudio()) {
        this.screenAudioActive = true;
      } else {
        const audioForwardingReady = await this.startScreenAudioForwarding();
        if (!audioForwardingReady) {
          console.warn('[TauriMediaEngine] Native system audio capture unavailable; streaming video-only.');
        }
        this.screenAudioActive = audioForwardingReady;
      }
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
    this.stopScreenAudioForwarding();
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

  private usesIntegratedScreenAudio(): boolean {
    return typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');
  }

  private async startScreenAudioForwarding(): Promise<boolean> {
    this.stopScreenAudioForwarding();

    try {
      const { Channel } = await import('@tauri-apps/api/core');

      // Enable and reset any stale capture session
      await invoke('set_system_audio_capture_enabled', { enabled: true });
      await invoke('stop_system_audio_capture').catch(() => {});

      this.screenAudioAccumulator = [];

      // Receive audio chunks directly from Rust WASAPI capture via Tauri Channel,
      // bypassing AudioWorklet (which WebView2 blocks due to blob URL CSP).
      const channel = new Channel<{ samples: number[]; sample_rate: number }>();
      channel.onmessage = (msg) => {
        // Rust sends interleaved stereo (L, R, L, R, ...) — downmix to mono
        const stereo = msg.samples;
        for (let i = 0; i < stereo.length; i += 2) {
          const l = stereo[i] ?? 0;
          const r = stereo[i + 1] ?? 0;
          this.screenAudioAccumulator.push((l + r) / 2);
        }

        // Flush 960-sample (20ms @ 48kHz) mono frames to Rust for Opus encoding
        while (this.screenAudioAccumulator.length >= 960) {
          const frame = this.screenAudioAccumulator.splice(0, 960);
          invoke('voice_push_screen_audio_frame', { samples: frame }).catch(() => {});
        }
      };

      try {
        await invoke('start_system_audio_capture', { onAudio: channel });
      } catch (startErr) {
        // Retry once for "already running" races from overlapping stop/start
        const errMsg = startErr instanceof Error ? startErr.message : String(startErr);
        if (!errMsg.toLowerCase().includes('already running')) {
          throw startErr;
        }
        await invoke('stop_system_audio_capture').catch(() => {});
        await invoke('start_system_audio_capture', { onAudio: channel });
      }

      await invoke('voice_set_screen_audio_enabled', { enabled: true }).catch(() => {});
      this.screenAudioActive = true;
      console.info('[TauriMediaEngine] Native system audio capture started (direct channel)');
      return true;
    } catch (err) {
      console.warn('[TauriMediaEngine] Failed to start screen audio forwarding:', err);
      this.stopScreenAudioForwarding();
      return false;
    }
  }

  private stopScreenAudioForwarding(): void {
    this.screenAudioAccumulator = [];
    this.screenAudioActive = false;
    if (!invoke) return;
    invoke('stop_system_audio_capture').catch(() => {});
    invoke('set_system_audio_capture_enabled', { enabled: false }).catch(() => {});
    invoke('voice_set_screen_audio_enabled', { enabled: false }).catch(() => {});
  }

  private stopVideoCapture(): void {
    if (this.videoFrameLoop !== null) {
      cancelAnimationFrame(this.videoFrameLoop);
      this.videoFrameLoop = null;
    }
    if (this.videoStream) {
      for (const track of this.videoStream.getTracks()) {
        track.stop();
      }
      this.videoStream = null;
    }
  }

  private stopFrameExtraction(): void {
    this.stopVideoCapture();
  }

  /**
   * Extract RGBA frames from a MediaStream and push them to the Rust side
   * for VP9 encoding and QUIC transport.
   */
  private startVideoFrameExtraction(stream: MediaStream, isScreen: boolean): void {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    const settings = videoTrack.getSettings();
    const width = settings.width ?? 640;
    const height = settings.height ?? 360;

    // Use OffscreenCanvas to extract RGBA pixel data
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Create a video element to render the stream
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.play();

    const command = isScreen ? 'voice_push_screen_frame' : 'voice_push_video_frame';
    const targetInterval = 1000 / (isScreen ? 15 : 30); // fps
    let lastFrameTime = 0;

    const extractFrame = (now: number) => {
      if (now - lastFrameTime < targetInterval) {
        const loopId = requestAnimationFrame(extractFrame);
        this.videoFrameLoop = loopId;
        return;
      }
      lastFrameTime = now;

      // Drop frame if previous send hasn't completed (backpressure)
      const inFlight = this.videoSendInFlight;

      if (!inFlight && video.readyState >= video.HAVE_CURRENT_DATA) {
        ctx.drawImage(video, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        const rgba = new Uint8Array(imageData.data.buffer);

        // Pack width(u32 LE) + height(u32 LE) + RGBA bytes into a single
        // binary buffer.  Tauri v2 sends Uint8Array as
        // application/octet-stream — no JSON serialisation overhead.
        const payload = new Uint8Array(8 + rgba.byteLength);
        const header = new DataView(payload.buffer);
        header.setUint32(0, width, true);
        header.setUint32(4, height, true);
        payload.set(rgba, 8);

        this.videoSendInFlight = true;
        invoke(command, payload)
          .catch(() => { /* VP9 feature may not be enabled; silently skip */ })
          .finally(() => {
            this.videoSendInFlight = false;
          });
      }

      const loopId = requestAnimationFrame(extractFrame);
      this.videoFrameLoop = loopId;
    };

    const loopId = requestAnimationFrame(extractFrame);
    this.videoFrameLoop = loopId;
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

  subscribeScreenShareAudio(userId: string, getVolume: () => number): () => void {
    void tauriReady.then(async () => {
      const playbackContext = new AudioContext({ sampleRate: 48_000 });
      const gainNode = playbackContext.createGain();
      gainNode.gain.value = getVolume();
      gainNode.connect(playbackContext.destination);
      this.screenShareAudioSubscriptions.set(userId, {
        playbackContext,
        gainNode,
        nextStartTime: playbackContext.currentTime,
      });
      const tracks = await this.listPublishedTracks().catch(() => []);
      const audioTrack = tracks.find(
        (track) =>
          String(track.publisherUserId) === userId &&
          track.trackId === 'screen-audio' &&
          track.kind === 'audio',
      );
      if (audioTrack) {
        await this.registerTrackSubscription({
          streamId: audioTrack.streamId,
          trackId: audioTrack.trackId,
          requestedLayer: 0,
        }).catch(() => {});
      }
    });

    const volumeTimer = setInterval(() => {
      const sub = this.screenShareAudioSubscriptions.get(userId);
      if (sub) {
        sub.gainNode.gain.value = getVolume();
      }
    }, 100);

    return () => {
      clearInterval(volumeTimer);
      const sub = this.screenShareAudioSubscriptions.get(userId);
      if (sub) {
        sub.playbackContext.close().catch(() => {});
        this.screenShareAudioSubscriptions.delete(userId);
      }
    };
  }

  private clearScreenShareAudioSubscriptions(): void {
    for (const [, sub] of this.screenShareAudioSubscriptions) {
      sub.playbackContext.close().catch(() => {});
    }
    this.screenShareAudioSubscriptions.clear();
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

    if (!this.streamAudioUnlisten) {
      this.streamAudioUnlisten = await listen('media_stream_audio_pcm', (event) => {
        const payload = event.payload as {
          userId?: string;
          samples?: number[];
        } | null;
        if (!payload?.userId || !Array.isArray(payload.samples) || payload.samples.length === 0) {
          return;
        }
        const sub = this.screenShareAudioSubscriptions.get(payload.userId);
        if (!sub) return;
        const buffer = sub.playbackContext.createBuffer(1, payload.samples.length, 48_000);
        buffer.copyToChannel(Float32Array.from(payload.samples), 0);
        const source = sub.playbackContext.createBufferSource();
        source.buffer = buffer;
        source.connect(sub.gainNode);
        const startAt = Math.max(sub.nextStartTime, sub.playbackContext.currentTime);
        source.start(startAt);
        sub.nextStartTime = startAt + buffer.duration;
      });
      this.unlisteners.push(this.streamAudioUnlisten);
    }

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
      if (!sub.streamId || !sub.trackId) continue;
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

  async registerTrackSubscription(request: TrackSubscriptionRequest): Promise<void> {
    await tauriReady;
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
    await invoke('media_unregister_track_subscription', { streamId, trackId });
  }

  private clearVideoSubscriptions(): void {
    for (const [, sub] of this.videoSubscriptions) {
      sub.stop();
      sub.decoder?.close();
      sub.renderer.destroy();
    }
    this.videoSubscriptions.clear();
  }

  private startEncodedTrackVideoSubscription(
    label: string,
    pullEncodedFrame: (afterSequence: number | null) => Promise<PulledEncodedFrameResponse | null>,
    renderer: CanvasRenderer,
    onFrame?: () => void,
  ): NativeVideoSubscription {
    const decoderRef = {
      current: null as MediaVideoDecoder | null,
      codec: null as string | null,
    };

    const stop = startPulledEncodedVideoSubscription(
      label,
      pullEncodedFrame,
      decoderRef,
      renderer,
      onFrame,
      undefined,
    );

    return {
      renderer,
      stop: () => {
        stop();
        decoderRef.current?.close();
      },
    };
  }

  private async waitForPublishedVideoTrack(
    publisherUserId: string,
    timeoutMs = 10000,
  ): Promise<PublishedTrackDescriptor | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tracks = await this.listPublishedTracks().catch(() => []);
      const publisherTracks = tracks.filter(
        (track) =>
          String(track.publisherUserId) === publisherUserId &&
          track.kind === 'video',
      );
      const match =
        publisherTracks.find((track) => track.trackId === 'screen') ??
        publisherTracks.find((track) => track.trackId === 'camera') ??
        publisherTracks[0] ??
        null;
      if (match) {
        return match;
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, 120);
      });
    }
    return null;
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
      if (String(track.publisherUserId) === String(this.localUserId ?? '')) {
        void this.announceWrappedTrackKey(track).catch(() => {});
      }
      const userId = String(track.publisherUserId);
      const existing = this.videoSubscriptions.get(userId);
      if (!existing) {
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
      void invoke('media_register_stream_video_subscription', {
        streamId: track.streamId,
        trackId: track.trackId,
        ssrc: selectedLayer.ssrc,
      }).catch(() => {});
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

  subscribeVideo(userId: string, canvas: HTMLCanvasElement, onFrame?: () => void): () => void {
    let disposed = false;
    const existing = this.videoSubscriptions.get(userId);
    if (existing) {
      existing.stop();
      existing.renderer.destroy();
      this.videoSubscriptions.delete(userId);
    }

    void tauriReady.then(async () => {
      if (disposed) return;
      try {
        logVoiceDiagnostic('[media] starting native remote video subscription', { userId });
        const renderer = new CanvasRenderer(canvas);
        const publishedTrack = await this.waitForPublishedVideoTrack(userId);
        let subscription: NativeVideoSubscription;
        if (publishedTrack && !disposed) {
          const viewport = rendererCanvasSize(renderer);
          const selectedLayer = selectPublishedLayer(publishedTrack, viewport.width, viewport.height);
        if (selectedLayer) {
          await invoke('media_register_stream_video_subscription', {
            streamId: publishedTrack.streamId,
            trackId: publishedTrack.trackId,
            ssrc: selectedLayer.ssrc,
            });
          }
          await this.registerTrackSubscription({
            streamId: publishedTrack.streamId,
            trackId: publishedTrack.trackId,
            requestedLayer: selectedLayer?.layerId,
            viewport,
          }).catch((error) => {
            logVoiceDiagnostic('[media] failed to register native track subscription', {
              userId,
              streamId: publishedTrack.streamId,
              trackId: publishedTrack.trackId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          subscription = this.startEncodedTrackVideoSubscription(
            `remote:${publishedTrack.streamId}:${publishedTrack.trackId}`,
            (afterSequence) =>
              invoke('media_pull_stream_video_frame', {
                streamId: publishedTrack.streamId,
                trackId: publishedTrack.trackId,
                afterSequence,
              }).then((frame) => (frame as PulledEncodedFrameResponse | null) ?? null),
            renderer,
            onFrame,
          );
          subscription.streamId = publishedTrack.streamId;
          subscription.trackId = publishedTrack.trackId;
          subscription.activeLayer = selectedLayer?.layerId;
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
          const current = this.videoSubscriptions.get(userId);
          if (!current?.streamId || !current.trackId) {
            return;
          }
          const track = this.publishedTracks.get(`${current.streamId}:${current.trackId}`);
          if (!track) {
            return;
          }
          const viewport = rendererCanvasSize(current.renderer);
          const selectedLayer = selectPublishedLayer(track, viewport.width, viewport.height);
          if (!selectedLayer) {
            return;
          }
          if (current.activeLayer === selectedLayer.layerId) {
            return;
          }
          current.activeLayer = selectedLayer.layerId;
          void invoke('media_register_stream_video_subscription', {
            streamId: current.streamId,
            trackId: current.trackId,
            ssrc: selectedLayer.ssrc,
          }).catch(() => {});
          void this.registerTrackSubscription({
            streamId: current.streamId,
            trackId: current.trackId,
            requestedLayer: selectedLayer.layerId,
            viewport,
          }).catch(() => {});
        };
        if (!disposed && typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) {
              clearTimeout(resizeTimer);
            }
            resizeTimer = setTimeout(updateViewportSubscription, 120);
          });
          resizeObserver.observe(canvas);
          const originalStop = subscription.stop;
          subscription.stop = () => {
            if (resizeTimer) {
              clearTimeout(resizeTimer);
            }
            resizeObserver?.disconnect();
            originalStop();
          };
        }
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
        this.videoSubscriptions.set(userId, subscription);
      } catch (err) {
        logVoiceDiagnostic('[media] failed to start native remote video subscription', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return () => {
      disposed = true;
      const current = this.videoSubscriptions.get(userId);
      if (current) {
        if (current.streamId && current.trackId) {
          void this.unregisterTrackSubscription(current.streamId, current.trackId).catch(() => {});
          void invoke('media_unregister_stream_video_subscription', {
            streamId: current.streamId,
            trackId: current.trackId,
          }).catch(() => {});
        }
        current.stop();
        current.decoder?.close();
        current.renderer.destroy();
        this.videoSubscriptions.delete(userId);
      }
    };
  }

  subscribeLocalPublishedScreen(canvas: HTMLCanvasElement, onFrame?: () => void): () => void {
    if (!this.localUserId) {
      return () => {};
    }
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
    const localEncoders = new Set(
      localCapabilities.video
        .filter((capability) => capability.encode)
        .map((capability) => String(capability.codec).toLowerCase()),
    );
    if (!localEncoders.size) {
      return null;
    }

    const remoteDecoderSets = participants.map(
      (participant) =>
        new Set(
          participant.videoCapabilities
            .filter((capability) => capability.decode)
            .map((capability) => String(capability.codec).toLowerCase()),
        ),
    );
    const codecPreference: Array<'av1' | 'h264' | 'vp9'> = ['av1', 'h264', 'vp9'];
    for (const codec of codecPreference) {
      if (!localEncoders.has(codec)) {
        continue;
      }
      if (remoteDecoderSets.every((supported) => supported.size === 0 || supported.has(codec))) {
        return codec;
      }
    }
    for (const codec of codecPreference) {
      if (localEncoders.has(codec)) {
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
