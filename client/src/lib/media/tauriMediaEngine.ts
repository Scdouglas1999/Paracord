import type { OperationContext } from '../operationContext';
import type {
  MediaEngine,
  MediaSessionContext,
  MediaSessionRole,
  VideoFrameTap,
  VideoTapRoute,
  MediaStreamCapabilities,
  MediaStreamDiagnostics,
  PublishedTrackDescriptor,
  ScreenShareConfig,
  ScreenShareSource,
  ScreenShareThumbnail,
  TrackSubscriptionRequest,
  SubscribeVideoOptions,
  VideoStill,
} from './mediaEngine';
import { NativeVideoTile } from './video/nativeVideoTile';
import { NATIVE_STILL_COMMAND, nativeStillBitmap, parseNativeStill } from './video/nativeStill';
import { logVoiceDiagnostic } from '../desktopDiagnostics';
import { MediaKeyring } from './mediaKeyring';
import {
  parseRoomIdFromToken,
  parseUserIdFromToken,
  parseViewKindFromToken,
  selectPublishedLayer,
  wrapSenderKeyForRecipients,
  keyRecipients,
  readRosterKind,
  samePublishedTrack,
  type RosterKind,
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

type ExportedSenderKey = {
  epoch: number;
  rawKey: number[];
};

/**
 * A roster entry arriving (`media_participant_join`): `{ userId, kind }`, with
 * the relay's `member` / `viewer` mark. Null for anything else, and for a kind
 * this client does not know (never taken for a member).
 */
function readRosterEvent(payload: unknown): { userId: string; kind: RosterKind } | null {
  if (!payload || typeof payload !== 'object') return null;
  const { userId, kind } = payload as { userId?: unknown; kind?: unknown };
  if (typeof userId !== 'string' || !userId) return null;
  const parsed = readRosterKind(kind);
  return parsed ? { userId, kind: parsed } : null;
}

/** What the native session asks this side to wrap and announce. */
interface AnnounceRequest {
  /** The voice key (to call members only). */
  voice: boolean;
  /** Track keys (to members, and to viewers for the viewable stream). */
  tracks: Array<{ streamId: string; trackId: string }>;
  /** Exactly these peers; null means everybody in the roster owed each key. */
  recipients: string[] | null;
}

function readAnnounceRequest(payload: unknown): AnnounceRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { voice?: unknown; tracks?: unknown; recipients?: unknown };
  const tracks = Array.isArray(raw.tracks)
    ? raw.tracks.filter(
      (track): track is { streamId: string; trackId: string } =>
        !!track && typeof track.streamId === 'string' && typeof track.trackId === 'string',
    )
    : [];
  const recipients = Array.isArray(raw.recipients)
    ? raw.recipients.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : null;
  return { voice: raw.voice === true, tracks, recipients };
}

type SessionParticipantCapabilities = {
  userId: string;
  sessionId: string;
  /** Call member or view session, as the relay marked this roster entry. */
  kind?: RosterKind;
  /** The call key this peer published; see `./mediaKeyring`. */
  mediaPublicKey?: string;
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
  /** The tile's canvas: its box is what the native surface mirrors (and the
   * relay's viewport hint), and it shows the poster while the hole is closed. */
  canvas: HTMLCanvasElement;
  /** The tile's native surface (spec §3.6): geometry, visibility and the
   * poster. Frames never cross IPC. Absent on a headless (sampler) subscription
   * and when the track has no route. */
  nativeTile?: NativeVideoTile;
  streamId?: string;
  trackId?: string;
  activeLayer?: number;
  stop: () => void;
}

/** The relay's viewport hint for a tile: its box in physical pixels. */
function canvasViewport(canvas: HTMLCanvasElement): { width: number; height: number } {
  const clientWidth = canvas.clientWidth || canvas.width || 0;
  const clientHeight = canvas.clientHeight || canvas.height || 0;
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
 * Visibility for a headless subscription (a frame tap with no surface): only
 * the document's visibility counts, since there is no element to intersect.
 */
function attachDocumentVisibilityControls(
  reportVisibility: (visible: boolean) => void,
): { cleanup: () => void; isRenderingEnabled: () => boolean } {
  let visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const onVisibilityChange = () => {
    const next = document.visibilityState !== 'hidden';
    if (next === visible) return;
    visible = next;
    reportVisibility(next);
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  return {
    cleanup: () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    },
    isRenderingEnabled: () => visible,
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
  /** How this session takes part; see `MediaSessionRole`. */
  private role: MediaSessionRole = 'call';
  /** Roster peers the relay marked `viewer`: watching our stream, not in the call. */
  private viewerPeers = new Set<string>();
  /** Roster peers reported to the call as members (joined, not yet left). */
  private rosterMembers = new Set<string>();
  /** The call's leave listeners, also told when a member turns into a viewer. */
  private participantLeaveListeners: Array<(userId: string) => void> = [];
  /** Frame taps per subscription key (`userId:trackId`). */
  private frameTaps = new Map<string, Set<(frame: VideoFrame) => void>>();
  /** The route each subscription key settled on, for taps that join it. */
  private subscriptionRoutes = new Map<string, VideoTapRoute>();
  /** Route waiters for taps whose subscription is still being established. */
  private routeWaiters = new Map<string, Set<(route: VideoTapRoute) => void>>();
  /** Set while `subscribeVideo` releases the subscription it replaces. */
  private replacingKey: string | null = null;
  private sessionParticipantCapabilities = new Map<string, SessionParticipantCapabilities>();
  /** Call keys for this media session. Minted on connect, destroyed on leave. */
  private keyring = MediaKeyring.create();

  // Screen share state for the native desktop capture path
  private screenShareEndedCb: (() => void) | null = null;
  private screenAudioActive = false;
  /** Why stream audio is absent, in plain words; null when it is present. */
  private screenAudioError: string | null = null;
  /** True while `enableVideo(true)` is awaiting the native camera open. */
  private cameraEnableInFlight = false;
  /** The failure `enableVideo` already reported, and when, for de-duplication. */
  private cameraEnableFailure: { message: string; at: number } | null = null;
  private screenEventUnlisten: UnlistenFn | null = null;
  private transportLostUnlisten: UnlistenFn | null = null;
  private transportLostCb: ((reason: string) => void) | null = null;
  private disconnecting = false;
  private disposed = false;
  private cameraRevision = 0;
  private screenRevision = 0;
  private disposePromise: Promise<void> | null = null;
  private startScheduled = false;
  readonly sessionOwnerId = crypto.randomUUID();
  private removeAbortListener: (() => void) | null = null;
  private account?: OperationContext;

  private assertOpen(): void {
    if (this.disposed) throw new DOMException('The native media session has ended.', 'AbortError');
  }

  private failKeyExchange(error: unknown): void {
    if (this.disposed) return;
    const reason = `Media encryption could not verify a participant: ${error instanceof Error ? error.message : String(error)}`;
    this.transportLostCb?.(reason);
    void this.disconnect();
  }

  private async invokeOwned(command: string, args?: Record<string, unknown>): Promise<unknown> {
    this.assertOpen();
    await tauriReady;
    this.assertOpen();
    const result = await invoke(command, { ...args, ownerId: this.sessionOwnerId });
    this.assertOpen();
    return result;
  }

  private async invokeCleanup(command: string, args?: Record<string, unknown>): Promise<unknown> {
    await tauriReady;
    return invoke(command, { ...args, ownerId: this.sessionOwnerId });
  }

  private async listenOwned(event: string, callback: (event: { payload: unknown }) => void): Promise<UnlistenFn> {
    await tauriReady;
    if (this.disposed) return () => {};
    const unlisten = await listen(`${event}:${this.sessionOwnerId}`, value => {
      if (!this.disposed) callback(value);
    });
    if (this.disposed) { unlisten(); return () => {}; }
    return unlisten;
  }
  // Remote screen-share audio tracks we've registered for. Playback happens in
  // the native cpal mixer (contract C4); the webview only drives the relay
  // track subscription, so we track subscribers to unregister on teardown.
  private screenShareAudioSubscribers = new Set<string>();
  /** The relay subscription each stream-audio subscriber holds, once its track is known. */
  private screenAudioRegistrations = new Map<string, { streamId: string; trackId: string }>();
  private audioSubscriptionReleases = new Map<string, () => void>();
  private videoSubscriptionReleases = new Map<string, () => void>();

  // Native camera capture state. There is no JS getUserMedia / frame-extraction
  // path anymore (contract CAM4): capture, encode, and the self-view all live in
  // Rust. The webview only toggles capture and listens for hard errors.
  private cameraEventUnlisten: (() => void) | null = null;
  private cameraFailureCb: ((error: Error) => void) | null = null;

  async connect(endpoint: string, token: string, certHash?: string, session?: MediaSessionContext): Promise<void> {
    this.assertOpen();
    if (session) {
      this.account = session.account;
      const abort = () => { void this.disconnect(); };
      session.signal.addEventListener('abort', abort, { once: true });
      this.removeAbortListener = () => session.signal.removeEventListener('abort', abort);
      if (session.signal.aborted) { await this.disconnect(); this.assertOpen(); }
    }
    await tauriReady;
    this.assertOpen();
    if (!certHash) {
      throw new Error('native media server did not provide a TLS certificate pin');
    }
    // The native side checks this against the token's `view` claim too; the
    // renderer refuses the mismatch first so the error names the cause.
    this.role = session?.role ?? 'call';
    const viewKind = parseViewKindFromToken(token);
    if ((this.role === 'view') !== (viewKind !== null)) {
      throw new Error(this.role === 'view'
        ? 'A view session needs a view-session media token.'
        : 'A view-session media token cannot join a call.');
    }
    this.localUserId = parseUserIdFromToken(token);
    this.localRoomId = parseRoomIdFromToken(token);
    // Wait for all pending listener registrations to complete before
    // starting the session so we don't miss early events on cold boot.
    if (this.listenerPromises.length > 0) {
      await Promise.all(this.listenerPromises);
      this.assertOpen();
      this.listenerPromises = [];
    }
    const relayEndpoint = normalizeNativeRelayEndpoint(endpoint);
    try {
      const advertisedCapabilities = await this.getStreamCapabilities().catch(() => null);
      this.assertOpen();
      this.startScheduled = true;
      await this.invokeOwned('start_voice_session', {
        endpoint: relayEndpoint,
        token,
        certHash,
        roomId: '',
        advertisedCapabilities,
        // The key every other participant wraps its frame keys to for this
        // call. The native session publishes it in its `SessionJoin`.
        mediaPublicKey: this.keyring.publicKey,
        // `call`, `listen` (no microphone until `startMicrophone`) or `view`
        // (the view slot, beside the call). See `SessionRole` in Rust.
        role: this.role,
      });
      this.assertOpen();
      await this.initializePublishedTrackListeners();
      this.assertOpen();
      await this.initializeMediaKeyListeners();
      this.assertOpen();
      await this.initializeTransportListeners();
      this.assertOpen();
      const tracks = await this.listPublishedTracks().catch(() => []);
      this.assertOpen();
      for (const track of tracks) {
        this.publishedTracks.set(`${track.streamId}:${track.trackId}`, track);
      }
      const participants = await this.listSessionParticipantCapabilities().catch(() => []);
      this.assertOpen();
      this.sessionParticipantCapabilities.clear();
      for (const participant of participants) {
        this.sessionParticipantCapabilities.set(participant.userId, participant);
        this.keyring.setPeerKey(participant.userId, participant.mediaPublicKey);
        if (participant.kind === 'viewer') this.viewerPeers.add(participant.userId);
      }
      // A view session sends nothing, so it has no key to announce.
      if (this.role !== 'view') await this.announceWrappedLocalSenderKeys();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `native session start failed (relay=${relayEndpoint}, source=${endpoint}): ${reason}`
      );
    }
  }

  disconnect(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disconnecting = true;
    this.removeAbortListener?.();
    this.removeAbortListener = null;
    this.transportLostCb = this.cameraFailureCb = this.screenShareEndedCb = null;
    this.clearVideoSubscriptions();
    this.clearScreenShareAudioSubscriptions();
    this.screenAudioActive = false;
    for (const unlisten of this.unlisteners) {
      try { unlisten(); } catch { /* attempt the remaining releases */ }
    }
    this.unlisteners = [];
    this.screenEventUnlisten = this.cameraEventUnlisten = this.transportLostUnlisten = null;
    this.publishedTracks.clear();
    this.sessionParticipantCapabilities.clear();
    this.viewerPeers.clear();
    this.rosterMembers.clear();
    this.participantLeaveListeners = [];
    this.frameTaps.clear();
    this.shownListeners.clear();
    this.shownListening = null;
    this.subscriptionRoutes.clear();
    for (const waiters of this.routeWaiters.values()) for (const settle of waiters) settle('no-track');
    this.routeWaiters.clear();
    // The call keys die with the call: they protect this conversation and
    // nothing else, so there is nothing to keep.
    this.keyring.dispose();
    this.publishedTrackListenersReady = false;
    this.localUserId = this.localRoomId = null;
    this.disposePromise = this.startScheduled
      ? this.invokeCleanup('stop_voice_session').then(() => undefined)
      : Promise.resolve();
    return this.disposePromise;
  }

  setMute(muted: boolean): void {
    void this.invokeOwned('voice_set_mute', { muted }).catch(() => {});
  }

  setDeaf(deafened: boolean): void {
    void this.invokeOwned('voice_set_deaf', { deafened }).catch(() => {});
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
    const actionRevision = ++this.cameraRevision;
    await tauriReady;
    this.assertOpen();
    if (enabled) {
      await this.ensureNativeCameraEventListener();
      if (actionRevision !== this.cameraRevision) throw new DOMException("Camera action canceled", "AbortError");
      // A failed open now rejects this invoke AND emits a camera error event.
      // Both used to reach the toaster, so one missing camera produced two
      // identical toasts. The rejection is the one the caller is waiting on, so
      // the event is muted for the duration of the attempt.
      this.cameraEnableInFlight = true;
      try {
        await this.invokeOwned('voice_enable_video', {
          enabled: true, actionRevision,
          deviceId: deviceId ?? null,
          quality: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logVoiceDiagnostic('[media] native camera enable failed', { error: message });
        this.cameraEnableFailure = { message, at: Date.now() };
        throw err instanceof Error ? err : new Error(message);
      } finally {
        this.cameraEnableInFlight = false;
      }
    } else {
      await this.invokeOwned('voice_enable_video', { enabled: false, actionRevision, deviceId: null, quality: null });
    }
  }

  /** Enumerate native capture cameras for device selection (contract CAM1). */
  async listCameraDevices(): Promise<Array<{ id: string; label: string }>> {
    await tauriReady;
    const devices = await this.invokeOwned('camera_list_devices');
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
    this.cameraEventUnlisten = await this.listenOwned('native_camera_event', (event) => {
      const payload = event.payload as { kind?: string; message?: string | null };
      if (payload.kind === 'error') {
        const message = payload.message ?? 'unknown camera error';
        logVoiceDiagnostic('[media] native camera error', { message });
        // The event and the invoke's rejection carry the same sentence, and the
        // two arrive in either order; the caller reports the rejection, so the
        // matching event is dropped rather than toasted a second time.
        if (this.isDuplicateOfReportedCameraEnableFailure(message)) return;
        this.cameraFailureCb?.(new Error(message));
      }
    });
    this.unlisteners.push(this.cameraEventUnlisten);
  }

  /**
   * True when this camera error is the one `enableVideo` is already reporting.
   * The event may land just before or just after the invoke rejects, so an
   * in-flight attempt suppresses unconditionally and a just-failed one
   * suppresses only the identical message.
   */
  private isDuplicateOfReportedCameraEnableFailure(message: string): boolean {
    if (this.cameraEnableInFlight) return true;
    const reported = this.cameraEnableFailure;
    return !!reported && reported.message === message && Date.now() - reported.at < 3000;
  }

  async startScreenShare(config: ScreenShareConfig): Promise<void> {
    const actionRevision = ++this.screenRevision;
    const assertAction = () => { this.assertOpen(); if (actionRevision !== this.screenRevision) throw new DOMException("Screen action canceled", "AbortError"); };
    await tauriReady;
    assertAction();

    if (!invoke) {
      throw new Error('Tauri IPC not available — cannot start screen share');
    }

    this.screenAudioActive = false;
    this.screenAudioError = null;
    await this.ensureNativeScreenShareEventListener();
    const resolvedCodec = config.preferredCodec ?? (await this.choosePreferredScreenCodec());
    if (!resolvedCodec) {
      throw new Error(
        'No locally displayable screen-share codec is available. The native encoder can produce video, ' +
          'but this desktop client has no native decoder and renderer for any codec it could send.',
      );
    }

    assertAction();
    const targetFps = config.maxFrameRate ?? 30;
    await this.invokeOwned('screen_share_start', {
      actionRevision,
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

    assertAction();
    if (config.audio) {
      const audioReady = await this.enableNativeScreenAudio(actionRevision);
      if (!audioReady) {
        // Fail loudly to the diagnostics log; the voice store surfaces the
        // video-only state AND the reason to the UI via
        // isScreenShareAudioActive() / getScreenShareAudioError() (W9/C4).
        logVoiceDiagnostic(
          '[media] native system audio capture unavailable; streaming video-only',
          { reason: this.screenAudioError ?? 'unknown' },
        );
      }
      assertAction();
      this.screenAudioActive = audioReady;
    } else {
      await this.invokeCleanup('voice_set_screen_audio_enabled', { enabled: false, actionRevision }).catch(() => { });
      this.screenAudioActive = false;
      this.screenAudioError = null;
    }
  }

  async updateScreenShareQuality(config: ScreenShareConfig): Promise<void> {
    this.assertOpen();
    await this.invokeOwned('screen_share_set_quality', {
      request: {
        maxFrameRate: config.maxFrameRate,
        maxWidth: config.maxWidth,
        maxHeight: config.maxHeight,
        maxBitrateBps: config.maxBitrateBps,
        contentHint: config.contentHint,
        captureAudio: config.audio,
      },
    });
  }

  async stopScreenShare(): Promise<void> {
    const actionRevision = ++this.screenRevision;
    this.screenAudioActive = false;
    if (!invoke) return;
    await this.invokeOwned('screen_share_stop', { actionRevision }).catch(() => { });
  }

  supportsNativeSourcePicker(): boolean {
    return true;
  }

  async listScreenShareSources(): Promise<ScreenShareSource[]> {
    await tauriReady;
    const sources = await this.invokeOwned('screen_share_list_sources');
    return (sources as ScreenShareSource[]) ?? [];
  }

  async getScreenShareSourceThumbnail(sourceId: string): Promise<ScreenShareThumbnail | null> {
    await tauriReady;
    const thumbnail = await this.invokeOwned('screen_share_source_thumbnail', { sourceId });
    return (thumbnail as ScreenShareThumbnail | null) ?? null;
  }

  isScreenShareAudioActive(): boolean {
    return this.screenAudioActive;
  }

  getScreenShareAudioError(): string | null {
    return this.screenAudioError;
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
      this.screenEventUnlisten = await this.listenOwned('native_screen_share_event', (event) => {
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
  private async enableNativeScreenAudio(actionRevision: number): Promise<boolean> {
    try {
      // Consent gate + enable the screen-audio track. Native capture starts with
      // screen_share_start's captureAudio flag; nothing streams over IPC here.
      // This resolves only once the capture device is actually open, so a `true`
      // here means audio really is being captured.
      await this.invokeOwned('voice_set_screen_audio_enabled', { enabled: true, actionRevision });
      this.screenAudioActive = true;
      this.screenAudioError = null;
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logVoiceDiagnostic('[media] native system audio enable failed', { error: reason });
      // Keep the backend's sentence: it names the sound server, the missing
      // capture source or the denied consent, which a generic "capture failed"
      // never did.
      this.screenAudioError = reason;
      if (actionRevision === this.screenRevision) this.disableNativeScreenAudio();
      return false;
    }
  }

  private disableNativeScreenAudio(): void {
    this.screenAudioActive = false;
    if (!invoke) return;
    // NOTE: screenAudioError is deliberately left alone here — this runs as the
    // cleanup half of a failed enable, and the reason is what the UI shows.
    this.invokeCleanup('voice_set_screen_audio_enabled', { enabled: false, actionRevision: this.screenRevision }).catch(() => {});
  }

  onSpeakingChange(cb: (speakers: Map<string, number>) => void): void {
    const p = tauriReady.then(async () => {
      const unlisten = await this.listenOwned('media_speaking_change', (event) => {
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

  /**
   * Your own microphone level, from the process that actually owns the capture
   * graph.
   *
   * The store's `startLocalMicAnalyzer` reads LiveKit's `room.localParticipant`
   * — an object this engine does not have — so on the desktop build, which is
   * the only build that runs this engine, `micInputLevel` and `micInputActive`
   * had no writer at all: the bar inside the mic button stayed at `width: 0%`
   * and the in-call "is my microphone working" readout answered nothing, for
   * every call, on real hardware that was capturing perfectly. The native side
   * measures the level on the same 10 Hz tick it already runs for remote
   * speakers, after the processing chain, so the bar shows what the far end
   * hears.
   */
  onLocalMicLevel(cb: (audioLevel: number, active: boolean) => void): void {
    const p = tauriReady.then(async () => {
      const unlisten = await this.listenOwned('media_local_mic_level', (event) => {
        const payload = event.payload as { audioLevel?: unknown; active?: unknown } | null;
        if (!payload || typeof payload !== 'object') return;
        const level = typeof payload.audioLevel === 'number' ? payload.audioLevel : 127;
        cb(level, payload.active === true);
      });
      this.unlisteners.push(unlisten);
    });
    this.listenerPromises.push(p);
  }

  /**
   * The microphone opened and then delivered no frames. Said once, in words, on
   * screen — silence was what made this take a day to find.
   */
  onMicFailure(cb: (message: string) => void): void {
    const p = tauriReady.then(async () => {
      const unlisten = await this.listenOwned('media_mic_silent', (event) => {
        if (typeof event.payload === 'string') cb(event.payload);
      });
      this.unlisteners.push(unlisten);
    });
    this.listenerPromises.push(p);
  }

  onParticipantJoin(cb: (userId: string) => void): void {
    const p = tauriReady.then(async () => {
      const unlisten = await this.listenOwned('media_participant_join', (event) => {
        const entry = readRosterEvent(event.payload);
        if (!entry) return;
        const { userId, kind } = entry;
        if (kind === 'viewer') {
          // A view session watching our stream is in the relay roster but not
          // in the call; the store is not told about it. A member that left
          // the call and now only watches has left the call.
          const wasMember = this.rosterMembers.has(userId);
          this.rosterMembers.delete(userId);
          this.viewerPeers.add(userId);
          if (wasMember && this.role !== 'view') this.participantLeaveListeners.forEach((leave) => leave(userId));
          return;
        }
        this.viewerPeers.delete(userId);
        this.rosterMembers.add(userId);
        cb(userId);
      });
      this.unlisteners.push(unlisten);
    });
    this.listenerPromises.push(p);
  }

  private matchParticipantDeparture(payload: unknown): string | null {
    if (typeof payload === 'string') return payload; // legacy native event
    if (!payload || typeof payload !== 'object') return null;
    const { userId, sessionId } = payload as { userId?: unknown; sessionId?: unknown };
    if (typeof userId !== 'string') return null;
    if (typeof sessionId === 'string' && this.sessionParticipantCapabilities.get(userId)?.sessionId !== sessionId) return null;
    return userId;
  }

  onParticipantLeave(cb: (userId: string) => void): void {
    this.participantLeaveListeners.push(cb);
    const p = tauriReady.then(async () => {
      const unlisten = await this.listenOwned('media_participant_leave', (event) => {
        const departed = this.matchParticipantDeparture(event.payload);
        if (!departed) return;
        this.viewerPeers.delete(departed);
        // A viewer was never in the call, so its leaving is not reported.
        if (!this.rosterMembers.delete(departed)) return;
        cb(departed);
      });
      this.unlisteners.push(unlisten);
    });
    this.listenerPromises.push(p);
  }

  onTransportLost(cb: (reason: string) => void): void {
    this.transportLostCb = cb;
  }

  /**
   * The in-place upgrade from listening in: the native session starts
   * capturing on `inputDeviceId` (the stable native id; `@default` is the
   * system default) on the same QUIC connection, and turns into a joined
   * member. The relay already accepts this member's media (`POST /mode`).
   */
  async startMicrophone(options?: { inputDeviceId?: string | null }): Promise<void> {
    this.assertOpen();
    if (this.role === 'call') return;
    if (this.role !== 'listen') throw new Error('Only a call that is listening in can start its microphone.');
    await this.invokeOwned('voice_switch_input_device', { deviceId: options?.inputDeviceId || '@default' });
    this.role = 'call';
  }


  // getVolume is retained for interface compatibility. Stream audio is decoded
  // and mixed natively (contract C4); volume is applied via setSourceVolume →
  // voice_set_source_volume on the audio actor.
  subscribeScreenShareAudio(userId: string, getVolume: () => number): () => void {
    if (this.disposed) return () => {};
    this.audioSubscriptionReleases.get(userId)?.();
    let stopped = false;
    this.screenShareAudioSubscribers.add(userId);
    // Apply the caller's current volume immediately and keep it in sync.
    this.setSourceVolume(userId, getVolume());
    const volumeTimer = setInterval(() => {
      if ((stopped || this.disposed || !this.screenShareAudioSubscribers.has(userId))) return;
      this.setSourceVolume(userId, getVolume());
    }, 100);

    void tauriReady.then(async () => {
      if ((stopped || this.disposed || !this.screenShareAudioSubscribers.has(userId))) {
        return;
      }
      const tracks = await this.listPublishedTracks().catch(() => []);
      const audioTrack = tracks.find(
        (track) =>
          String(track.publisherUserId) === userId &&
          track.trackId === 'screen-audio' &&
          track.kind === 'audio',
      );
      // Not published yet (a watch goes live before the relay describes the
      // sharer's tracks): `media_track_publish` subscribes when it arrives.
      if (audioTrack && !stopped) this.registerScreenAudioTrack(userId, audioTrack, false);
    });

    const release = () => {
      if (stopped) return;
      stopped = true;
      this.audioSubscriptionReleases.delete(userId);
      clearInterval(volumeTimer);
      this.screenShareAudioSubscribers.delete(userId);
      const registered = this.screenAudioRegistrations.get(userId);
      this.screenAudioRegistrations.delete(userId);
      if (registered) {
        void this.unregisterTrackSubscription(registered.streamId, registered.trackId).catch(() => {});
      }
    };
    this.audioSubscriptionReleases.set(userId, release);
    return release;
  }

  /**
   * Subscribe a stream-audio listener to its published track at the relay.
   * The relay forwards a track to a session only on a matching subscription,
   * so a watch that went live before the track was published is subscribed
   * here when it is. The decoded audio plays in the native mixer. `renew`
   * re-sends a subscription the listener already holds (the track changed);
   * without it an existing one is left alone, because the relay repeats a
   * track's publish after every key announce.
   */
  private registerScreenAudioTrack(userId: string, track: PublishedTrackDescriptor, renew: boolean): void {
    if (this.disposed || !this.screenShareAudioSubscribers.has(userId)) return;
    const current = this.screenAudioRegistrations.get(userId);
    if (!renew && current?.streamId === track.streamId && current.trackId === track.trackId) return;
    this.screenAudioRegistrations.set(userId, { streamId: track.streamId, trackId: track.trackId });
    void this.registerTrackSubscription({
      streamId: track.streamId,
      trackId: track.trackId,
      requestedLayer: 0,
    }).catch(() => {});
  }

  setSourceVolume(userId: string, gain: number): void {
    void tauriReady.then(() =>
      this.invokeOwned('voice_set_source_volume', {
        userId,
        ssrc: null,
        gain: Math.min(2, Math.max(0, gain)),
      }).catch(() => {}),
    );
  }

  private clearScreenShareAudioSubscriptions(): void {
    for (const release of this.audioSubscriptionReleases.values()) release();
    this.audioSubscriptionReleases.clear();
    this.screenShareAudioSubscribers.clear();
    this.screenAudioRegistrations.clear();
  }

  private async initializeTransportListeners(): Promise<void> {
    if (!listen) return;

    if (!this.transportLostUnlisten) {
      this.transportLostUnlisten = await this.listenOwned('media_transport_lost', (event) => {
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

    // BandwidthFeedback describes this publisher's UPLINK. Native encoders
    // consume it directly. Playback layers are chosen by the relay from each
    // viewer's downlink and explicit viewport/quality requests; never lower a
    // watched stream because this client is sending little (or no) video.
  }

  private capabilitiesPromise: Promise<MediaStreamCapabilities> | null = null;

  async getStreamCapabilities(): Promise<MediaStreamCapabilities> {
    await tauriReady;
    if (!this.capabilitiesPromise) {
      // The native side reports what this window can display: a codec's
      // `decode` is a native decoder AND a native renderer to draw it on
      // (capabilities.rs). The webview decodes nothing in the desktop app.
      this.capabilitiesPromise = this.invokeOwned('media_get_stream_capabilities').then(
        (capabilities) => capabilities as MediaStreamCapabilities,
        (error: unknown) => {
          // Not cached: the next caller asks again.
          this.capabilitiesPromise = null;
          throw error;
        },
      );
    }
    return this.capabilitiesPromise;
  }

  async getStreamingDiagnostics(): Promise<MediaStreamDiagnostics> {
    await tauriReady;
    const diagnostics = (await this.invokeOwned('media_get_stream_diagnostics')) as MediaStreamDiagnostics;
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
    const tracks = (await this.invokeOwned('media_list_published_tracks')) as PublishedTrackDescriptor[] | null;
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
    await this.invokeOwned('media_register_track_subscription', {
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
    await this.invokeCleanup('media_unregister_track_subscription', { streamId, trackId });
  }

  private clearVideoSubscriptions(): void {
    for (const release of this.videoSubscriptionReleases.values()) release();
    this.videoSubscriptionReleases.clear();
    for (const [, sub] of this.videoSubscriptions) {
      sub.stop();
    }
    this.videoSubscriptions.clear();
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
    signal?: AbortSignal,
  ): Promise<PublishedTrackDescriptor | null> {
    await this.initializePublishedTrackListeners();
    if (signal?.aborted || this.disposed) return null;
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
    if (signal?.aborted || this.disposed) return null;
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
        signal?.removeEventListener('abort', cancel);
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

      const cancel = () => finish(null);
      signal?.addEventListener('abort', cancel, { once: true });
      const timeoutId = window.setTimeout(() => finish(null), timeoutMs);
    });
  }

  private async initializePublishedTrackListeners(): Promise<void> {
    if (!listen) return;
    if (this.publishedTrackListenersReady) {
      return;
    }

    const publishUnlisten = await this.listenOwned('media_track_publish', (event) => {
      const track = event.payload as PublishedTrackDescriptor | null;
      if (!track?.streamId || !track.trackId) return;
      const previous = this.publishedTracks.get(`${track.streamId}:${track.trackId}`);
      this.publishedTracks.set(`${track.streamId}:${track.trackId}`, track);
      this.notifyPublishedVideoTrackWaiters(track);
      if (String(track.publisherUserId) === String(this.localUserId ?? '')) {
        void this.announceWrappedTrackKey(track).catch(error => this.failKeyExchange(error));
      }
      const userId = String(track.publisherUserId);
      if (track.trackId === 'screen-audio' && track.kind === 'audio') {
        this.registerScreenAudioTrack(userId, track, !previous || !samePublishedTrack(previous, track));
        return;
      }
      const existing =
        this.videoSubscriptions.get(`${userId}:${track.trackId}`) ??
        (track.trackId === 'screen' || track.trackId === 'camera'
          ? this.videoSubscriptions.get(userId)
          : undefined);
      if (!existing) {
        return;
      }
      // The relay repeats a remote track's publish after each key announce for
      // it; an unchanged track keeps its subscription as it is (see the
      // browser engine's `track_publish`).
      if (
        previous && existing.streamId === track.streamId && existing.trackId === track.trackId
        && samePublishedTrack(previous, track)
      ) {
        return;
      }
      // Don't overwrite a camera subscription with a screen publish (or vice versa)
      // when both are active under distinct keys.
      if (existing.trackId && existing.trackId !== track.trackId && this.videoSubscriptions.has(`${userId}:${existing.trackId}`)) {
        return;
      }
      const viewport = canvasViewport(existing.canvas);
      const selectedLayer = selectPublishedLayer(track, viewport.width, viewport.height);
      if (!selectedLayer) {
        return;
      }
      existing.streamId = track.streamId;
      existing.trackId = track.trackId;
      existing.activeLayer = selectedLayer.layerId;
      void this.registerTrackSubscription({
        streamId: track.streamId,
        trackId: track.trackId,
        requestedLayer: selectedLayer.layerId,
        viewport,
      }).catch(() => {});
    });

    const unpublishUnlisten = await this.listenOwned('media_track_unpublish', (event) => {
      const payload = event.payload as { streamId?: string; trackId?: string } | null;
      if (!payload?.streamId || !payload.trackId) return;
      this.publishedTracks.delete(`${payload.streamId}:${payload.trackId}`);
    });

    this.publishedTrackListenersReady = true;
    this.unlisteners.push(publishUnlisten, unpublishUnlisten);
  }

  private async initializeMediaKeyListeners(): Promise<void> {
    if (!listen) return;

    const audioKeyUnlisten = await this.listenOwned('media_key_deliver', (event) => {
      const payload = event.payload as {
        senderUserId?: string;
        epoch?: number;
        ciphertext?: number[];
      } | null;
      if (!payload?.senderUserId || payload.epoch == null || !Array.isArray(payload.ciphertext)) {
        return;
      }
      void this.keyring
        .unwrapSenderKey(
          this.audioKeyScope(),
          payload.senderUserId,
          Uint8Array.from(payload.ciphertext),
        )
        .then((decrypted) =>
          // Null: the sender left the call before its key could be opened.
          decrypted &&
          this.invokeOwned('media_apply_audio_sender_key', {
            senderUserId: payload.senderUserId,
            epoch: decrypted.epoch || payload.epoch,
            rawKey: Array.from(decrypted.rawKey),
          }),
        )
        .catch(error => this.failKeyExchange(error));
    });

    const streamKeyUnlisten = await this.listenOwned('media_stream_key_deliver', (event) => {
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
      void this.keyring
        .unwrapSenderKey(
          this.trackKeyScope(payload.streamId, payload.trackId),
          payload.senderUserId,
          Uint8Array.from(payload.ciphertext),
        )
        .then((decrypted) =>
          // Null: the publisher left the call before its key could be opened.
          decrypted &&
          this.invokeOwned('media_apply_track_sender_key', {
            streamId: payload.streamId,
            trackId: payload.trackId,
            epoch: decrypted.epoch || payload.epoch,
            rawKey: Array.from(decrypted.rawKey),
          }),
        )
        .catch(error => this.failKeyExchange(error));
    });
    // The native session decides, per roster change, which keys rotate and
    // which must go out to whom (a member's arrival or departure: every key; a
    // viewer's departure: the viewable stream's; a viewer's arrival: the
    // viewable stream's current keys to it alone). It rotates first and then
    // asks for the announcement; this side holds the call keys and wraps.
    const announceUnlisten = await this.listenOwned('media_announce_sender_keys', (event) => {
      if (this.role === 'view') return;
      const request = readAnnounceRequest(event.payload);
      if (!request) return;
      void this.announceRequestedSenderKeys(request).catch(error => this.failKeyExchange(error));
    });
    const participantJoinDetailsUnlisten = await this.listenOwned('media_participant_join_details', (event) => {
      const payload = event.payload as SessionParticipantCapabilities | null;
      if (!payload?.userId || payload.userId === String(this.localUserId ?? '')) {
        return;
      }
      const kind = readRosterKind(payload.kind);
      if (!kind) return;
      this.sessionParticipantCapabilities.set(payload.userId, { ...payload, kind });
      if (kind === 'viewer') this.viewerPeers.add(payload.userId);
      else this.viewerPeers.delete(payload.userId);
      this.keyring.setPeerKey(payload.userId, payload.mediaPublicKey);
    });
    const participantLeaveUnlisten = await this.listenOwned('media_participant_leave', (event) => {
      const userId = this.matchParticipantDeparture(event.payload);
      if (!userId) return;
      this.sessionParticipantCapabilities.delete(userId);
      this.keyring.removePeer(userId);
    });
    const requestStreamKeyUnlisten = await this.listenOwned('media_request_stream_key', (event) => {
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
      void this.announceWrappedTrackKey(track, [payload.recipientUserId]).catch(error => this.failKeyExchange(error));
    });

    this.unlisteners.push(
      audioKeyUnlisten,
      streamKeyUnlisten,
      announceUnlisten,
      participantJoinDetailsUnlisten,
      participantLeaveUnlisten,
      requestStreamKeyUnlisten,
    );
  }

  /**
   * A tap on one remote track (see `MediaEngine.tapVideoFrames`).
   *
   * In the desktop app every track is decoded and drawn natively, so no frame
   * ever reaches JavaScript and `onFrame` is never called: the route is
   * `native-surface` (or why there is none), and samplers read stills
   * ({@link readVideoStill}). The tap still matters: it keeps the track
   * decoded. One subscription per track exists on this engine, so a tap rides
   * whatever subscription shows the track, and when none does it runs a
   * headless one: a sampler with no surface, lowest layer, paused only while
   * the window is hidden.
   */
  tapVideoFrames(
    userId: string,
    trackId: 'camera' | 'screen',
    onFrame: (frame: VideoFrame) => void,
  ): VideoFrameTap {
    if (this.disposed) return { route: Promise.resolve<VideoTapRoute>('no-track'), release: () => {} };
    const key = `${userId}:${trackId}`;
    let taps = this.frameTaps.get(key);
    if (!taps) { taps = new Set(); this.frameTaps.set(key, taps); }
    taps.add(onFrame);
    const route = new Promise<VideoTapRoute>((resolve) => {
      const known = this.subscriptionRoutes.get(key);
      if (known) { resolve(known); return; }
      let waiters = this.routeWaiters.get(key);
      if (!waiters) { waiters = new Set(); this.routeWaiters.set(key, waiters); }
      waiters.add(resolve);
    });
    if (!this.videoSubscriptionReleases.has(key)) this.startHeadlessSubscription(userId, trackId);
    let released = false;
    return {
      route,
      release: () => {
        if (released) return;
        released = true;
        const current = this.frameTaps.get(key);
        current?.delete(onFrame);
        if (current && current.size > 0) return;
        this.frameTaps.delete(key);
        if (this.headlessKeys.has(key)) this.videoSubscriptionReleases.get(key)?.();
      },
    };
  }

  /** Subscription keys whose current subscription is a headless tap. */
  private headlessKeys = new Set<string>();

  private startHeadlessSubscription(userId: string, trackId: 'camera' | 'screen'): void {
    if (this.disposed || typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    this.headlessKeys.add(`${userId}:${trackId}`);
    this.subscribeVideo(userId, canvas, undefined, { preferredTrackId: trackId, headless: true });
  }

  private settleRoute(key: string, route: VideoTapRoute): void {
    this.subscriptionRoutes.set(key, route);
    const waiters = this.routeWaiters.get(key);
    if (!waiters) return;
    this.routeWaiters.delete(key);
    for (const settle of waiters) settle(route);
  }

  /** A still of a natively drawn track (see `MediaEngine.readVideoStill`). */
  readVideoStill(
    userId: string,
    trackId: 'camera' | 'screen',
    maxWidth: number,
    maxHeight: number,
    afterSeq?: number,
  ): Promise<VideoStill | null> {
    const track = this.pickPublishedVideoTrack(userId, [...this.publishedTracks.values()], trackId);
    if (!track) return Promise.resolve(null);
    return this.readTrackStill(track.streamId, track.trackId, maxWidth, maxHeight, afterSeq);
  }

  private async readTrackStill(
    streamId: string,
    trackId: string,
    maxWidth: number,
    maxHeight: number,
    afterSeq?: number,
  ): Promise<VideoStill | null> {
    await tauriReady;
    const raw = await invoke(NATIVE_STILL_COMMAND, {
      streamId,
      trackId,
      maxWidth: Math.max(1, Math.round(maxWidth)),
      maxHeight: Math.max(1, Math.round(maxHeight)),
      afterSeq: afterSeq ?? null,
    });
    const still = parseNativeStill(raw);
    if (still.status !== 'still') return null;
    return { bitmap: await nativeStillBitmap(still), seq: still.seq };
  }

  /** Reveal confirmations (`native_render_shown`) by surface id. */
  private shownListeners = new Map<number, (generation: number) => void>();
  private shownListening: Promise<void> | null = null;

  private ensureShownListener(): Promise<void> {
    if (!this.shownListening) {
      this.shownListening = this.listenOwned('native_render_shown', (event) => {
        const payload = event.payload as { surfaceId?: number; generation?: number } | null;
        if (typeof payload?.surfaceId !== 'number' || typeof payload.generation !== 'number') return;
        this.shownListeners.get(payload.surfaceId)?.(payload.generation);
      }).then((unlisten) => {
        this.unlisteners.push(unlisten);
      });
    }
    return this.shownListening;
  }

    /**
   * Show one remote track (or our own, the self-view) in `canvas`'s box.
   *
   * The desktop app has one video route (docs/glass-spec.md §2): the native
   * side decodes the track and draws it on a platform surface under the
   * webview that mirrors `canvas`'s box ({@link NativeVideoTile}); the page
   * shows it through a hole and the canvas carries the poster while the hole is
   * closed. Nothing is decoded in the webview and no frame crosses IPC. A
   * window whose renderer did not install has no route at all: the
   * subscription fails loudly with the reason, and the tile shows its notice.
   *
   * A `headless` subscription (a tap with no tile) attaches a sampler instead:
   * the track is decoded at the lowest layer and only its stills are kept.
   */
  subscribeVideo(
    userId: string,
    canvas: HTMLCanvasElement,
    onFrame?: () => void,
    options?: SubscribeVideoOptions & { headless?: boolean },
  ): () => void {
    if (this.disposed) return () => {};
    let disposed = false;
    const cancellation = new AbortController();
    const teardowns: Array<() => void> = [];
    const own = (cleanup: () => void) => { if (disposed) cleanup(); else teardowns.push(cleanup); };
    let ownedSubscription: NativeVideoSubscription | null = null;
    const preferredTrackId = options?.preferredTrackId;
    const headless = options?.headless === true;
    const fit = options?.fit;
    const anchor = options?.anchor;
    // Camera and screen can be subscribed concurrently for the same publisher;
    // key the map so they don't tear each other down.
    const subscriptionKey = preferredTrackId ? `${userId}:${preferredTrackId}` : userId;
    // Replacing the subscription for this track (a surface taking over from a
    // headless tap, or one surface from another) must not restart a headless
    // one in between: see `release` below.
    this.replacingKey = subscriptionKey;
    try {
      this.videoSubscriptionReleases.get(subscriptionKey)?.();
      const existing = this.videoSubscriptions.get(subscriptionKey);
      if (existing) {
        existing.stop();
        this.videoSubscriptions.delete(subscriptionKey);
      }
    } finally {
      this.replacingKey = null;
    }
    if (headless) this.headlessKeys.add(subscriptionKey);
    else this.headlessKeys.delete(subscriptionKey);
    this.subscriptionRoutes.delete(subscriptionKey);

    const release = () => {
      if (disposed) return;
      disposed = true;
      cancellation.abort();
      for (const teardown of teardowns.splice(0)) teardown();
      if (this.videoSubscriptionReleases.get(subscriptionKey) === release) {
        this.videoSubscriptionReleases.delete(subscriptionKey);
        this.subscriptionRoutes.delete(subscriptionKey);
        if (headless) this.headlessKeys.delete(subscriptionKey);
        // The last surface went away while taps still sample this track: keep
        // it decoded on a headless subscription of their own.
        if (!headless && !this.disposed && this.replacingKey !== subscriptionKey
            && preferredTrackId && this.frameTaps.get(subscriptionKey)?.size) {
          queueMicrotask(() => {
            if (!this.disposed && !this.videoSubscriptionReleases.has(subscriptionKey)
                && this.frameTaps.get(subscriptionKey)?.size) {
              this.startHeadlessSubscription(userId, preferredTrackId);
            }
          });
        }
      }
      const current = this.videoSubscriptions.get(subscriptionKey);
      if (current && current === ownedSubscription) {
        if (current.streamId && current.trackId) {
          void this.unregisterTrackSubscription(current.streamId, current.trackId).catch(() => {});
        }
        current.stop();
        this.videoSubscriptions.delete(subscriptionKey);
      }
    };
    this.videoSubscriptionReleases.set(subscriptionKey, release);

    void tauriReady.then(async () => {
      if (disposed) return;
      try {
        logVoiceDiagnostic('[media] starting native remote video subscription', {
          userId,
          preferredTrackId: preferredTrackId ?? null,
        });
        const publishedTrack = await this.waitForPublishedVideoTrack(
          userId,
          10000,
          preferredTrackId,
          cancellation.signal,
        );
        let subscription: NativeVideoSubscription;
        const markFrame = () => onFrame?.();
        const capabilities = publishedTrack && !disposed
          ? await this.getStreamCapabilities().catch((error: unknown) => {
            logVoiceDiagnostic('[media] stream capabilities unavailable', {
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
          : null;
        if (!publishedTrack || disposed) {
          if (!disposed) {
            logVoiceDiagnostic('[media] no published native track announced before subscription timeout', {
              userId,
            });
            this.settleRoute(subscriptionKey, 'no-track');
          }
          subscription = { canvas, stop: () => {} };
        } else if (!capabilities?.nativeDesktopRenderer) {
          // No renderer, no route: the desktop app has no other way to draw
          // video, so say so loudly instead of showing an empty tile.
          const reason = capabilities?.nativeRendererError
            ?? 'the native video renderer is not available in this window';
          console.error(`[media] cannot show ${userId}'s ${publishedTrack.trackId}: ${reason}`);
          logVoiceDiagnostic('[media] no render route for video track', {
            userId,
            streamId: publishedTrack.streamId,
            trackId: publishedTrack.trackId,
            reason,
          });
          this.settleRoute(subscriptionKey, 'no-route');
          subscription = {
            canvas,
            streamId: publishedTrack.streamId,
            trackId: publishedTrack.trackId,
            stop: () => {},
          };
        } else {
          const streamId = publishedTrack.streamId;
          const trackId = publishedTrack.trackId;
          // A sampler asks for the lowest layer: it only feeds stills.
          const viewport = headless ? { width: 1, height: 1 } : canvasViewport(canvas);
          const selectedLayer = selectPublishedLayer(publishedTrack, viewport.width, viewport.height);
          const setDecoding = (visible: boolean) => {
            void this.invokeOwned('media_set_stream_visibility', { streamId, trackId, visible }).catch((err) => {
              logVoiceDiagnostic('[media] media_set_stream_visibility failed', {
                streamId,
                trackId,
                visible,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          };
          const registerRelay = () =>
            this.registerTrackSubscription({
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

          if (headless) {
            // A tap with no tile: a sampler surface with no toolkit window
            // (`native_render_attach_sampler`), fed by the relay subscription at
            // the layer the 1x1 viewport selects (the lowest). Paused only
            // while the window is hidden.
            let samplerSurfaceId: number | null = null;
            let samplerStopped = false;
            const detachSampler = () => {
              samplerStopped = true;
              if (samplerSurfaceId === null) return;
              const surfaceId = samplerSurfaceId;
              samplerSurfaceId = null;
              void this.invokeCleanup('native_render_detach', { surfaceId }).catch(() => {});
            };
            own(detachSampler);
            const visibility = attachDocumentVisibilityControls(setDecoding);
            own(() => visibility.cleanup());
            subscription = {
              canvas,
              streamId,
              trackId,
              activeLayer: selectedLayer?.layerId,
              stop: detachSampler,
            };
            await registerRelay();
            try {
              const attached = (await this.invokeOwned('native_render_attach_sampler', { streamId, trackId })) as {
                surfaceId?: number;
              } | null;
              if (typeof attached?.surfaceId !== 'number') {
                throw new Error('native_render_attach_sampler did not return a surfaceId');
              }
              samplerSurfaceId = attached.surfaceId;
              // Stopped while the attach was in flight: let the late surface go.
              if (samplerStopped) detachSampler();
            } catch (err) {
              // Loud, and the room says it is waiting (spec §3.7): never a quiet fallback.
              console.error('[media] native_render_attach_sampler failed; nothing can sample this stream', {
                userId,
                streamId,
                trackId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            // Released during the setup above: `release` found nothing to
            // unregister, and the generic check below only stops the subscription.
            // A visible surface may already have replaced this sampler while
            // attach was pending. Its relay subscription belongs to it now.
            if (disposed) {
              if (!this.videoSubscriptionReleases.has(subscriptionKey)) {
                void this.unregisterTrackSubscription(streamId, trackId).catch(() => {});
              }
            } else {
              this.settleRoute(subscriptionKey, 'native-surface');
            }
          } else {
            // The tile tells its component (the stage's stream box or a camera
            // tile) when the hole over its surface may open, and when it must
            // close (styles/layout.css, stage/nativeUnderlay.ts).
            const dispatchUnderlayVisibility = (visible: boolean) => {
              canvas.dispatchEvent(
                new CustomEvent('paracord:native-surface-visibility', {
                  detail: { visible },
                  bubbles: true,
                }),
              );
            };
            await this.ensureShownListener();
            const nativeTile = new NativeVideoTile({
              element: canvas,
              streamId,
              trackId,
              // The surface places the picture as the tile asks (cover for
              // camera tiles, cropped around the anchor).
              fit,
              anchor,
              invoke: async (command, args) => {
                if (command === 'native_render_attach') {
                  this.assertOpen();
                  await tauriReady;
                  this.assertOpen();
                }
                // Tile.attach owns a late returned surface id and detaches it
                // if destroyed. Do not throw away that cleanup receipt here.
                return this.invokeCleanup(command, args);
              },
              listenShown: (surfaceId, onShown) => {
                this.shownListeners.set(surfaceId, onShown);
                return () => {
                  if (this.shownListeners.get(surfaceId) === onShown) this.shownListeners.delete(surfaceId);
                };
              },
              readStill: async (maxWidth, maxHeight) =>
                (await this.readTrackStill(streamId, trackId, maxWidth, maxHeight))?.bitmap ?? null,
              onVisibilityChange: (visible) => {
                // Flips are rare and load-bearing (a closed hole shows the
                // poster), so each one goes to the diagnostics log.
                logVoiceDiagnostic('[media] native tile visibility', { streamId, trackId, visible });
                dispatchUnderlayVisibility(visible);
              },
              // Off screen or a hidden window pauses the decoder (contract C2);
              // a covered tile keeps decoding so it comes back current.
              onActiveChange: (active) => {
                logVoiceDiagnostic('[media] native tile decoding', { streamId, trackId, active });
                setDecoding(active);
              },
            });
            await registerRelay();
            // The webview sees no frames on this route; the native side emits a
            // one-time first-presented-frame event per surface. That is the
            // tile's "the track is live" edge, and the moment its first poster
            // can be read.
            const firstFrameUnlisten = await this.listenOwned('media_native_render_first_frame', (event) => {
              const payload = event.payload as { streamId?: string; trackId?: string } | null;
              if (payload?.streamId !== streamId || payload?.trackId !== trackId) return;
              markFrame();
              nativeTile.refreshPoster();
            });
            this.unlisteners.push(firstFrameUnlisten);
            // Failure law (spec §3.7): a surface that cannot be created or kept
            // is a loud, user-visible subscription error. Tear the subscription
            // down when the native side names this track.
            const failureUnlisten = await this.listenOwned('media_native_render_failed', (event) => {
              const payload = event.payload as { streamId?: string; trackId?: string; reason?: string } | null;
              if (payload?.streamId !== streamId || payload?.trackId !== trackId) return;
              const reason = payload?.reason ?? 'unknown native render failure';
              console.error('[media] native video failed; the subscription is torn down', {
                userId,
                streamId,
                trackId,
                reason,
              });
              logVoiceDiagnostic('[media] native surface render failed', { userId, streamId, trackId, reason });
              const current = this.videoSubscriptions.get(subscriptionKey);
              if (current === subscription) {
                current.stop();
                this.videoSubscriptions.delete(subscriptionKey);
              }
            });
            this.unlisteners.push(failureUnlisten);
            subscription = {
              canvas,
              streamId,
              trackId,
              activeLayer: selectedLayer?.layerId,
              nativeTile,
              stop: () => {
                firstFrameUnlisten();
                failureUnlisten();
                // Closes the hole (onVisibilityChange(false)) before the
                // surface goes.
                nativeTile.destroy();
              },
            };
            this.settleRoute(subscriptionKey, 'native-surface');
            // Create the surface now. A subscribe-time attach failure is loud and
            // leaves the tile's notice/poster showing (spec §3.7).
            try {
              await nativeTile.attach();
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (!disposed) {
                console.error('[media] native_render_attach failed; this video cannot be shown (spec §3.7)', {
                  userId,
                  streamId,
                  trackId,
                  error: message,
                });
              }
              logVoiceDiagnostic('[media] native_render_attach failed', { userId, streamId, trackId, error: message });
            }
          }
        }
        // The relay's per-viewer layer choice is capped by the tile's size
        // (spec §4.2/I4): keep its viewport hint current as the tile resizes.
        if (!disposed && !headless && typeof ResizeObserver !== 'undefined') {
          let resizeTimer: ReturnType<typeof setTimeout> | null = null;
          const updateViewportSubscription = () => {
            const current = this.videoSubscriptions.get(subscriptionKey);
            if (!current?.streamId || !current.trackId || !current.nativeTile) return;
            void this.registerTrackSubscription({
              streamId: current.streamId,
              trackId: current.trackId,
              viewport: canvasViewport(canvas),
            }).catch(() => {});
          };
          const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(updateViewportSubscription, 120);
          });
          resizeObserver.observe(canvas);
          own(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
          });
        }
        const originalStop = subscription.stop;
        subscription.stop = () => {
          for (const teardown of teardowns.splice(0)) {
            teardown();
          }
          originalStop();
        };
        // The consumer may have unsubscribed while the async setup above was in
        // flight (waitForPublishedVideoTrack can block up to 10s). The
        // unsubscribe closure already ran and found no map entry to stop, so
        // drop this subscription instead of storing it.
        if (disposed) {
          subscription.stop();
          return;
        }
        ownedSubscription = subscription;
        this.videoSubscriptions.set(subscriptionKey, subscription);
      } catch (err) {
        release();
        // A tap waiting on this track learns there is no route rather than
        // waiting forever; the diagnostic below says why.
        this.settleRoute(subscriptionKey, 'no-route');
        this.subscriptionRoutes.delete(subscriptionKey);
        logVoiceDiagnostic('[media] failed to start native remote video subscription', {
          userId,
          preferredTrackId: preferredTrackId ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return release;
  }

  subscribeLocalPublishedScreen(canvas: HTMLCanvasElement, onFrame?: () => void): () => void {
    if (!this.localUserId) {
      return () => {};
    }
    // The self-view is a tile like any other: the native side decodes the
    // exact bitstream viewers receive (from the encoder, never the relay) and
    // draws it on a surface.
    return this.subscribeVideo(this.localUserId, canvas, onFrame);
  }

  private async listSessionParticipantCapabilities(): Promise<SessionParticipantCapabilities[]> {
    await tauriReady;
    const participants = await this.invokeOwned('media_list_session_participant_capabilities');
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

  /**
   * The native roster now, by id. Each entry's kind (member or viewer) is
   * recorded as it arrives, so the recipient filters below always know it.
   */
  private async listSessionParticipants(): Promise<string[]> {
    await tauriReady;
    const participants = (await this.invokeOwned('media_list_session_participant_capabilities')) as
      | SessionParticipantCapabilities[]
      | null;
    const ids: string[] = [];
    for (const participant of participants ?? []) {
      if (!participant?.userId || participant.userId === String(this.localUserId ?? '')) continue;
      const kind = readRosterKind(participant.kind);
      // An entry of a kind this client does not know is never wrapped for.
      if (!kind) continue;
      if (kind === 'viewer') this.viewerPeers.add(participant.userId);
      else this.viewerPeers.delete(participant.userId);
      ids.push(participant.userId);
    }
    return ids;
  }

  private isViewerPeer(userId: string): boolean {
    return this.viewerPeers.has(userId);
  }

  /** Announce what the native session asked for (see `media_announce_sender_keys`). */
  private async announceRequestedSenderKeys(request: AnnounceRequest): Promise<void> {
    const recipients = request.recipients ?? (await this.listSessionParticipants());
    if (!recipients.length) return;
    if (request.voice) await this.announceWrappedAudioSenderKey(recipients);
    for (const { streamId, trackId } of request.tracks) {
      const track = this.publishedTracks.get(`${streamId}:${trackId}`);
      // Not published to this side yet: its publish event announces it.
      if (!track || String(track.publisherUserId) !== String(this.localUserId ?? '')) continue;
      await this.announceWrappedTrackKey(track, recipients);
    }
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
      this.keyring,
      this.account,
    );
    return wrapped.map((entry) => ({
      recipientUserId: entry.recipientUserId,
      ciphertext: Array.from(entry.wrapped),
    }));
  }

  private async announceWrappedAudioSenderKey(
    recipientUserIds?: string[],
  ): Promise<void> {
    // The voice key goes to call members only, never to a viewer.
    const recipients = keyRecipients(
      { kind: 'voice' },
      recipientUserIds ?? (await this.listSessionParticipants()),
      (userId) => this.isViewerPeer(userId),
    );
    if (!recipients.length) {
      return;
    }
    const senderKey = (await this.invokeOwned('media_export_audio_sender_key')) as ExportedSenderKey;
    const encryptedKeys = await this.buildWrappedRecipients(
      this.audioKeyScope(),
      senderKey,
      recipients,
    );
    if (!encryptedKeys.length) {
      return;
    }
    await this.invokeOwned('media_send_audio_key_announce', {
      epoch: senderKey.epoch,
      encryptedKeys,
    });
  }

  private async announceWrappedTrackKey(
    track: PublishedTrackDescriptor,
    recipientUserIds?: string[],
  ): Promise<void> {
    // A track key goes to call members, and to viewers only for the stream
    // they may watch.
    const recipients = keyRecipients(
      { kind: 'track', streamId: track.streamId },
      recipientUserIds ?? (await this.listSessionParticipants()),
      (userId) => this.isViewerPeer(userId),
    );
    if (!recipients.length) {
      return;
    }
    const senderKey = (await this.invokeOwned('media_export_track_sender_key', {
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
    await this.invokeOwned('media_send_track_key_announce', {
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
