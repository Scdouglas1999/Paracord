import type {
  MediaEngine,
  MediaStreamCapabilities,
  MediaStreamDiagnostics,
  PublishedTrackDescriptor,
  PublishedLayerDescriptor,
  ScreenShareConfig,
  ScreenShareSource,
  ScreenShareThumbnail,
  TrackSubscriptionDescriptor,
  TrackSubscriptionRequest,
} from './mediaEngine';
import { WebTransportManager, type StreamControlMessage } from './transport/webTransport';
import {
  type MediaHeader,
  type VideoFrameMetadata,
  TrackType,
  PROTOCOL_VERSION,
  HEADER_SIZE,
  createPacket,
  decodeHeader,
  encodeHeader,
  encodeVideoFrameMetadata,
  decodeVideoFrameMetadata,
  parsePacket,
} from './transport/protocol';
import { SenderKeyManager } from './senderKeys';
import { OpusMediaEncoder, OpusMediaDecoder } from './audio/opusCodec';
import { JitterBuffer } from './audio/jitterBuffer';
import {
  MediaVideoEncoder,
  SIMULCAST_LAYERS,
  type EncodedVideoChunkWithMeta,
} from './video/videoEncoder';
import { MediaVideoDecoder } from './video/videoDecoder';
import { CanvasRenderer } from './video/canvasRenderer';
import { unwrapDeliveredMediaSenderKey } from './mediaSenderKeyEnvelope';
import {
  codecLabelFromHeader,
  deriveTrackSsrc,
  parseRoomIdFromToken,
  parseUserIdFromToken,
  reassembleVideoPayload,
  selectPublishedLayer,
  wrapSenderKeyForRecipients,
  type ReassembledVideoFrame,
  type VideoReassemblyState,
} from './engineShared';

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const BITRATE = 96_000;
const FRAME_MS = 20;
const VIDEO_MAX_DATAGRAM_SIZE = 1200;
const VIDEO_GCM_TAG_SIZE = 16;

const VP9_CODEC = 'vp09.00.10.08';
const H264_CODEC = 'avc1.640028';
const AV1_CODEC = 'av01.0.10M.08';

/**
 * Mirror of the native `STREAM_FRAGMENT_THRESHOLD`: a video frame is delivered on
 * a reliable unidirectional stream (whole-frame, single AEAD unit) instead of
 * datagram fragments when it is a keyframe or would fragment into more than this
 * many datagrams. Keeping the threshold identical to the native publisher keeps
 * both engines choosing the same transport per frame (§5, contract S5).
 */
export const STREAM_FRAGMENT_THRESHOLD = 48;

/** Mirror of the native `should_send_on_stream`. */
export function shouldSendVideoFrameOnStream(
  isKeyframe: boolean,
  fragmentCount: number,
): boolean {
  return isKeyframe || fragmentCount > STREAM_FRAGMENT_THRESHOLD;
}

/**
 * A whole-frame uni-stream message: cleartext 16-byte header (the relay routes on
 * `ssrc`) + cleartext {@link VideoFrameMetadata} + the still-encrypted whole-frame
 * ciphertext (one AEAD unit, AAD = the 16 header bytes).
 */
export interface StreamFrameMessage {
  header: MediaHeader;
  metadata: VideoFrameMetadata;
  ciphertext: Uint8Array;
}

/**
 * Serialize a whole-frame uni-stream message as `header(16) + metadata +
 * ciphertext`. Byte-for-byte identical to the native `MediaStreamFrame::encode`
 * wire layout, so the relay forwards it unchanged in either direction.
 */
export function buildStreamFrameMessage(
  header: MediaHeader,
  metadata: VideoFrameMetadata,
  ciphertext: Uint8Array,
): Uint8Array {
  const headerBytes = new Uint8Array(encodeHeader(header).buffer);
  const metadataBytes = encodeVideoFrameMetadata(metadata);
  const out = new Uint8Array(
    headerBytes.byteLength + metadataBytes.byteLength + ciphertext.byteLength,
  );
  out.set(headerBytes, 0);
  out.set(metadataBytes, headerBytes.byteLength);
  out.set(ciphertext, headerBytes.byteLength + metadataBytes.byteLength);
  return out;
}

/** Parse a whole-frame uni-stream message; inverse of {@link buildStreamFrameMessage}. */
export function parseStreamFrameMessage(data: Uint8Array): StreamFrameMessage {
  if (data.byteLength < HEADER_SIZE) {
    throw new Error('stream frame message too short for header');
  }
  const header = decodeHeader(new DataView(data.buffer, data.byteOffset, HEADER_SIZE));
  const { metadata, payloadOffset } = decodeVideoFrameMetadata(data.subarray(HEADER_SIZE));
  const ciphertext = data.slice(HEADER_SIZE + payloadOffset);
  return { header, metadata, ciphertext };
}

type MediaStreamTrackProcessorCtor = new (init: { track: MediaStreamTrack }) => {
  readable: ReadableStream<VideoFrame>;
};

interface ParticipantState {
  ssrc: number;
  userId: string;
  decoder: OpusMediaDecoder;
  jitterBuffer: JitterBuffer;
  speaking: boolean;
  audioLevel: number;
  /** Per-source playback gain (voice). Created when the shared playback context exists. */
  gainNode: GainNode | null;
}

/** State for a remote participant's video stream. */
interface VideoSubscription {
  userId: string;
  ssrc: number;
  codec: string;
  decoder: MediaVideoDecoder;
  renderer: CanvasRenderer;
  streamId?: string;
  trackId?: string;
  activeLayer?: number;
}

interface SessionParticipantCapabilities {
  userId: string;
  sessionId: string;
  videoCapabilities: Array<{
    codec: 'vp9' | 'av1' | 'h264' | string;
    encode: boolean;
    decode: boolean;
    // Split per contract C3 (was a single hardwareAccelerated flag).
    encodeHardware: boolean;
    decodeHardware: boolean;
  }>;
}

let browserStreamCapabilitiesPromise: Promise<MediaStreamCapabilities> | null = null;

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

async function probeVideoEncoderSupport(codec: string): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') {
    return false;
  }
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width: 1280,
      height: 720,
      bitrate: 4_000_000,
      framerate: 30,
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
    });
    return Boolean(support?.supported);
  } catch {
    return false;
  }
}

async function detectBrowserStreamCapabilities(): Promise<MediaStreamCapabilities> {
  const [vp9Encode, vp9Decode, h264Encode, h264Decode, av1Encode, av1Decode] =
    await Promise.all([
      probeVideoEncoderSupport(VP9_CODEC),
      probeVideoDecoderSupport(VP9_CODEC),
      probeVideoEncoderSupport(H264_CODEC),
      probeVideoDecoderSupport(H264_CODEC, { avcAnnexB: true }),
      probeVideoEncoderSupport(AV1_CODEC),
      probeVideoDecoderSupport(AV1_CODEC),
    ]);

  return {
    video: [
      // WebCodecs cannot reliably report hardware acceleration, so per contract
      // C3 ("unknown is not hardware") both flags are false for every codec.
      {
        codec: 'vp9',
        backend: 'webcodecs',
        encode: vp9Encode,
        decode: vp9Decode,
        encodeHardware: false,
        decodeHardware: false,
      },
      {
        codec: 'h264',
        backend: 'webcodecs',
        encode: h264Encode,
        decode: h264Decode,
        encodeHardware: false,
        decodeHardware: false,
      },
      {
        codec: 'av1',
        backend: 'webcodecs',
        encode: av1Encode,
        decode: av1Decode,
        encodeHardware: false,
        decodeHardware: false,
      },
    ],
    nativeDesktopRenderer: false,
    browserInteropProtocolV1: true,
    realMediaE2ee: true,
    simulcastV1: true,
  };
}

/**
 * Browser media engine using WebTransport + WebCodecs.
 * Always connects via server relay (browsers can't do P2P QUIC).
 */
export class BrowserMediaEngine implements MediaEngine {
  private transport: WebTransportManager | null = null;
  private senderKeys = new SenderKeyManager();

  // Audio capture
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private encoder: OpusMediaEncoder | null = null;

  // Audio playback
  private playbackContext: AudioContext | null = null;

  // Video capture (camera)
  private videoStream: MediaStream | null = null;
  private videoEncoder: MediaVideoEncoder | null = null;
  private videoFrameCallbackId: number | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private videoEnabled = false;
  private videoSequence = 0;

  // Screen share capture
  private screenStream: MediaStream | null = null;
  private screenEncoder: MediaVideoEncoder | null = null;
  private screenFrameCallbackId: number | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  // Screen share audio capture (separate from voice uplink)
  private screenAudioContext: AudioContext | null = null;
  private screenAudioWorkletNode: AudioWorkletNode | null = null;
  private screenAudioEncoder: OpusMediaEncoder | null = null;
  private screenAudioSequence = 0;
  private screenAudioActive = false;

  // Remote screen-share audio playback (separate from voice)
  private screenAudioSubscriptions = new Map<
    string,
    {
      ssrc: number;
      decoder: OpusMediaDecoder;
      jitterBuffer: JitterBuffer;
      gainNode: GainNode;
      playbackContext: AudioContext;
    }
  >();
  /** Explicit per-source gains from setSourceVolume (0..2). */
  private sourceVolumes = new Map<string, number>();
  private screenSequence = 0;
  private screenShareEndedCb: (() => void) | null = null;

  // Video subscriptions: userId -> subscription
  private videoSubscriptions = new Map<string, VideoSubscription>();
  private publishedTracks = new Map<string, PublishedTrackDescriptor>();
  private videoReassembly = new Map<string, VideoReassemblyState>();
  private pendingTrackKeys = new Map<string, Map<number, Uint8Array>>();
  private sessionParticipantIds = new Set<string>();
  private sessionParticipantCapabilities = new Map<string, SessionParticipantCapabilities>();

  // State
  private localAudioSsrc = 0;
  private localVideoSsrc = 0;
  private localScreenSsrc = 0;
  private localScreenAudioSsrc = 0;
  private localVideoLayerSsrcs = new Map<number, number>();
  private localScreenLayerSsrcs = new Map<number, number>();
  private localUserId: string | null = null;
  private localRoomId: string | null = null;
  private sequence = 0;
  private muted = false;
  private deafened = false;
  private localAudioLevel = 0;

  // Participants
  private participants = new Map<number, ParticipantState>(); // ssrc -> state
  private ssrcToUserId = new Map<number, string>();
  private participantMaterializePromises = new Map<string, Promise<void>>();
  /** Audio packets that arrived before materialize finished for that SSRC. */
  private orphanAudioPackets = new Map<
    number,
    Array<{ header: MediaHeader; payload: Uint8Array; raw: Uint8Array }>
  >();
  private static readonly ORPHAN_AUDIO_LIMIT = 64;

  // Callbacks
  private speakingChangeCb: ((speakers: Map<string, number>) => void) | null = null;
  private participantJoinCb: ((userId: string) => void) | null = null;
  private participantLeaveCb: ((userId: string) => void) | null = null;
  private transportLostCb: ((reason: string) => void) | null = null;
  private disconnecting = false;

  // Playback timer
  private playbackInterval: ReturnType<typeof setInterval> | null = null;

  async connect(endpoint: string, token: string, certHash?: string): Promise<void> {
    // Generate local SSRC
    this.sequence = 0;
    this.localUserId = parseUserIdFromToken(token);
    this.localRoomId = parseRoomIdFromToken(token);
    if (this.localUserId) {
      this.localAudioSsrc = await deriveTrackSsrc(this.localUserId, 'audio');
      this.localVideoSsrc = await deriveTrackSsrc(this.localUserId, 'video');
      this.localScreenSsrc = await deriveTrackSsrc(this.localUserId, 'screen');
      this.localScreenAudioSsrc = await deriveTrackSsrc(this.localUserId, 'screen:audio');
      this.localVideoLayerSsrcs = await this.buildLayerSsrcs(this.localUserId, 'video', this.localVideoSsrc);
      this.localScreenLayerSsrcs = await this.buildLayerSsrcs(this.localUserId, 'screen', this.localScreenSsrc);
    } else {
      this.localAudioSsrc = ((Math.random() * 0xffffffff) >>> 0) || 1;
      this.localVideoSsrc = ((Math.random() * 0xffffffff) >>> 0) || 2;
      this.localScreenSsrc = ((Math.random() * 0xffffffff) >>> 0) || 3;
      this.localScreenAudioSsrc = ((Math.random() * 0xffffffff) >>> 0) || 8;
      this.localVideoLayerSsrcs = new Map([
        [0, ((Math.random() * 0xffffffff) >>> 0) || 4],
        [1, ((Math.random() * 0xffffffff) >>> 0) || 5],
        [2, this.localVideoSsrc],
      ]);
      this.localScreenLayerSsrcs = new Map([
        [0, ((Math.random() * 0xffffffff) >>> 0) || 6],
        [1, ((Math.random() * 0xffffffff) >>> 0) || 7],
        [2, this.localScreenSsrc],
      ]);
    }

    // Generate E2EE sender key
    await this.senderKeys.generateKey();
    await this.syncLocalSenderKeyToDecryptor();

    // Set up WebTransport
    this.transport = new WebTransportManager();

    this.transport.onStreamControl((msg) => this.handleStreamControlMessage(msg));
    this.transport.onDatagram((data) => this.handleDatagram(data));
    this.transport.onUniStream((data) => this.handleVideoStreamFrame(data));
    this.transport.onRestored(() => {
      void this.restoreTransportSession().catch((err) => {
        console.warn('[BrowserMediaEngine] Failed to restore session after reconnect:', err);
      });
    });
    this.transport.onClose((reason) => {
      if (this.disconnecting) return;
      console.warn('[BrowserMediaEngine] Connection closed:', reason);
      this.cleanupAudio();
      this.cleanupVideo();
      this.transportLostCb?.(reason);
    });

    await this.transport.connect(endpoint, token, certHash);

    await this.transport.sendStreamControl({
      type: 'session_join',
      room_id: this.localRoomId ?? '',
      session_id: `browser-${this.localUserId ?? 'unknown'}`,
      video_capabilities: (await this.getStreamCapabilities()).video.map((capability) => ({
        codec: capability.codec,
        encode: capability.encode,
        decode: capability.decode,
        encodeHardware: capability.encodeHardware,
        decodeHardware: capability.decodeHardware,
      })),
    });

    // Set up audio capture pipeline
    await this.setupAudioCapture();

    // Start playback loop
    this.startPlaybackLoop();
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    if (this.transport) {
      await this.transport
        .sendStreamControl({
          type: 'session_leave',
          room_id: this.localRoomId ?? '',
          session_id: `browser-${this.localUserId ?? 'unknown'}`,
        })
        .catch(() => {});
      await this.transport.disconnect();
      this.transport = null;
    }
    this.cleanupAudio();
    this.cleanupVideo();
    this.cleanupScreenShare();
    this.stopPlaybackLoop();

    // Close all participant audio decoders
    for (const [, participant] of this.participants) {
      participant.decoder.close();
    }
    this.participants.clear();
    this.ssrcToUserId.clear();
    this.participantMaterializePromises.clear();
    this.orphanAudioPackets.clear();
    this.publishedTracks.clear();
    this.pendingTrackKeys.clear();
    this.sessionParticipantIds.clear();
    this.sessionParticipantCapabilities.clear();
    this.sourceVolumes.clear();

    // Close all video subscriptions
    for (const [, sub] of this.videoSubscriptions) {
      sub.decoder.close();
      sub.renderer.destroy();
    }
    this.videoSubscriptions.clear();
    this.clearScreenAudioSubscriptions();
    this.transportLostCb = null;
    this.disconnecting = false;
  }

  setMute(muted: boolean): void {
    this.muted = muted;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
  }

  setDeaf(deafened: boolean): void {
    this.deafened = deafened;
    if (deafened) {
      this.setMute(true);
    }
  }

  async enableVideo(enabled: boolean): Promise<void> {
    if (enabled && !this.videoEnabled) {
      this.videoEnabled = true;
      try {
        await this.setupVideoCapture();
      } catch (err) {
        this.videoEnabled = false;
        throw err;
      }
    } else if (!enabled && this.videoEnabled) {
      this.videoEnabled = false;
      this.cleanupVideo();

      if (this.transport) {
        void this.transport.sendStreamControl({
          type: 'track_unpublish',
          stream_id: this.localCameraStreamId(),
          track_id: 'camera',
        }).catch(() => {});
      }
    }
  }

  async startScreenShare(config: ScreenShareConfig): Promise<void> {
    // Stop any existing screen share first
    this.cleanupScreenShare();
    this.screenAudioActive = false;

    const resolvedCodec = config.preferredCodec ?? (await this.choosePreferredPublishCodec());
    const constraints: DisplayMediaStreamOptions = {
      video: {
        frameRate: config.maxFrameRate ?? 30,
        width: { max: config.maxWidth ?? 1920 },
        height: { max: config.maxHeight ?? 1080 },
      },
      audio: config.audio,
    };
    if (config.audio) {
      const hintable = constraints as unknown as Record<string, unknown>;
      hintable.systemAudio = 'include';
      hintable.selfBrowserSurface = 'include';
      hintable.surfaceSwitching = 'include';
    }

    this.screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);

    const videoTracks = this.screenStream.getVideoTracks();
    if (videoTracks.length === 0) {
      this.screenStream = null;
      throw new Error('No video track in screen share stream');
    }

    this.screenTrack = videoTracks[0];

    // Publish screen audio on a dedicated SSRC instead of mixing into voice.
    const audioTracks = this.screenStream.getAudioTracks();
    if (config.audio && audioTracks.length > 0) {
      await this.setupScreenAudioCapture(audioTracks);
      this.screenAudioActive = true;
    }

    // Listen for the user stopping the share via the browser's built-in UI
    this.screenTrack.addEventListener('ended', () => {
      this.cleanupScreenShare();
      this.screenShareEndedCb?.();
    });

    const settings = this.screenTrack.getSettings();
    const width = settings.width ?? 1920;
    const height = settings.height ?? 1080;
    const frameRate = settings.frameRate ?? 30;

    // Create screen share encoder
    this.screenEncoder = new MediaVideoEncoder({
      width,
      height,
      frameRate,
      bitrate: 2_000_000,
      codec: resolvedCodec ?? 'vp9',
    });

    this.screenEncoder.onEncoded((data) => {
      this.sendEncodedVideo(data, this.screenSequence, true);
      this.screenSequence++;
    });

    // Notify the server that screen share has started
    if (this.transport) {
      const track = this.buildLocalScreenTrack(width, height, this.screenEncoder.codec);
      this.publishedTracks.set(this.trackKey(track.streamId, track.trackId), track);
      for (const layer of track.layers) {
        this.ssrcToUserId.set(layer.ssrc, String(track.publisherUserId));
      }
      await this.transport.sendStreamControl({
        type: 'track_publish',
        track,
      }).catch(() => {});
      await this.announceTrackSenderKey(track).catch(() => {});
      if (this.screenAudioActive) {
        const audioTrack = this.buildLocalScreenAudioTrack();
        this.publishedTracks.set(this.trackKey(audioTrack.streamId, audioTrack.trackId), audioTrack);
        this.ssrcToUserId.set(this.localScreenAudioSsrc, String(audioTrack.publisherUserId));
        await this.transport.sendStreamControl({
          type: 'track_publish',
          track: audioTrack,
        }).catch(() => {});
        await this.announceTrackSenderKey(audioTrack).catch(() => {});
      }
    }

    // Start reading frames from the screen share track
    this.startScreenFrameCapture();
  }

  async stopScreenShare(): Promise<void> {
    this.cleanupScreenShare();

    if (this.transport) {
      this.publishedTracks.delete(this.trackKey(this.localScreenStreamId(), 'screen'));
      this.publishedTracks.delete(this.trackKey(this.localScreenStreamId(), 'screen-audio'));
      void this.transport.sendStreamControl({
        type: 'track_unpublish',
        stream_id: this.localScreenStreamId(),
        track_id: 'screen',
      }).catch(() => {});
      void this.transport.sendStreamControl({
        type: 'track_unpublish',
        stream_id: this.localScreenStreamId(),
        track_id: 'screen-audio',
      }).catch(() => {});
    }
  }

  supportsNativeSourcePicker(): boolean {
    return false;
  }

  async listScreenShareSources(): Promise<ScreenShareSource[]> {
    return [];
  }

  async getScreenShareSourceThumbnail(_sourceId: string): Promise<ScreenShareThumbnail | null> {
    return null;
  }

  isScreenShareAudioActive(): boolean {
    return this.screenAudioActive;
  }

  onScreenShareEnded(cb: () => void): void {
    this.screenShareEndedCb = cb;
  }

  onSpeakingChange(cb: (speakers: Map<string, number>) => void): void {
    this.speakingChangeCb = cb;
  }

  onParticipantJoin(cb: (userId: string) => void): void {
    this.participantJoinCb = cb;
  }

  onParticipantLeave(cb: (userId: string) => void): void {
    this.participantLeaveCb = cb;
  }

  onTransportLost(cb: (reason: string) => void): void {
    this.transportLostCb = cb;
  }

  /**
   * Set per-source playback gain (0..2) for screen-share audio and remote voice.
   * Mirrors TauriMediaEngine → voice_set_source_volume so StreamViewer volume
   * works on both engines.
   */
  setSourceVolume(userId: string, gain: number): void {
    const clamped = Math.min(2, Math.max(0, gain));
    this.sourceVolumes.set(userId, clamped);

    const screenSub = this.screenAudioSubscriptions.get(userId);
    if (screenSub) {
      screenSub.gainNode.gain.value = clamped;
    }

    for (const participant of this.participants.values()) {
      if (participant.userId === userId && participant.gainNode) {
        participant.gainNode.gain.value = clamped;
      }
    }
  }

  subscribeScreenShareAudio(userId: string, getVolume: () => number): () => void {
    const existing = this.screenAudioSubscriptions.get(userId);
    if (existing) {
      existing.playbackContext.close().catch(() => {});
      this.screenAudioSubscriptions.delete(userId);
    }

    const playbackContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const gainNode = playbackContext.createGain();
    const initialGain = this.sourceVolumes.get(userId) ?? getVolume();
    gainNode.gain.value = Math.min(2, Math.max(0, initialGain));
    gainNode.connect(playbackContext.destination);

    const publishedTrack = this.findPublishedScreenAudioTrack(userId);
    // Prefer the published layer SSRC; fall back to the deterministic SHA-256
    // derivation so decrypt keys and datagram routing agree before publish arrives.
    const publishedSsrc = publishedTrack?.layers[0]?.ssrc ?? 0;

    const decoder = new OpusMediaDecoder({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    decoder.onDecoded((audioData) => {
      const channelData = new Float32Array(audioData.numberOfFrames);
      audioData.copyTo(channelData, { planeIndex: 0, format: 'f32' });
      const buffer = playbackContext.createBuffer(1, channelData.length, SAMPLE_RATE);
      buffer.copyToChannel(channelData, 0);
      const source = playbackContext.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);
      source.start();
      audioData.close();
    });
    const jitterBuffer = new JitterBuffer(FRAME_MS, 60);

    this.screenAudioSubscriptions.set(userId, {
      ssrc: publishedSsrc,
      decoder,
      jitterBuffer,
      gainNode,
      playbackContext,
    });

    void deriveTrackSsrc(userId, 'screen:audio').then((derived) => {
      const sub = this.screenAudioSubscriptions.get(userId);
      if (!sub) return;
      // Keep a published layer SSRC when present; otherwise pin the derived value
      // so findScreenAudioUserIdForSsrc can match packets before track_publish.
      if (sub.ssrc === 0 || !publishedTrack) {
        sub.ssrc = publishedTrack?.layers[0]?.ssrc ?? derived;
      }
    });

    if (publishedTrack) {
      void this.registerTrackSubscription({
        streamId: publishedTrack.streamId,
        trackId: publishedTrack.trackId,
        requestedLayer: 0,
      }).catch(() => {});
      void this.applyDeliveredTrackKeys(publishedTrack);
    }

    // Initial gain applied above; StreamViewer drives later changes via
    // setSourceVolume — no 100ms poll.

    return () => {
      const sub = this.screenAudioSubscriptions.get(userId);
      if (!sub) return;
      const track = this.findPublishedScreenAudioTrack(userId);
      if (track) {
        void this.unregisterTrackSubscription(track.streamId, track.trackId).catch(() => {});
      }
      sub.decoder.close();
      sub.playbackContext.close().catch(() => {});
      this.screenAudioSubscriptions.delete(userId);
    };
  }

  async getStreamCapabilities(): Promise<MediaStreamCapabilities> {
    if (!browserStreamCapabilitiesPromise) {
      browserStreamCapabilitiesPromise = detectBrowserStreamCapabilities();
    }
    return browserStreamCapabilitiesPromise;
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
        if (!hasLocalEncoder(codec, requireHardware)) continue;
        if (remoteDecoderSets.every((supported) => supported.size === 0 || supported.has(codec))) {
          return codec;
        }
      }
    }
    for (const codec of codecPreference) {
      if (localCodecSet.has(codec)) return codec;
    }
    return null;
  }

  private async choosePreferredPublishCodec(): Promise<'av1' | 'h264' | 'vp9' | null> {
    const localCapabilities = await this.getStreamCapabilities();
    const participants = Array.from(this.sessionParticipantCapabilities.values());
    return this.pickBestCommonCodec(localCapabilities, participants);
  }

  private stopCaptureLoopOnly(
    track: MediaStreamTrack | null,
    callbackId: number | null,
    setCallbackId: (id: number | null) => void,
  ): void {
    if (callbackId !== null) {
      cancelAnimationFrame(callbackId);
      setCallbackId(null);
    }
    if (track) {
      const cleanup = (track as unknown as Record<string, (() => void) | undefined>).__paracordCleanup;
      if (cleanup) {
        cleanup();
        delete (track as unknown as Record<string, unknown>).__paracordCleanup;
      }
    }
  }

  private async republishLocalTrack(track: PublishedTrackDescriptor): Promise<void> {
    if (!this.transport) {
      return;
    }
    this.publishedTracks.set(this.trackKey(track.streamId, track.trackId), track);
    for (const layer of track.layers) {
      this.ssrcToUserId.set(layer.ssrc, String(track.publisherUserId));
    }
    await this.transport.sendStreamControl({
      type: 'track_publish',
      track,
    }).catch(() => {});
    await this.announceTrackSenderKey(track).catch(() => {});
  }

  private async reconcileActivePublishCodecs(): Promise<void> {
    const preferredCodec = await this.choosePreferredPublishCodec();

    if (this.videoTrack && this.videoEncoder && preferredCodec && this.videoEncoder.codec !== preferredCodec) {
      const settings = this.videoTrack.getSettings();
      const width = settings.width ?? 1280;
      const height = settings.height ?? 720;
      const frameRate = settings.frameRate ?? 30;

      this.stopCaptureLoopOnly(this.videoTrack, this.videoFrameCallbackId, (id) => {
        this.videoFrameCallbackId = id;
      });
      this.videoEncoder.close();
      this.videoEncoder = new MediaVideoEncoder({
        width,
        height,
        frameRate,
        bitrate: 1_500_000,
        codec: preferredCodec,
      });
      this.videoEncoder.onEncoded((data) => {
        this.sendEncodedVideo(data, this.videoSequence, false);
        this.videoSequence++;
      });
      this.startVideoFrameCapture();
      await this.republishLocalTrack(this.buildLocalCameraTrack(width, height, this.videoEncoder.codec));
    }

    if (this.screenTrack && this.screenEncoder && preferredCodec && this.screenEncoder.codec !== preferredCodec) {
      const settings = this.screenTrack.getSettings();
      const width = settings.width ?? 1920;
      const height = settings.height ?? 1080;
      const frameRate = settings.frameRate ?? 30;

      this.stopCaptureLoopOnly(this.screenTrack, this.screenFrameCallbackId, (id) => {
        this.screenFrameCallbackId = id;
      });
      this.screenEncoder.close();
      this.screenEncoder = new MediaVideoEncoder({
        width,
        height,
        frameRate,
        bitrate: 2_000_000,
        codec: preferredCodec,
      });
      this.screenEncoder.onEncoded((data) => {
        this.sendEncodedVideo(data, this.screenSequence, true);
        this.screenSequence++;
      });
      this.startScreenFrameCapture();
      await this.republishLocalTrack(this.buildLocalScreenTrack(width, height, this.screenEncoder.codec));
    }
  }

  async getStreamingDiagnostics(): Promise<MediaStreamDiagnostics> {
    const preferredCommonCodec = await this.choosePreferredPublishCodec().catch(() => null);
    const localUserId = String(this.localUserId ?? '');
    const localTracks = Array.from(this.publishedTracks.values()).filter(
      (track) => String(track.publisherUserId) === localUserId,
    );
    const cameraTrack =
      localTracks.find((track) => track.trackId === 'camera') ??
      localTracks.find((track) => track.streamId === this.localCameraStreamId());
    const screenTrack =
      localTracks.find((track) => track.trackId === 'screen') ??
      localTracks.find((track) => track.streamId === this.localScreenStreamId());
    const subscriptions: TrackSubscriptionDescriptor[] = Array.from(this.videoSubscriptions.values())
      .filter((sub) => sub.streamId && sub.trackId)
      .map((sub) => ({
        streamId: sub.streamId!,
        trackId: sub.trackId!,
        requestedLayer: sub.activeLayer ?? null,
        activeLayer: sub.activeLayer ?? null,
        viewport: sub.renderer.canvasElement
          ? {
              width: Math.max(
                1,
                Math.round((sub.renderer.canvasElement.clientWidth || sub.renderer.canvasElement.width || 1) * (window.devicePixelRatio || 1)),
              ),
              height: Math.max(
                1,
                Math.round((sub.renderer.canvasElement.clientHeight || sub.renderer.canvasElement.height || 1) * (window.devicePixelRatio || 1)),
              ),
            }
          : null,
      }));

    return {
      connected: this.transport?.isConnected ?? false,
      sessionId: this.localUserId ? `browser-${this.localUserId}` : null,
      roomId: this.localRoomId,
      participantCount: this.sessionParticipantIds.size,
      participants: Array.from(this.sessionParticipantCapabilities.values()).map((participant) => ({
        userId: participant.userId,
        sessionId: participant.sessionId,
        videoCapabilities: participant.videoCapabilities.map((capability) => ({
          codec: capability.codec,
          backend: 'session',
          encode: capability.encode,
          decode: capability.decode,
          encodeHardware: capability.encodeHardware,
          decodeHardware: capability.decodeHardware,
        })),
      })),
      localPublishCodecs: {
        preferredCommonCodec,
        cameraCodec: cameraTrack?.codec ?? null,
        screenCodec: screenTrack?.codec ?? null,
      },
      publishedTracks: Array.from(this.publishedTracks.values()),
      subscriptions,
      capabilities: await this.getStreamCapabilities(),
    };
  }

  async listPublishedTracks(): Promise<PublishedTrackDescriptor[]> {
    return Array.from(this.publishedTracks.values());
  }

  async registerTrackSubscription(request: TrackSubscriptionRequest): Promise<void> {
    if (!this.transport) return;
    const track = this.publishedTracks.get(this.trackKey(request.streamId, request.trackId));
    const estimatedBitrateKbps = this.estimateTrackBitrateKbps(
      track,
      request.activeLayer ?? request.requestedLayer ?? null,
    );
    await this.transport.sendStreamControl({
      type: 'subscribe_stream',
      subscription: {
        stream_id: request.streamId,
        track_id: request.trackId,
        requested_layer: request.requestedLayer ?? null,
        active_layer: request.activeLayer ?? null,
        viewport: request.viewport
          ? { width: request.viewport.width, height: request.viewport.height }
          : null,
      },
    });
    await this.transport.sendStreamControl({
      type: 'receiver_report',
      stream_id: request.streamId,
      track_id: request.trackId,
      active_layer: request.activeLayer ?? request.requestedLayer ?? null,
      viewport: request.viewport
        ? { width: request.viewport.width, height: request.viewport.height }
        : null,
      estimated_bitrate_kbps: estimatedBitrateKbps,
      packet_loss_ppm: 0,
    });
  }

  async unregisterTrackSubscription(streamId: string, trackId: string): Promise<void> {
    if (!this.transport) return;
    await this.transport.sendStreamControl({
      type: 'unsubscribe_stream',
      stream_id: streamId,
      track_id: trackId,
    });
  }

  /**
   * Subscribe to a remote participant's video and render it onto a canvas.
   * Creates a decoder and renderer for the given user. If a subscription
   * already exists for this user, the old one is torn down first.
   */
  subscribeVideo(
    userId: string,
    canvas: HTMLCanvasElement,
    onFrame?: () => void,
    options?: { preferredTrackId?: 'camera' | 'screen' },
  ): () => void {
    const preferredTrackId = options?.preferredTrackId;
    const subscriptionKey = preferredTrackId ? `${userId}:${preferredTrackId}` : userId;
    // Tear down any existing subscription for this key
    const existing = this.videoSubscriptions.get(subscriptionKey);
    if (existing) {
      existing.decoder.close();
      existing.renderer.destroy();
      this.videoSubscriptions.delete(subscriptionKey);
    }

    // Resolve the SSRC for this user
    const publishedTrack = this.findPreferredPublishedVideoTrack(userId, preferredTrackId);
    const viewport = {
      width: Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * (window.devicePixelRatio || 1))),
      height: Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * (window.devicePixelRatio || 1))),
    };
    const selectedLayer = publishedTrack
      ? selectPublishedLayer(publishedTrack, viewport.width, viewport.height)
      : null;
    // Prefer the published track's layer SSRC over any placeholder audio SSRC
    // that may already be mapped for this user.
    let ssrc = selectedLayer?.ssrc ?? publishedTrack?.layers[0]?.ssrc ?? 0;
    if (ssrc === 0) {
      for (const [s, uid] of this.ssrcToUserId) {
        if (uid === userId) {
          ssrc = s;
          break;
        }
      }
    }

    const decoder = new MediaVideoDecoder({
      codec: this.decoderCodecForTrack(publishedTrack),
    });
    const renderer = new CanvasRenderer(canvas);

    // Wire decoder output to the renderer
    decoder.onDecoded((frame) => {
      renderer.renderFrame(frame);
      onFrame?.();
    });

    const subscription: VideoSubscription = {
      userId,
      ssrc,
      codec: this.decoderCodecForTrack(publishedTrack),
      decoder,
      renderer,
      streamId: publishedTrack?.streamId,
      trackId: publishedTrack?.trackId,
      activeLayer: selectedLayer?.layerId,
    };

    this.videoSubscriptions.set(subscriptionKey, subscription);

    if (publishedTrack) {
      void this.registerTrackSubscription({
        streamId: publishedTrack.streamId,
        trackId: publishedTrack.trackId,
        requestedLayer: selectedLayer?.layerId,
        viewport,
      }).catch(() => {});
    }

    const updateViewportSubscription = () => {
      const current = this.videoSubscriptions.get(subscriptionKey);
      if (!current?.streamId || !current.trackId) {
        return;
      }
      const track = this.publishedTracks.get(this.trackKey(current.streamId, current.trackId));
      if (!track) {
        return;
      }
      const nextViewport = {
        width: Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * (window.devicePixelRatio || 1))),
        height: Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * (window.devicePixelRatio || 1))),
      };
      const nextLayer = selectPublishedLayer(track, nextViewport.width, nextViewport.height);
      const nextLayerId = nextLayer?.layerId;
      if (current.activeLayer === nextLayerId && current.ssrc === (nextLayer?.ssrc ?? current.ssrc)) {
        return;
      }
      current.activeLayer = nextLayerId;
      current.ssrc = nextLayer?.ssrc ?? current.ssrc;
      void this.registerTrackSubscription({
        streamId: current.streamId,
        trackId: current.trackId,
        requestedLayer: nextLayerId,
        viewport: nextViewport,
      }).catch(() => {});
      if (this.transport) {
        void this.transport.sendStreamControl({
          type: 'request_keyframe',
          stream_id: current.streamId,
          track_id: current.trackId,
          layer_id: nextLayerId ?? null,
        }).catch(() => {});
      }
    };

    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) {
          clearTimeout(resizeTimer);
        }
        resizeTimer = setTimeout(updateViewportSubscription, 120);
      });
      resizeObserver.observe(canvas);
    }

    // Mirror Tauri attachStreamVisibilityControls: pause canvas paint when the
    // tab is hidden or the tile is fully off-screen. Decode still runs (no
    // browser-side decode-pause API); this only skips rAF paint work.
    let intersectionVisible = true;
    let renderingEnabled = true;
    const applyVisibility = () => {
      const docVisible =
        typeof document === 'undefined' || document.visibilityState !== 'hidden';
      const next = docVisible && intersectionVisible;
      if (next === renderingEnabled) return;
      renderingEnabled = next;
      renderer.setRenderingEnabled(next);
    };
    const onDocVisibility = () => applyVisibility();
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
      document.addEventListener('visibilitychange', onDocVisibility);
    }

    // Request a keyframe from this participant so we can start decoding immediately.
    if (this.transport && ssrc !== 0) {
      if (publishedTrack) {
        void this.transport.sendStreamControl({
          type: 'request_keyframe',
          stream_id: publishedTrack.streamId,
          track_id: publishedTrack.trackId,
          layer_id: selectedLayer?.layerId ?? null,
        }).catch(() => {});
      }
    }

    return () => {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onDocVisibility);
      }
      renderer.setRenderingEnabled(true);
      const current = this.videoSubscriptions.get(subscriptionKey);
      if (!current) return;
      if (current.streamId && current.trackId) {
        void this.unregisterTrackSubscription(current.streamId, current.trackId).catch(() => {});
      }
      current.decoder.close();
      current.renderer.destroy();
      this.videoSubscriptions.delete(subscriptionKey);
    };
  }

  subscribeLocalPublishedScreen(canvas: HTMLCanvasElement, onFrame?: () => void): () => void {
    const localUserId = this.localUserId ?? '';
    if (!localUserId) {
      return () => {};
    }
    return this.subscribeVideo(localUserId, canvas, onFrame);
  }

  // ---------- Audio capture pipeline (unchanged) ----------

  private async setupAudioCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: CHANNELS,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Load the AudioWorklet processor
    const processorUrl = new URL('./audio/audioProcessor.ts', import.meta.url).href;
    await this.audioContext.audioWorklet.addModule(processorUrl);

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'media-audio-processor');

    this.workletNode.port.onmessage = (event) => {
      if (event.data.type === 'frame') {
        this.localAudioLevel = event.data.audioLevel;
        if (!this.muted) {
          this.encodeAndSend(event.data.samples, event.data.audioLevel);
        }
      }
    };

    source.connect(this.workletNode);
    // Don't connect to destination - we don't want to hear ourselves
    this.workletNode.connect(this.audioContext.destination);

    // Set up Opus encoder
    this.encoder = new OpusMediaEncoder({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitrate: BITRATE,
    });

    this.encoder.onEncoded((chunk) => {
      this.sendEncodedAudio(chunk);
    });

    // Set up playback context
    this.playbackContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  }

  private encodeAndSend(samples: Float32Array, _audioLevel: number): void {
    if (!this.encoder) return;
    const timestamp = this.sequence * FRAME_MS * 1000; // microseconds
    this.encoder.encode(samples, timestamp);
  }

  private async sendEncodedAudio(chunk: EncodedAudioChunk): Promise<void> {
    if (!this.transport) return;

    // Extract encoded data
    const encodedData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(encodedData);

    const header: MediaHeader = {
      version: PROTOCOL_VERSION,
      trackType: TrackType.Audio,
      simulcastLayer: 0,
      sequence: this.sequence & 0xffff,
      timestamp: (chunk.timestamp / 1000) >>> 0, // ms to 32-bit timestamp
      ssrc: this.localAudioSsrc,
      audioLevel: this.localAudioLevel,
      keyEpoch: this.senderKeys.currentEpoch,
      payloadLength: 0, // will be set by createPacket
      codec: 0,
    };

    // Encode header for AAD (encrypt uses header as additional authenticated data)
    const headerAAD = createPacket(header, new Uint8Array(0)).slice(0, HEADER_SIZE);

    const encrypted = await this.senderKeys.encrypt(
        headerAAD,
        encodedData,
        this.senderKeys.currentEpoch,
        this.sequence & 0xffff,
        this.localAudioSsrc,
      );

    const packet = createPacket(header, encrypted);
    this.transport.sendDatagram(packet);

    this.sequence++;
  }

  // ---------- Video capture pipeline ----------

  private async setupVideoCapture(): Promise<void> {
    this.videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });

    const videoTracks = this.videoStream.getVideoTracks();
    if (videoTracks.length === 0) {
      this.videoStream = null;
      throw new Error('No video track available from camera');
    }

    this.videoTrack = videoTracks[0];
    const settings = this.videoTrack.getSettings();
    const width = settings.width ?? 1280;
    const height = settings.height ?? 720;
    const frameRate = settings.frameRate ?? 30;
    const preferredCodec = await this.choosePreferredPublishCodec();

    // Create the simulcast video encoder
    this.videoEncoder = new MediaVideoEncoder({
      width,
      height,
      frameRate,
      bitrate: 1_500_000,
      codec: preferredCodec ?? 'vp9',
    });

    this.videoEncoder.onEncoded((data) => {
      this.sendEncodedVideo(data, this.videoSequence, false);
      this.videoSequence++;
    });

    // Notify the server that video is enabled
    if (this.transport) {
      const track = this.buildLocalCameraTrack(width, height, this.videoEncoder.codec);
      this.publishedTracks.set(this.trackKey(track.streamId, track.trackId), track);
      for (const layer of track.layers) {
        this.ssrcToUserId.set(layer.ssrc, String(track.publisherUserId));
      }
      await this.transport.sendStreamControl({
        type: 'track_publish',
        track,
      }).catch(() => {});
      await this.announceTrackSenderKey(track).catch(() => {});
    }

    // Start reading frames from the video track
    this.startVideoFrameCapture();
  }

  /**
   * Reads frames from the camera video track using the MediaStreamTrackProcessor API.
   * Falls back to a canvas-based capture loop if MediaStreamTrackProcessor is not available.
   */
  private startVideoFrameCapture(): void {
    if (!this.videoTrack || !this.videoEncoder) return;

    // Use MediaStreamTrackProcessor if available (Chromium 94+).
    if ('MediaStreamTrackProcessor' in globalThis) {
      this.startTrackProcessorCapture(
        this.videoTrack,
        this.videoEncoder,
        (id) => { this.videoFrameCallbackId = id; },
      );
    } else {
      this.startCanvasCapture(
        this.videoTrack,
        this.videoEncoder,
        (id) => { this.videoFrameCallbackId = id; },
      );
    }
  }

  private startScreenFrameCapture(): void {
    if (!this.screenTrack || !this.screenEncoder) return;

    if ('MediaStreamTrackProcessor' in globalThis) {
      this.startTrackProcessorCapture(
        this.screenTrack,
        this.screenEncoder,
        (id) => { this.screenFrameCallbackId = id; },
      );
    } else {
      this.startCanvasCapture(
        this.screenTrack,
        this.screenEncoder,
        (id) => { this.screenFrameCallbackId = id; },
      );
    }
  }

  /**
   * High-efficiency frame capture using MediaStreamTrackProcessor.
   * This API yields VideoFrame objects directly from the track,
   * avoiding the overhead of canvas-based capture.
   */
  private startTrackProcessorCapture(
    track: MediaStreamTrack,
    videoEncoder: MediaVideoEncoder,
    setCallbackId: (id: number | null) => void,
  ): void {
    const Processor = (globalThis as { MediaStreamTrackProcessor?: MediaStreamTrackProcessorCtor })
      .MediaStreamTrackProcessor;
    if (!Processor) return;
    const processor = new Processor({ track });
    const reader: ReadableStreamDefaultReader<VideoFrame> = processor.readable.getReader();

    let active = true;

    const readLoop = async (): Promise<void> => {
      try {
        while (active) {
          const { value: frame, done } = await reader.read();
          if (done || !active) {
            frame?.close();
            break;
          }

          try {
            videoEncoder.encode(frame);
          } finally {
            frame.close();
          }
        }
      } catch {
        // Track ended or reader cancelled.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Already released.
        }
      }
    };

    readLoop();

    // Use a sentinel value to track this capture session.
    // Store a cleanup handle via requestAnimationFrame so we can cancel later.
    const sentinel = requestAnimationFrame(() => {
      // no-op; this just gives us a numeric handle
    });
    setCallbackId(sentinel);

    // Patch the cleanup to also stop the reader.
    const originalActive = active;
    if (originalActive) {
      // Store a reference so cleanup can stop the reader.
      const cleanup = (): void => {
        active = false;
        try {
          reader.cancel();
        } catch {
          // Already cancelled.
        }
      };

      // Attach cleanup to the track itself for retrieval during teardown.
      (track as unknown as Record<string, () => void>).__paracordCleanup = cleanup;
    }
  }

  /**
   * Fallback canvas-based frame capture for browsers without MediaStreamTrackProcessor.
   * Draws video frames to an OffscreenCanvas at the track's native frame rate.
   */
  private startCanvasCapture(
    track: MediaStreamTrack,
    videoEncoder: MediaVideoEncoder,
    setCallbackId: (id: number | null) => void,
  ): void {
    const settings = track.getSettings();
    const width = settings.width ?? 640;
    const height = settings.height ?? 360;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Create a video element to display the track
    const video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    video.muted = true;
    video.playsInline = true;
    video.play();

    let active = true;
    const targetFps = Math.max(1, settings.frameRate ?? 30);
    const targetInterval = 1000 / targetFps;
    let lastFrameTime = 0;

    const captureLoop = (now: number): void => {
      if (!active || track.readyState !== 'live') return;

      if (now - lastFrameTime < targetInterval) {
        const id = requestAnimationFrame(captureLoop);
        setCallbackId(id);
        return;
      }
      lastFrameTime = now;

      ctx.drawImage(video, 0, 0, width, height);
      const frame = new VideoFrame(canvas, {
        timestamp: performance.now() * 1000, // microseconds
      });

      try {
        videoEncoder.encode(frame);
      } finally {
        frame.close();
      }

      const id = requestAnimationFrame(captureLoop);
      setCallbackId(id);
    };

    const id = requestAnimationFrame(captureLoop);
    setCallbackId(id);

    (track as unknown as Record<string, () => void>).__paracordCleanup = () => {
      active = false;
      video.pause();
      video.srcObject = null;
    };
  }

  /**
   * Send an encoded video chunk over the transport with E2EE.
   */
  private async sendEncodedVideo(
    data: EncodedVideoChunkWithMeta,
    seq: number,
    _isScreenShare: boolean,
  ): Promise<void> {
    if (!this.transport) return;

    const { chunk, layerIndex } = data;

    // Extract the encoded data from the chunk
    const encodedData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(encodedData);

    const maxFragmentPayload =
      VIDEO_MAX_DATAGRAM_SIZE - HEADER_SIZE - VIDEO_GCM_TAG_SIZE - 128;
    const fragmentCount = Math.max(1, Math.ceil(encodedData.byteLength / maxFragmentPayload));
    const timestamp = (chunk.timestamp / 1000) >>> 0;
    const metadataBase = this.buildLocalVideoMetadata(seq, _isScreenShare, data);
    const senderSsrc = _isScreenShare
      ? this.localScreenLayerSsrcs.get(layerIndex) ?? this.localScreenSsrc
      : this.localVideoLayerSsrcs.get(layerIndex) ?? this.localVideoSsrc;

    // Keyframes and any frame too large to survive datagram fragmentation ride a
    // reliable unidirectional stream instead (§5), mirroring the native
    // `should_send_on_stream` rule. Same wire framing, so the relay bridges it
    // byte-for-byte to native and bridged viewers alike.
    if (shouldSendVideoFrameOnStream(metadataBase.isKeyframe, fragmentCount)) {
      await this.sendVideoFrameOnStream(encodedData, {
        seq,
        timestamp,
        layerIndex,
        senderSsrc,
        metadataBase,
      });
      return;
    }

    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
      const start = fragmentIndex * maxFragmentPayload;
      const end = Math.min(encodedData.byteLength, start + maxFragmentPayload);
      const fragment = encodedData.slice(start, end);
      const metadataBytes = encodeVideoFrameMetadata({
        ...metadataBase,
        fragmentIndex,
        fragmentCount,
      });
      const header: MediaHeader = {
        version: PROTOCOL_VERSION,
        trackType: TrackType.Video,
        simulcastLayer: layerIndex,
        sequence: (seq + fragmentIndex) & 0xffff,
        timestamp,
        ssrc: senderSsrc,
        audioLevel: 127,
        keyEpoch: this.senderKeys.currentEpoch,
        payloadLength: 0,
        codec: metadataBase.codec,
      };
      const fragmentPayload = new Uint8Array(metadataBytes.byteLength + fragment.byteLength);
      fragmentPayload.set(metadataBytes, 0);
      fragmentPayload.set(fragment, metadataBytes.byteLength);

      const headerAAD = createPacket(header, new Uint8Array(0)).slice(0, HEADER_SIZE);
      const encrypted = await this.senderKeys.encrypt(
        headerAAD,
        fragmentPayload,
        this.senderKeys.currentEpoch,
        header.sequence,
        senderSsrc,
      );

      const packet = createPacket(header, encrypted);
      this.transport.sendDatagram(packet);
    }
  }

  /**
   * Publish one whole encoded frame on a reliable unidirectional stream (§5).
   * The entire frame is encrypted as a single AEAD unit — the 16-byte header is
   * the AAD and the nonce derives from `(ssrc, epoch, sequence)` exactly as the
   * datagram path — then wrapped in the native uni-stream framing (`header +
   * metadata + ciphertext`) and written to a fresh WebTransport uni stream. One
   * sequence number is consumed, so the nonce never collides with a datagram
   * fragment's, and `payloadLength` stays 0 (the stream FIN delimits the frame).
   */
  private async sendVideoFrameOnStream(
    encodedData: Uint8Array,
    opts: {
      seq: number;
      timestamp: number;
      layerIndex: number;
      senderSsrc: number;
      metadataBase: Omit<VideoFrameMetadata, 'fragmentIndex' | 'fragmentCount'>;
    },
  ): Promise<void> {
    if (!this.transport) return;
    const { seq, timestamp, layerIndex, senderSsrc, metadataBase } = opts;

    const header: MediaHeader = {
      version: PROTOCOL_VERSION,
      trackType: TrackType.Video,
      simulcastLayer: layerIndex,
      sequence: seq & 0xffff,
      timestamp,
      ssrc: senderSsrc,
      audioLevel: 127,
      keyEpoch: this.senderKeys.currentEpoch,
      payloadLength: 0,
      codec: metadataBase.codec,
    };

    // The AAD is the exact 16 wire header bytes (payloadLength 0), so it is
    // byte-identical to what the receiver reads off the stream and rebinds.
    const headerAAD = createPacket(header, new Uint8Array(0)).slice(0, HEADER_SIZE);
    const ciphertext = await this.senderKeys.encrypt(
      headerAAD,
      encodedData,
      this.senderKeys.currentEpoch,
      header.sequence,
      senderSsrc,
    );

    const metadata: VideoFrameMetadata = {
      ...metadataBase,
      fragmentIndex: 0,
      fragmentCount: 1,
    };
    const message = buildStreamFrameMessage(header, metadata, ciphertext);
    await this.transport.sendUniStream(message);
  }

  // ---------- Datagram handling ----------

  private handleDatagram(data: Uint8Array): void {
    try {
      const { header, payload } = parsePacket(data);

      // Ignore our own audio packets to avoid echo, but allow local video
      // loopback so the host sees the real published stream path.
      if (header.ssrc === this.localAudioSsrc && header.trackType !== TrackType.Video) return;
      if (header.ssrc === this.localScreenAudioSsrc) return;

      if (header.trackType === TrackType.Video) {
        this.handleVideoDatagram(data, header, payload);
        return;
      }

      const streamAudioUserId = this.findScreenAudioUserIdForSsrc(header.ssrc);
      if (streamAudioUserId) {
        this.handleScreenAudioDatagram(streamAudioUserId, header, payload, data);
        return;
      }

      // Audio handling
      const participant = this.participants.get(header.ssrc);
      if (!participant) {
        // Materialize is async (SHA-256 SSRC derive). Buffer briefly so the first
        // packets after join are not silently dropped, and nudge any in-flight
        // session peers that have not finished materializing yet.
        this.bufferOrphanAudioPacket(header, payload, data);
        for (const userId of this.sessionParticipantIds) {
          this.ensureRemoteParticipantState(userId);
        }
        return;
      }

      this.ingestRemoteAudioPacket(participant, header, payload, data);
    } catch {
      // Malformed packet
    }
  }

  private bufferOrphanAudioPacket(
    header: MediaHeader,
    payload: Uint8Array,
    raw: Uint8Array,
  ): void {
    let queue = this.orphanAudioPackets.get(header.ssrc);
    if (!queue) {
      queue = [];
      this.orphanAudioPackets.set(header.ssrc, queue);
    }
    if (queue.length >= BrowserMediaEngine.ORPHAN_AUDIO_LIMIT) {
      queue.shift();
    }
    queue.push({
      header,
      payload: payload.slice(),
      raw: raw.slice(0, HEADER_SIZE),
    });
  }

  private flushOrphanAudioPackets(ssrc: number, participant: ParticipantState): void {
    const queue = this.orphanAudioPackets.get(ssrc);
    if (!queue || queue.length === 0) {
      this.orphanAudioPackets.delete(ssrc);
      return;
    }
    this.orphanAudioPackets.delete(ssrc);
    for (const packet of queue) {
      this.ingestRemoteAudioPacket(participant, packet.header, packet.payload, packet.raw);
    }
  }

  private ingestRemoteAudioPacket(
    participant: ParticipantState,
    header: MediaHeader,
    payload: Uint8Array,
    aadSource: Uint8Array,
  ): void {
    participant.audioLevel = header.audioLevel;
    const wasSpeaking = participant.speaking;
    participant.speaking = header.audioLevel < 80; // Lower = louder
    if (wasSpeaking !== participant.speaking) {
      this.emitSpeakingChange();
    }

    this.senderKeys
      .decrypt(
        aadSource.slice(0, HEADER_SIZE),
        payload,
        header.keyEpoch,
        header.sequence,
        header.ssrc,
      )
      .then((decrypted) => {
        if (this.deafened) return;
        participant.jitterBuffer.push(header.sequence, header.timestamp, decrypted);
      })
      .catch(() => {
        // Decryption failed - missing key or corrupted
      });
  }

  /**
   * Handle an incoming video datagram. Decrypts the payload and routes
   * it to the correct video decoder based on the source SSRC.
   */
  private handleVideoDatagram(
    rawData: Uint8Array,
    header: MediaHeader,
    payload: Uint8Array,
  ): void {
    // Decrypt the video payload
    this.senderKeys.decrypt(
      rawData.slice(0, HEADER_SIZE),
      payload,
      header.keyEpoch,
      header.sequence,
      header.ssrc,
    ).then((decrypted) => {
      const reassembled = reassembleVideoPayload(this.videoReassembly, decrypted);
      if (!reassembled) {
        return;
      }
      this.routeReassembledVideoFrame(header, reassembled);
    }).catch(() => {
      // Decryption failed - missing key or corrupted
    });
  }

  /**
   * Handle a whole-frame keyframe message that arrived on a WebTransport
   * unidirectional stream (§5). The wire framing is the native uni-stream layout:
   * a cleartext 16-byte header, a cleartext {@link VideoFrameMetadata}, and the
   * whole frame encrypted as a single AEAD unit (AAD = the 16 header bytes). After
   * decrypting, the frame feeds the exact same frame_id-ordered decode path the
   * datagram deltas use, so stream and datagram frames stay interleaved in order.
   */
  private handleVideoStreamFrame(data: Uint8Array): void {
    let parsed: StreamFrameMessage;
    try {
      parsed = parseStreamFrameMessage(data);
    } catch {
      return;
    }
    const { header, metadata, ciphertext } = parsed;
    if (header.trackType !== TrackType.Video) return;

    this.senderKeys.decrypt(
      data.slice(0, HEADER_SIZE),
      ciphertext,
      header.keyEpoch,
      header.sequence,
      header.ssrc,
    ).then((decrypted) => {
      this.routeReassembledVideoFrame(header, {
        data: decrypted,
        isKeyframe: metadata.isKeyframe,
        streamId: metadata.streamId,
        trackId: metadata.trackId,
        codec: codecLabelFromHeader(metadata.codec),
      });
    }).catch(() => {
      // Decryption failed - missing key or corrupted
    });
  }

  /**
   * Route a fully reassembled/whole encoded video frame to its subscription's
   * decoder, swapping the decoder if the negotiated codec changed. Shared by the
   * datagram-fragment path and the uni-stream whole-frame path.
   */
  private routeReassembledVideoFrame(
    header: MediaHeader,
    reassembled: ReassembledVideoFrame,
  ): void {
    const { data: videoPayload, isKeyframe, streamId, trackId, codec } = reassembled;

    const publishedTrack = this.publishedTracks.get(this.trackKey(streamId, trackId));
    const userId =
      publishedTrack != null
        ? String(publishedTrack.publisherUserId)
        : this.ssrcToUserId.get(header.ssrc);
    if (!userId) return;

    const subscription = this.videoSubscriptions.get(userId);
    if (!subscription) return;
    subscription.ssrc = header.ssrc;
    const decoderCodec = this.decoderCodecForTrack(publishedTrack, codec);
    if (subscription.codec !== decoderCodec) {
      subscription.decoder.close();
      const decoder = new MediaVideoDecoder({ codec: decoderCodec });
      decoder.onDecoded((frame) => {
        subscription.renderer.renderFrame(frame);
      });
      subscription.decoder = decoder;
      subscription.codec = decoderCodec;
    }

    subscription.decoder.decode(
      videoPayload,
      header.timestamp * 1000, // convert ms timestamp to microseconds
      isKeyframe,
    );
  }

  private handleStreamControlMessage(msg: StreamControlMessage): void {
    switch (msg.type) {
      case 'session_state': {
        const participants = Array.isArray(msg.participants) ? msg.participants : [];
        const knownBefore = new Set(this.sessionParticipantIds);
        const desired = new Set<string>();
        const desiredCapabilities = new Map<string, SessionParticipantCapabilities>();
        const recipientUserIds: string[] = [];
        for (const rawParticipant of participants) {
          const userId = String((rawParticipant as { user_id?: string | number }).user_id ?? '');
          if (!userId || userId === String(this.localUserId ?? '')) {
            continue;
          }
          const sessionId = String((rawParticipant as { session_id?: string }).session_id ?? '');
          const videoCapabilities = Array.isArray(
            (rawParticipant as { video_capabilities?: unknown[] }).video_capabilities,
          )
            ? ((rawParticipant as { video_capabilities?: SessionParticipantCapabilities['videoCapabilities'] })
                .video_capabilities ?? [])
            : [];
          desired.add(userId);
          desiredCapabilities.set(userId, {
            userId,
            sessionId,
            videoCapabilities,
          });
          if (!this.sessionParticipantIds.has(userId)) {
            this.ensureRemoteParticipantState(userId);
            this.participantJoinCb?.(userId);
          }
          recipientUserIds.push(userId);
        }
        for (const userId of Array.from(this.sessionParticipantIds)) {
          if (desired.has(userId)) {
            continue;
          }
          this.removeRemoteParticipantState(userId);
          this.participantLeaveCb?.(userId);
        }
        this.sessionParticipantIds = desired;
        this.sessionParticipantCapabilities = desiredCapabilities;
        this.senderKeys.syncParticipants(this.sessionParticipantIds);
        void this.reconcileActivePublishCodecs().catch(() => {});
        const initialSync = knownBefore.size === 0;
        const membershipChanged =
          knownBefore.size !== desired.size ||
          Array.from(knownBefore).some((userId) => !desired.has(userId));
        if (membershipChanged && !initialSync) {
          void this.rotateAndAnnounceLocalSenderKeys(recipientUserIds).catch(() => {});
          break;
        }
        void this.announceAudioSenderKey(recipientUserIds).catch(() => {});
        void this.announcePublishedTrackKeysForRecipients(recipientUserIds);
        break;
      }
      case 'session_participant_join': {
        const participant =
          (msg.participant as {
            user_id?: string | number;
            session_id?: string;
            video_capabilities?: SessionParticipantCapabilities['videoCapabilities'];
          } | undefined) ?? undefined;
        const userId = String(participant?.user_id ?? '');
        if (!userId || userId === String(this.localUserId ?? '')) {
          break;
        }
        if (this.sessionParticipantIds.has(userId)) {
          break;
        }
        this.sessionParticipantIds.add(userId);
        this.sessionParticipantCapabilities.set(userId, {
          userId,
          sessionId: String(participant?.session_id ?? ''),
          videoCapabilities: Array.isArray(participant?.video_capabilities)
            ? participant!.video_capabilities!
            : [],
        });
        void this.reconcileActivePublishCodecs().catch(() => {});
        this.ensureRemoteParticipantState(userId);
        this.participantJoinCb?.(userId);
        void this.senderKeys
          .handleParticipantJoin(userId)
          .catch(() => {})
          .then(() => {
            const recipientUserIds = Array.from(this.sessionParticipantIds);
            return this.syncLocalSenderKeyToDecryptor()
              .catch(() => {})
              .then(() => {
                void this.announceAudioSenderKey(recipientUserIds).catch(() => {});
                void this.announcePublishedTrackKeysForRecipients(recipientUserIds);
              });
          });
        break;
      }
      case 'session_participant_leave': {
        const userId = String((msg.user_id as string | number | undefined) ?? '');
        if (!userId || userId === String(this.localUserId ?? '')) {
          break;
        }
        if (!this.sessionParticipantIds.delete(userId)) {
          break;
        }
        this.sessionParticipantCapabilities.delete(userId);
        void this.reconcileActivePublishCodecs().catch(() => {});
        this.removeRemoteParticipantState(userId);
        this.participantLeaveCb?.(userId);
        void this.senderKeys
          .handleParticipantLeave(userId)
          .catch(() => {})
          .then(() => {
            const remainingUserIds = Array.from(this.sessionParticipantIds);
            return this.syncLocalSenderKeyToDecryptor()
              .catch(() => {})
              .then(() => {
                void this.announceAudioSenderKey(remainingUserIds).catch(() => {});
                void this.announcePublishedTrackKeysForRecipients(remainingUserIds);
              });
          });
        break;
      }
      case 'track_publish': {
        const track = msg.track as PublishedTrackDescriptor | undefined;
        if (track?.streamId && track.trackId) {
          const key = this.trackKey(track.streamId, track.trackId);
          const publisherUserId = String(track.publisherUserId);
          this.publishedTracks.set(key, track);
          for (const layer of track.layers) {
            this.ssrcToUserId.set(layer.ssrc, publisherUserId);
          }
          const existingSub = this.videoSubscriptions.get(publisherUserId);
          const viewport = existingSub
            ? {
                width: Math.max(
                  1,
                  Math.round(
                    (existingSub.renderer.canvasElement?.clientWidth ||
                      existingSub.renderer.canvasElement?.width ||
                      1) * (window.devicePixelRatio || 1),
                  ),
                ),
                height: Math.max(
                  1,
                  Math.round(
                    (existingSub.renderer.canvasElement?.clientHeight ||
                      existingSub.renderer.canvasElement?.height ||
                      1) * (window.devicePixelRatio || 1),
                  ),
                ),
              }
            : null;
          const primaryLayer =
            (viewport
              ? selectPublishedLayer(track, viewport.width, viewport.height)
              : null) ??
            track.layers.find((layer) => layer.active) ??
            track.layers[0];
          if (primaryLayer) {
            if (existingSub) {
              existingSub.ssrc = primaryLayer.ssrc;
              existingSub.streamId = track.streamId;
              existingSub.trackId = track.trackId;
              existingSub.activeLayer = primaryLayer.layerId;
              if (viewport) {
                void this.registerTrackSubscription({
                  streamId: track.streamId,
                  trackId: track.trackId,
                  requestedLayer: primaryLayer.layerId,
                  viewport,
                }).catch(() => {});
              }
              const decoderCodec = this.decoderCodecForTrack(track);
              if (existingSub.codec !== decoderCodec) {
                existingSub.decoder.close();
                const decoder = new MediaVideoDecoder({ codec: decoderCodec });
                decoder.onDecoded((frame) => {
                  existingSub.renderer.renderFrame(frame);
                });
                existingSub.decoder = decoder;
                existingSub.codec = decoderCodec;
              } else {
                existingSub.decoder.reset();
              }
            }
          }
          void this.applyDeliveredTrackKeys(track);
        }
        break;
      }
      case 'track_unpublish': {
        const streamId = msg.stream_id as string | undefined;
        const trackId = msg.track_id as string | undefined;
        if (streamId && trackId) {
          const key = this.trackKey(streamId, trackId);
          const existing = this.publishedTracks.get(key);
          if (existing) {
            for (const layer of existing.layers) {
              if (this.ssrcToUserId.get(layer.ssrc) === String(existing.publisherUserId)) {
                this.ssrcToUserId.delete(layer.ssrc);
              }
            }
          }
          this.publishedTracks.delete(key);
          this.pendingTrackKeys.delete(key);
        }
        break;
      }
      case 'track_layers': {
        const streamId = msg.stream_id as string | undefined;
        const trackId = msg.track_id as string | undefined;
        const layers = msg.layers as PublishedLayerDescriptor[] | undefined;
        if (!streamId || !trackId || !layers) {
          break;
        }
        const key = `${streamId}:${trackId}`;
        const existing = this.publishedTracks.get(key);
        if (existing) {
          const updatedTrack = {
            ...existing,
            layers,
          };
          this.publishedTracks.set(key, updatedTrack);
          const publisherUserId = String(updatedTrack.publisherUserId);
          for (const layer of layers) {
            this.ssrcToUserId.set(layer.ssrc, publisherUserId);
          }
          const existingSub = this.videoSubscriptions.get(publisherUserId);
          const viewport = existingSub
            ? {
                width: Math.max(
                  1,
                  Math.round(
                    (existingSub.renderer.canvasElement?.clientWidth ||
                      existingSub.renderer.canvasElement?.width ||
                      1) * (window.devicePixelRatio || 1),
                  ),
                ),
                height: Math.max(
                  1,
                  Math.round(
                    (existingSub.renderer.canvasElement?.clientHeight ||
                      existingSub.renderer.canvasElement?.height ||
                      1) * (window.devicePixelRatio || 1),
                  ),
                ),
              }
            : null;
          const primaryLayer =
            (viewport
              ? selectPublishedLayer(updatedTrack, viewport.width, viewport.height)
              : null) ??
            layers.find((layer) => layer.active) ??
            layers[0];
          if (primaryLayer && existingSub) {
            existingSub.ssrc = primaryLayer.ssrc;
            existingSub.streamId = updatedTrack.streamId;
            existingSub.trackId = updatedTrack.trackId;
            existingSub.activeLayer = primaryLayer.layerId;
            if (viewport) {
              void this.registerTrackSubscription({
                streamId: updatedTrack.streamId,
                trackId: updatedTrack.trackId,
                requestedLayer: primaryLayer.layerId,
                viewport,
              }).catch(() => {});
            }
          }
          void this.applyDeliveredTrackKeys(updatedTrack);
        }
        break;
      }
      case 'request_keyframe': {
        if (this.videoEncoder) {
          this.videoEncoder.requestKeyframe();
        }
        if (this.screenEncoder) {
          this.screenEncoder.requestKeyframe();
        }
        break;
      }
      case 'bandwidth_feedback': {
        const availableKbps = Number(msg.available_kbps ?? 0);
        if (Number.isFinite(availableKbps) && availableKbps > 0) {
          void this.applyBandwidthFeedback(availableKbps).catch(() => {});
        }
        break;
      }
      case 'key_deliver': {
        const senderUserId = String((msg.sender_user_id as string | number | undefined) ?? '');
        const epoch = msg.epoch as number | undefined;
        const ciphertext = msg.ciphertext as number[] | undefined;
        if (!senderUserId || epoch === undefined || !Array.isArray(ciphertext)) {
          break;
        }
        void this.applyDeliveredAudioKey(senderUserId, epoch, Uint8Array.from(ciphertext)).catch(() => {});
        break;
      }
      case 'request_stream_key': {
        const streamId = msg.stream_id as string | undefined;
        const trackId = msg.track_id as string | undefined;
        const recipientUserId = msg.recipient_user_id as number | string | undefined;
        if (!streamId || !trackId || recipientUserId == null) {
          break;
        }
        const track = this.publishedTracks.get(this.trackKey(streamId, trackId));
        if (!track || String(track.publisherUserId) !== String(this.localUserId ?? '')) {
          break;
        }
        void this.announceTrackSenderKey(track, [String(recipientUserId)]).catch(() => {});
        break;
      }
      case 'stream_key_deliver': {
        const streamId = msg.stream_id as string | undefined;
        const trackId = msg.track_id as string | undefined;
        const senderUserId = String((msg.sender_user_id as string | number | undefined) ?? '');
        const epoch = msg.epoch as number | undefined;
        const ciphertext = msg.ciphertext as number[] | undefined;
        if (!streamId || !trackId || !senderUserId || epoch === undefined || !Array.isArray(ciphertext)) {
          break;
        }
        void unwrapDeliveredMediaSenderKey(
          this.trackKeyScope(streamId, trackId),
          senderUserId,
          Uint8Array.from(ciphertext),
        )
          .then((decrypted) => {
            this.rememberDeliveredTrackKey(
              streamId,
              trackId,
              decrypted.epoch || epoch,
              decrypted.rawKey,
            );
            const existingTrack = this.publishedTracks.get(this.trackKey(streamId, trackId));
            if (existingTrack) {
              void this.applyDeliveredTrackKeys(existingTrack);
            }
          })
          .catch(() => {});
        break;
      }
      default:
        break;
    }
  }

  private async buildLayerSsrcs(
    userId: string,
    kind: string,
    primarySsrc: number,
  ): Promise<Map<number, number>> {
    const layerSsrcs = new Map<number, number>();
    layerSsrcs.set(2, primarySsrc);
    layerSsrcs.set(0, await deriveTrackSsrc(userId, `${kind}:layer:0`));
    layerSsrcs.set(1, await deriveTrackSsrc(userId, `${kind}:layer:1`));
    return layerSsrcs;
  }

  private fitLayerDimensions(
    sourceWidth: number,
    sourceHeight: number,
    maxWidth: number,
    maxHeight: number,
  ): { width: number; height: number } {
    if (sourceWidth <= maxWidth && sourceHeight <= maxHeight) {
      return {
        width: Math.max(2, sourceWidth & ~1),
        height: Math.max(2, sourceHeight & ~1),
      };
    }

    const widthLimited = maxWidth * sourceHeight <= maxHeight * sourceWidth;
    let width: number;
    let height: number;
    if (widthLimited) {
      width = maxWidth;
      height = Math.floor((sourceHeight * maxWidth) / sourceWidth);
    } else {
      width = Math.floor((sourceWidth * maxHeight) / sourceHeight);
      height = maxHeight;
    }

    return {
      width: Math.max(2, width & ~1),
      height: Math.max(2, height & ~1),
    };
  }

  private buildSimulcastLayers(
    width: number,
    height: number,
    highestBitrateKbps: number,
    ssrcMap: Map<number, number>,
  ): PublishedLayerDescriptor[] {
    const activeLayerCount =
      SIMULCAST_LAYERS.filter((layer) => layer.width <= width && layer.height <= height).length || 1;
    const available = SIMULCAST_LAYERS.slice(0, activeLayerCount);
    const highestLayerId = Math.max(0, available.length - 1);

    return available.map((layer, index) => {
      const fitted = this.fitLayerDimensions(width, height, layer.width, layer.height);
      return {
        layerId: index,
        ssrc: ssrcMap.get(index) ?? ssrcMap.get(highestLayerId) ?? 1,
        width: fitted.width,
        height: fitted.height,
        maxBitrateKbps:
          index === highestLayerId
            ? highestBitrateKbps
            : Math.min(Math.round(layer.bitrate / 1000), highestBitrateKbps),
        active: index === highestLayerId,
      };
    });
  }

  private ensureRemoteParticipantState(userId: string): void {
    void this.materializeRemoteParticipant(userId);
  }

  private materializeRemoteParticipant(userId: string): Promise<void> {
    const existing = Array.from(this.participants.values()).find(
      (participant) => participant.userId === userId,
    );
    if (existing) {
      return Promise.resolve();
    }

    const pending = this.participantMaterializePromises.get(userId);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      const ssrc = await deriveTrackSsrc(userId, 'audio');
      if (this.participants.has(ssrc)) {
        return;
      }

      // Another concurrent materialize may have won the race.
      const raced = Array.from(this.participants.values()).find(
        (participant) => participant.userId === userId,
      );
      if (raced) {
        return;
      }

      const decoder = new OpusMediaDecoder({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      });
      const jitterBuffer = new JitterBuffer(FRAME_MS, 60);

      // Wire decoded PCM into the shared playback context so remote voice is audible.
      // Route through a per-participant GainNode so setSourceVolume can adjust gain.
      const gainNode =
        this.playbackContext != null ? this.playbackContext.createGain() : null;
      if (gainNode && this.playbackContext) {
        const initial = this.sourceVolumes.get(userId);
        if (initial != null) {
          gainNode.gain.value = Math.min(2, Math.max(0, initial));
        }
        gainNode.connect(this.playbackContext.destination);
      }

      decoder.onDecoded((audioData) => {
        if (this.deafened || !this.playbackContext) {
          audioData.close();
          return;
        }
        try {
          const channelData = new Float32Array(audioData.numberOfFrames);
          audioData.copyTo(channelData, { planeIndex: 0, format: 'f32' });
          const buffer = this.playbackContext.createBuffer(1, channelData.length, SAMPLE_RATE);
          buffer.copyToChannel(channelData, 0);
          const source = this.playbackContext.createBufferSource();
          source.buffer = buffer;
          if (gainNode) {
            source.connect(gainNode);
          } else {
            source.connect(this.playbackContext.destination);
          }
          source.start();
        } finally {
          audioData.close();
        }
      });

      const state: ParticipantState = {
        ssrc,
        userId,
        decoder,
        jitterBuffer,
        speaking: false,
        audioLevel: 127,
        gainNode,
      };
      this.participants.set(ssrc, state);
      this.ssrcToUserId.set(ssrc, userId);
      this.flushOrphanAudioPackets(ssrc, state);
    })().finally(() => {
      this.participantMaterializePromises.delete(userId);
    });

    this.participantMaterializePromises.set(userId, promise);
    return promise;
  }

  private removePublishedTracksForUser(userId: string): void {
    for (const [key, track] of this.publishedTracks.entries()) {
      if (String(track.publisherUserId) !== userId) {
        continue;
      }
      for (const layer of track.layers) {
        if (this.ssrcToUserId.get(layer.ssrc) === userId) {
          this.ssrcToUserId.delete(layer.ssrc);
        }
        this.senderKeys.removePeerKeys(layer.ssrc);
      }
      this.pendingTrackKeys.delete(key);
      this.publishedTracks.delete(key);
    }
  }

  private removeRemoteParticipantState(userId: string): void {
    for (const [ssrc, participant] of this.participants.entries()) {
      if (participant.userId !== userId) {
        continue;
      }
      participant.decoder.close();
      this.participants.delete(ssrc);
      this.ssrcToUserId.delete(ssrc);
      this.senderKeys.removePeerKeys(ssrc);
      this.orphanAudioPackets.delete(ssrc);
    }
    this.removePublishedTracksForUser(userId);

    const sub = this.videoSubscriptions.get(userId);
    if (sub) {
      sub.decoder.close();
      sub.renderer.clear();
      this.videoSubscriptions.delete(userId);
    }

    this.emitSpeakingChange();
  }

  private localScreenStreamId(): string {
    return `stream:${this.localUserId ?? 'browser'}:screen`;
  }

  private localCameraStreamId(): string {
    return `stream:${this.localUserId ?? 'browser'}:camera`;
  }

  private localMediaSsrcs(): number[] {
    return Array.from(
      new Set([
        this.localAudioSsrc,
        this.localVideoSsrc,
        this.localScreenSsrc,
        this.localScreenAudioSsrc,
        ...this.localVideoLayerSsrcs.values(),
        ...this.localScreenLayerSsrcs.values(),
      ].filter((ssrc) => Number.isFinite(ssrc) && ssrc > 0)),
    );
  }

  private async syncLocalSenderKeyToDecryptor(
    epoch: number = this.senderKeys.currentEpoch,
    rawKey?: Uint8Array,
  ): Promise<void> {
    const keyMaterial = rawKey ?? await this.senderKeys.exportKey();
    for (const ssrc of this.localMediaSsrcs()) {
      await this.senderKeys.importPeerKey(ssrc, epoch, keyMaterial);
    }
  }

  private trackKey(streamId: string, trackId: string): string {
    return `${streamId}:${trackId}`;
  }

  private decoderCodecForTrack(track?: PublishedTrackDescriptor, fallbackCodec?: string): string {
    const codec = String(track?.codec ?? fallbackCodec ?? 'vp9').trim().toLowerCase();
    switch (codec) {
      case 'h264':
      case 'av1':
      case 'vp9':
        return codec;
      default:
        return VP9_CODEC;
    }
  }

  private findPreferredPublishedVideoTrack(
    userId: string,
    preferredTrackId?: 'camera' | 'screen',
  ): PublishedTrackDescriptor | undefined {
    const tracks = Array.from(this.publishedTracks.values()).filter(
      (track) => String(track.publisherUserId) === userId && track.kind === 'video',
    );
    if (preferredTrackId) {
      return tracks.find((track) => track.trackId === preferredTrackId);
    }
    return (
      tracks.find((track) => track.trackId === 'screen') ??
      tracks.find((track) => track.trackId === 'camera') ??
      tracks[0]
    );
  }

  private estimateTrackBitrateKbps(
    track: PublishedTrackDescriptor | undefined,
    requestedLayer?: number | null,
  ): number {
    if (!track) {
      return 0;
    }
    const preferredLayer =
      track.layers.find((layer) => layer.layerId === requestedLayer) ??
      track.layers.find((layer) => layer.active) ??
      track.layers[track.layers.length - 1];
    return Math.max(0, Number(preferredLayer?.maxBitrateKbps ?? 0));
  }

  private buildLocalScreenTrack(
    width: number,
    height: number,
    codec: 'vp9' | 'av1' | 'h264' | string,
  ): PublishedTrackDescriptor {
    return {
      streamId: this.localScreenStreamId(),
      trackId: 'screen',
      publisherUserId: this.localUserId ?? '0',
      kind: 'video',
      codec,
      layers: this.buildSimulcastLayers(width, height, 2000, this.localScreenLayerSsrcs),
    };
  }

  private buildLocalScreenAudioTrack(): PublishedTrackDescriptor {
    return {
      streamId: this.localScreenStreamId(),
      trackId: 'screen-audio',
      publisherUserId: this.localUserId ?? '0',
      kind: 'audio',
      codec: null,
      layers: [{
        layerId: 0,
        ssrc: this.localScreenAudioSsrc,
        width: null,
        height: null,
        maxBitrateKbps: 192,
        active: true,
      }],
    };
  }

  private findPublishedScreenAudioTrack(userId: string): PublishedTrackDescriptor | undefined {
    return Array.from(this.publishedTracks.values()).find(
      (track) =>
        String(track.publisherUserId) === userId &&
        track.trackId === 'screen-audio' &&
        track.kind === 'audio',
    );
  }

  private findScreenAudioUserIdForSsrc(ssrc: number): string | null {
    for (const track of this.publishedTracks.values()) {
      if (track.trackId !== 'screen-audio' || track.kind !== 'audio') {
        continue;
      }
      if (track.layers.some((layer) => layer.ssrc === ssrc)) {
        return String(track.publisherUserId);
      }
    }
    for (const [userId, sub] of this.screenAudioSubscriptions) {
      if (sub.ssrc === ssrc) {
        return userId;
      }
    }
    return null;
  }

  private async setupScreenAudioCapture(audioTracks: MediaStreamTrack[]): Promise<void> {
    this.cleanupScreenAudioCapture();
    const audioOnlyStream = new MediaStream(audioTracks);
    this.screenAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const processorUrl = new URL('./audio/audioProcessor.ts', import.meta.url).href;
    await this.screenAudioContext.audioWorklet.addModule(processorUrl);
    const source = this.screenAudioContext.createMediaStreamSource(audioOnlyStream);
    this.screenAudioWorkletNode = new AudioWorkletNode(this.screenAudioContext, 'media-audio-processor');
    this.screenAudioWorkletNode.port.onmessage = (event) => {
      if (event.data.type === 'frame' && this.screenAudioActive) {
        this.encodeAndSendScreenAudio(event.data.samples);
      }
    };
    source.connect(this.screenAudioWorkletNode);
    this.screenAudioWorkletNode.connect(this.screenAudioContext.destination);
    this.screenAudioEncoder = new OpusMediaEncoder({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitrate: 192_000,
    });
    this.screenAudioEncoder.onEncoded((chunk) => {
      void this.sendEncodedScreenAudio(chunk);
    });
    this.screenAudioSequence = 0;
  }

  private encodeAndSendScreenAudio(samples: Float32Array): void {
    if (!this.screenAudioEncoder) return;
    const timestamp = this.screenAudioSequence * FRAME_MS * 1000;
    this.screenAudioEncoder.encode(samples, timestamp);
  }

  private async sendEncodedScreenAudio(chunk: EncodedAudioChunk): Promise<void> {
    if (!this.transport) return;
    const encodedData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(encodedData);
    const header: MediaHeader = {
      version: PROTOCOL_VERSION,
      trackType: TrackType.Audio,
      simulcastLayer: 0,
      sequence: this.screenAudioSequence & 0xffff,
      timestamp: (chunk.timestamp / 1000) >>> 0,
      ssrc: this.localScreenAudioSsrc,
      audioLevel: 127,
      keyEpoch: this.senderKeys.currentEpoch,
      payloadLength: 0,
      codec: 0,
    };
    const headerAAD = createPacket(header, new Uint8Array(0)).slice(0, HEADER_SIZE);
    const encrypted = await this.senderKeys.encrypt(
      headerAAD,
      encodedData,
      this.senderKeys.currentEpoch,
      this.screenAudioSequence & 0xffff,
      this.localScreenAudioSsrc,
    );
    const packet = createPacket(header, encrypted);
    this.transport.sendDatagram(packet);
    this.screenAudioSequence++;
  }

  private handleScreenAudioDatagram(
    userId: string,
    header: MediaHeader,
    payload: Uint8Array,
    rawData: Uint8Array,
  ): void {
    const subscription = this.screenAudioSubscriptions.get(userId);
    if (!subscription) {
      return;
    }
    subscription.ssrc = header.ssrc;
    this.senderKeys.decrypt(
      rawData.slice(0, HEADER_SIZE),
      payload,
      header.keyEpoch,
      header.sequence,
      header.ssrc,
    ).then((decrypted) => {
      if (this.deafened) return;
      subscription!.jitterBuffer.push(header.sequence, header.timestamp, decrypted);
    }).catch(() => {});
  }

  private async restoreTransportSession(): Promise<void> {
    if (!this.transport) return;
    await this.transport.sendStreamControl({
      type: 'session_join',
      room_id: this.localRoomId ?? '',
      session_id: `browser-${this.localUserId ?? 'unknown'}`,
      video_capabilities: (await this.getStreamCapabilities()).video.map((capability) => ({
        codec: capability.codec,
        encode: capability.encode,
        decode: capability.decode,
        encodeHardware: capability.encodeHardware,
        decodeHardware: capability.decodeHardware,
      })),
    });
    const recipientUserIds = this.currentRemoteParticipantIds();
    await this.announceAudioSenderKey(recipientUserIds);
    await this.announcePublishedTrackKeysForRecipients(recipientUserIds);
    for (const [, sub] of this.videoSubscriptions) {
      if (!sub.streamId || !sub.trackId) continue;
      const canvas = sub.renderer.canvasElement;
      const viewport = canvas
        ? {
            width: Math.max(
              1,
              Math.round((canvas.clientWidth || canvas.width || 1) * (window.devicePixelRatio || 1)),
            ),
            height: Math.max(
              1,
              Math.round((canvas.clientHeight || canvas.height || 1) * (window.devicePixelRatio || 1)),
            ),
          }
        : undefined;
      await this.registerTrackSubscription({
        streamId: sub.streamId,
        trackId: sub.trackId,
        requestedLayer: sub.activeLayer,
        viewport,
      }).catch(() => {});
    }
    for (const userId of this.screenAudioSubscriptions.keys()) {
      const track = this.findPublishedScreenAudioTrack(userId);
      if (track) {
        await this.registerTrackSubscription({
          streamId: track.streamId,
          trackId: track.trackId,
          requestedLayer: 0,
        }).catch(() => {});
      }
    }
  }

  private async applyBandwidthFeedback(availableKbps: number): Promise<void> {
    for (const [, sub] of this.videoSubscriptions) {
      if (!sub.streamId || !sub.trackId) continue;
      const track = this.publishedTracks.get(this.trackKey(sub.streamId, sub.trackId));
      if (!track?.layers.length) continue;
      const sortedLayers = [...track.layers].sort((a, b) => (a.maxBitrateKbps ?? 0) - (b.maxBitrateKbps ?? 0));
      let targetLayer = sortedLayers[0]?.layerId ?? 0;
      for (const layer of sortedLayers) {
        if ((layer.maxBitrateKbps ?? 0) <= availableKbps) {
          targetLayer = layer.layerId;
        }
      }
      if (sub.activeLayer === targetLayer) continue;
      sub.activeLayer = targetLayer;
      const canvas = sub.renderer.canvasElement;
      const viewport = canvas
        ? {
            width: Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * (window.devicePixelRatio || 1))),
            height: Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * (window.devicePixelRatio || 1))),
          }
        : undefined;
      await this.registerTrackSubscription({
        streamId: sub.streamId,
        trackId: sub.trackId,
        requestedLayer: targetLayer,
        activeLayer: targetLayer,
        viewport,
      }).catch(() => {});
    }
  }

  private clearScreenAudioSubscriptions(): void {
    for (const [, sub] of this.screenAudioSubscriptions) {
      sub.decoder.close();
      sub.playbackContext.close().catch(() => {});
    }
    this.screenAudioSubscriptions.clear();
  }

  private cleanupScreenAudioCapture(): void {
    if (this.screenAudioWorkletNode) {
      this.screenAudioWorkletNode.disconnect();
      this.screenAudioWorkletNode = null;
    }
    if (this.screenAudioContext) {
      this.screenAudioContext.close().catch(() => {});
      this.screenAudioContext = null;
    }
    if (this.screenAudioEncoder) {
      this.screenAudioEncoder.close();
      this.screenAudioEncoder = null;
    }
    this.screenAudioSequence = 0;
    this.screenAudioActive = false;
  }

  private buildLocalCameraTrack(
    width: number,
    height: number,
    codec: 'vp9' | 'av1' | 'h264' | string,
  ): PublishedTrackDescriptor {
    return {
      streamId: this.localCameraStreamId(),
      trackId: 'camera',
      publisherUserId: this.localUserId ?? '0',
      kind: 'video',
      codec,
      layers: this.buildSimulcastLayers(width, height, 1500, this.localVideoLayerSsrcs),
    };
  }

  private rememberDeliveredTrackKey(
    streamId: string,
    trackId: string,
    epoch: number,
    rawKey: Uint8Array,
  ): void {
    const key = this.trackKey(streamId, trackId);
    let epochs = this.pendingTrackKeys.get(key);
    if (!epochs) {
      epochs = new Map<number, Uint8Array>();
      this.pendingTrackKeys.set(key, epochs);
    }
    epochs.set(epoch, rawKey);
  }

  private async applyDeliveredTrackKeys(track: PublishedTrackDescriptor): Promise<void> {
    const key = this.trackKey(track.streamId, track.trackId);
    const epochs = this.pendingTrackKeys.get(key);
    if (!epochs || epochs.size === 0) {
      return;
    }
    for (const [epoch, rawKey] of epochs.entries()) {
      for (const layer of track.layers) {
        await this.senderKeys.importPeerKey(layer.ssrc, epoch, rawKey);
      }
    }
  }

  private currentRemoteParticipantIds(): string[] {
    return Array.from(this.sessionParticipantIds).filter((userId) => userId !== this.localUserId);
  }

  private audioKeyScope(): string {
    return `room:${this.localRoomId ?? 'unknown'}:audio`;
  }

  private trackKeyScope(streamId: string, trackId: string): string {
    return `stream:${streamId}:${trackId}`;
  }

  private async buildEncryptedSenderKeyPayloads(
    scope: string,
    rawKey: Uint8Array,
    epoch: number,
    recipientUserIds: string[],
  ): Promise<Array<[number, number[]]>> {
    const wrapped = await wrapSenderKeyForRecipients(scope, rawKey, epoch, recipientUserIds);
    return wrapped.map(
      (entry) => [Number(entry.recipientUserId), Array.from(entry.wrapped)] as [number, number[]],
    );
  }

  private async announceTrackSenderKey(
    track: PublishedTrackDescriptor,
    recipientUserIds: string[] = this.currentRemoteParticipantIds(),
  ): Promise<void> {
    if (!this.transport || recipientUserIds.length === 0) {
      return;
    }
    const rawKey = await this.senderKeys.exportKey();
    const encryptedKeys = await this.buildEncryptedSenderKeyPayloads(
      this.trackKeyScope(track.streamId, track.trackId),
      rawKey,
      this.senderKeys.currentEpoch,
      recipientUserIds,
    );
    if (encryptedKeys.length === 0) {
      return;
    }
    await this.transport.sendStreamControl({
      type: 'stream_key_announce',
      stream_id: track.streamId,
      track_id: track.trackId,
      codec: track.codec ?? null,
      epoch: this.senderKeys.currentEpoch,
      encrypted_keys: encryptedKeys,
    });
  }

  private buildLocalVideoMetadata(
    seq: number,
    isScreenShare: boolean,
    data: EncodedVideoChunkWithMeta,
  ): Omit<VideoFrameMetadata, 'fragmentIndex' | 'fragmentCount'> {
    const streamId = isScreenShare ? this.localScreenStreamId() : this.localCameraStreamId();
    const trackId = isScreenShare ? 'screen' : 'camera';
    const codec = this.headerCodecId(data.codec);
    return {
      streamId,
      trackId,
      frameId: BigInt(seq),
      layerId: data.layerIndex,
      codec,
      timestampUs: BigInt(Math.max(0, Math.floor(data.chunk.timestamp))),
      isKeyframe: data.chunk.type === 'key',
    };
  }

  private headerCodecId(codec: string): number {
    switch (codec.trim().toLowerCase()) {
      case 'av1':
        return 2;
      case 'h264':
        return 3;
      case 'vp9':
      default:
        return 1;
    }
  }

  private async announcePublishedTrackKeysForRecipients(recipientUserIds: string[]): Promise<void> {
    if (recipientUserIds.length === 0) {
      return;
    }
    const localUserId = String(this.localUserId ?? '');
    const localTracks = Array.from(this.publishedTracks.values()).filter(
      (track) => String(track.publisherUserId) === localUserId,
    );
    for (const track of localTracks) {
      await this.announceTrackSenderKey(track, recipientUserIds);
    }
  }

  private async announceAudioSenderKey(recipientUserIds: string[]): Promise<void> {
    if (!this.transport || recipientUserIds.length === 0) {
      return;
    }
    const rawKey = await this.senderKeys.exportKey();
    const encryptedKeys = await this.buildEncryptedSenderKeyPayloads(
      this.audioKeyScope(),
      rawKey,
      this.senderKeys.currentEpoch,
      recipientUserIds,
    );
    if (encryptedKeys.length === 0) {
      return;
    }
    await this.transport.sendStreamControl({
      type: 'key_announce',
      epoch: this.senderKeys.currentEpoch,
      encrypted_keys: encryptedKeys,
    });
  }

  private async applyDeliveredAudioKey(
    senderUserId: string,
    epoch: number,
    payload: Uint8Array,
  ): Promise<void> {
    const decrypted = await unwrapDeliveredMediaSenderKey(this.audioKeyScope(), senderUserId, payload);
    const rawKey = decrypted.rawKey;
    const resolvedEpoch = decrypted.epoch || epoch;
    const ssrc = await deriveTrackSsrc(senderUserId, 'audio');
    await this.senderKeys.importPeerKey(ssrc, resolvedEpoch, rawKey);
    await this.materializeRemoteParticipant(senderUserId);
  }

  private async rotateAndAnnounceLocalSenderKeys(recipientUserIds: string[]): Promise<void> {
    const rotated = await this.senderKeys.rotateKey();
    await this.syncLocalSenderKeyToDecryptor(rotated.newEpoch, rotated.newKey);
    await this.announceAudioSenderKey(recipientUserIds);
    await this.announcePublishedTrackKeysForRecipients(recipientUserIds);
  }

  // ---------- Playback loop ----------

  private startPlaybackLoop(): void {
    // Pull from jitter buffers and decode at 20ms intervals. Decoded PCM is
    // rendered via each decoder's onDecoded callback (wired in
    // materializeRemoteParticipant / subscribeScreenShareAudio).
    this.playbackInterval = setInterval(() => {
      if (this.deafened || !this.playbackContext) return;

      for (const [, participant] of this.participants) {
        const frame = participant.jitterBuffer.pull();
        if (frame) {
          const timestamp = performance.now() * 1000; // rough timestamp in us
          participant.decoder.decode(frame, timestamp);
        }
      }

      for (const [, subscription] of this.screenAudioSubscriptions) {
        const frame = subscription.jitterBuffer.pull();
        if (!frame) continue;
        const timestamp = performance.now() * 1000;
        subscription.decoder.decode(frame, timestamp);
      }
    }, FRAME_MS);
  }

  private stopPlaybackLoop(): void {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
  }

  // ---------- Speaking detection ----------

  private emitSpeakingChange(): void {
    if (!this.speakingChangeCb) return;
    const speakers = new Map<string, number>();
    for (const [, p] of this.participants) {
      if (p.speaking) {
        speakers.set(p.userId, p.audioLevel);
      }
    }
    // Include local user if speaking
    if (this.localAudioLevel < 80 && !this.muted) {
      speakers.set('local', this.localAudioLevel);
    }
    this.speakingChangeCb(speakers);
  }

  // ---------- Cleanup ----------

  private cleanupAudio(): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
    }
    if (this.encoder) {
      this.encoder.close();
      this.encoder = null;
    }
  }

  private cleanupVideo(): void {
    if (this.videoFrameCallbackId !== null) {
      cancelAnimationFrame(this.videoFrameCallbackId);
      this.videoFrameCallbackId = null;
    }

    if (this.videoTrack) {
      const cleanup = (this.videoTrack as unknown as Record<string, () => void>).__paracordCleanup;
      if (cleanup) cleanup();
      this.videoTrack.stop();
      this.videoTrack = null;
    }

    if (this.videoStream) {
      for (const track of this.videoStream.getTracks()) {
        track.stop();
      }
      this.videoStream = null;
    }

    if (this.videoEncoder) {
      this.videoEncoder.close();
      this.videoEncoder = null;
    }

    this.publishedTracks.delete(this.trackKey(this.localCameraStreamId(), 'camera'));
    this.videoSequence = 0;
  }

  private cleanupScreenShare(): void {
    if (this.screenFrameCallbackId !== null) {
      cancelAnimationFrame(this.screenFrameCallbackId);
      this.screenFrameCallbackId = null;
    }

    this.cleanupScreenAudioCapture();

    if (this.screenTrack) {
      const cleanup = (this.screenTrack as unknown as Record<string, () => void>).__paracordCleanup;
      if (cleanup) cleanup();
      this.screenTrack.stop();
      this.screenTrack = null;
    }

    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        track.stop();
      }
      this.screenStream = null;
    }

    if (this.screenEncoder) {
      this.screenEncoder.close();
      this.screenEncoder = null;
    }

    this.screenSequence = 0;
  }
}
