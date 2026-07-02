export interface ScreenShareConfig {
  audio: boolean;
  maxFrameRate?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxBitrateBps?: number;
  contentHint?: 'detail' | 'motion' | 'film';
  preferredCodec?: 'vp9' | 'av1' | 'h264';
  sourceId?: string;
}

export interface ScreenShareSource {
  id: string;
  kind: string;
  title: string;
  appName?: string | null;
  audioSupported: boolean;
  isSelf: boolean;
  requiresOsPicker: boolean;
}

export interface ScreenShareThumbnail {
  dataUrl: string;
}

export interface StreamViewportHint {
  width: number;
  height: number;
}

export interface VideoCodecCapability {
  codec: 'vp9' | 'av1' | 'h264' | string;
  backend: string;
  encode: boolean;
  decode: boolean;
  hardwareAccelerated: boolean;
}

export interface MediaStreamCapabilities {
  video: VideoCodecCapability[];
  nativeDesktopRenderer: boolean;
  browserInteropProtocolV1: boolean;
  realMediaE2ee: boolean;
  simulcastV1: boolean;
}

export interface PublishedLayerDescriptor {
  layerId: number;
  ssrc: number;
  width?: number | null;
  height?: number | null;
  maxBitrateKbps?: number | null;
  active: boolean;
}

export interface PublishedTrackDescriptor {
  streamId: string;
  trackId: string;
  publisherUserId: string | number;
  kind: 'audio' | 'video' | string;
  codec?: 'vp9' | 'av1' | 'h264' | string | null;
  layers: PublishedLayerDescriptor[];
}

export interface TrackSubscriptionRequest {
  streamId: string;
  trackId: string;
  requestedLayer?: number;
  activeLayer?: number;
  viewport?: StreamViewportHint;
}

export interface TrackSubscriptionDescriptor {
  streamId: string;
  trackId: string;
  requestedLayer?: number | null;
  activeLayer?: number | null;
  viewport?: StreamViewportHint | null;
}

export interface MediaStreamDiagnostics {
  connected: boolean;
  sessionId?: string | null;
  roomId?: string | null;
  participantCount: number;
  participants?: Array<{
    userId: string;
    sessionId: string;
    videoCapabilities: VideoCodecCapability[];
  }>;
  localPublishCodecs?: {
    preferredCommonCodec?: 'vp9' | 'av1' | 'h264' | string | null;
    cameraCodec?: 'vp9' | 'av1' | 'h264' | string | null;
    screenCodec?: 'vp9' | 'av1' | 'h264' | string | null;
  };
  activePublishBackends?: {
    camera?: {
      codec: 'vp9' | 'av1' | 'h264' | string;
      backend: string;
      hardwareAccelerated: boolean;
    } | null;
    screen?: {
      codec: 'vp9' | 'av1' | 'h264' | string;
      backend: string;
      hardwareAccelerated: boolean;
    } | null;
  };
  publishedTracks: PublishedTrackDescriptor[];
  subscriptions: TrackSubscriptionDescriptor[];
  capabilities: MediaStreamCapabilities;
}

export interface MediaEngine {
  connect(endpoint: string, token: string, certHash?: string): Promise<void>;
  disconnect(): Promise<void>;
  setMute(muted: boolean): void;
  setDeaf(deafened: boolean): void;
  enableVideo(enabled: boolean): void;
  startScreenShare(config: ScreenShareConfig): Promise<void>;
  stopScreenShare(): Promise<void>;
  supportsNativeSourcePicker(): boolean;
  listScreenShareSources(): Promise<ScreenShareSource[]>;
  getScreenShareSourceThumbnail(sourceId: string): Promise<ScreenShareThumbnail | null>;
  /** Whether stream-audio capture is currently active for screen sharing. */
  isScreenShareAudioActive(): boolean;
  /** Register a callback fired when the user stops screen sharing via the
   *  browser's native "Stop sharing" UI (track ended externally). */
  onScreenShareEnded(cb: () => void): void;
  onSpeakingChange(cb: (speakers: Map<string, number>) => void): void;
  onParticipantJoin(cb: (userId: string) => void): void;
  onParticipantLeave(cb: (userId: string) => void): void;
  getStreamCapabilities(): Promise<MediaStreamCapabilities>;
  getStreamingDiagnostics(): Promise<MediaStreamDiagnostics>;
  listPublishedTracks(): Promise<PublishedTrackDescriptor[]>;
  registerTrackSubscription(request: TrackSubscriptionRequest): Promise<void>;
  unregisterTrackSubscription(streamId: string, trackId: string): Promise<void>;
  subscribeVideo(userId: string, canvas: HTMLCanvasElement, onFrame?: () => void): () => void;
  subscribeLocalPublishedScreen(canvas: HTMLCanvasElement, onFrame?: () => void): () => void;
}

export async function createMediaEngine(): Promise<MediaEngine> {
  // Platform detection: Tauri desktop vs browser
  // Tauri v2 exposes __TAURI_INTERNALS__, v1 used __TAURI__.
  if (typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) {
    const { TauriMediaEngine } = await import('./tauriMediaEngine');
    return new TauriMediaEngine();
  }
  const { BrowserMediaEngine } = await import('./browserMediaEngine');
  return new BrowserMediaEngine();
}
