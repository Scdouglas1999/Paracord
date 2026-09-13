import { create } from 'zustand';
import type { VoiceState } from '../types';
import { createCallVoiceApi, type VoiceJoinResponse } from '../api/voice';
import { captureOperationContext } from '../lib/operationContext';
import { accountScopeKey, type AccountScope } from '../lib/serverScope';
import { subscribeServerDisconnect } from '../lib/serverDisconnect';
import { gateway } from '../gateway/manager';
import { CallSession, type CallPhase } from './voice/callSession';
import {
  Room,
  RoomEvent,
  ParticipantEvent,
  Track,
  LogLevel,
  setLogLevel,
  DisconnectReason,
  ConnectionState,
  AudioPresets,
  createAudioAnalyser,
  type AudioCaptureOptions,
  type Participant,
  type RemoteParticipant,
  type LocalParticipant,
  type LocalAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication,
  type TrackPublication,
} from 'livekit-client';
import { useAuthStore } from './authStore';
import { playVoiceJoinSound, playVoiceLeaveSound } from '../lib/features/voiceSounds';
import { isTauri } from '../lib/tauriEnv';
import { NoiseGateProcessor } from '../lib/noiseGate';
import {
  allowNativeToLivekitFallback,
  buildLivekitConnectCandidates,
  findReachableLivekitUrl,
  normalizeLivekitUrl,
  normalizeLivekitUrlFromServerValue,
} from './voice/livekitController';
import { computeConnectRetryDelayMs, isTransientVoiceConnectError } from './voice/reconnect';
import { computeSpeaking, isStallWarningInterval, smoothVolume } from './voice/timers';
import { switchNativeOutputDevice, switchNativeInputDevice } from './voice/nativeMediaController';
import { useToastStore } from './toastStore';
import { logVoiceDiagnostic } from '../lib/desktopDiagnostics';
import type { MediaEngine } from '../lib/media/mediaEngine';
import { createMediaEngine } from '../lib/media/mediaEngine';
import { registerSessionReset } from './sessionReset';
const SYSTEM_AUDIO_PRIVACY_ACK_KEY = 'paracord:system-audio-privacy-ack';

function hasAcknowledgedSystemAudioPrivacyWarning(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(SYSTEM_AUDIO_PRIVACY_ACK_KEY) === '1';
}

function persistSystemAudioPrivacyWarningAcknowledgement(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SYSTEM_AUDIO_PRIVACY_ACK_KEY, '1');
}

const attachedRemoteAudioElements = new Map<string, HTMLAudioElement>();
let localMicAnalyserInterval: ReturnType<typeof setInterval> | null = null;
let localMicAnalyserCleanup: (() => Promise<void>) | null = null;
let localMicAnalyserRoom: Room | null = null;
let localMicSpeakingFallback = false;
let localMicSmoothedVolume = 0;
let localMicUiLastUpdateAt = 0;
let selectedAudioOutputDeviceId: string | undefined;
let localAudioUplinkMonitorInterval: ReturnType<typeof setInterval> | null = null;
let localAudioUplinkMonitorRoom: Room | null = null;
let localAudioLastBytesSent: number | null = null;
let localAudioStalledIntervals = 0;
let localAudioRecoveryInFlight = false;
let localSilenceRecoveryCooldownUntil = 0;
let remoteAudioReconcileInterval: ReturnType<typeof setInterval> | null = null;
let remoteAudioReconcileRoom: Room | null = null;
const invalidAudioInputDeviceIds = new Set<string>();
let forceRedForCompatibility = false;
let audioCodecSwitchCooldownUntil = 0;
let activeRoomListenerCleanup: (() => void) | null = null;
// When true, all voice <audio> elements are suppressed (muted + tracks disabled)
// to prevent voice chat audio from being captured by the system audio loopback
// and echoed back through the live stream.
let voiceSuppressedForStream = false;
let currentCall: CallSession | null = null;
const roomOwners = new WeakMap<Room, { owner: CallSession; active: boolean }>();
const callReleasePromises = new WeakMap<CallSession, Promise<void>>();

function isCurrentRoom(room: Room): boolean {
  const lease = roomOwners.get(room);
  return !!lease?.active && lease.owner.current;
}
function currentCallUser() { return currentCall?.context.user ?? null; }
function callApi(owner = currentCall) {
  if (!owner) throw new Error('Voice connection is not ready');
  return createCallVoiceApi(owner.context, () => owner.membershipSessionId);
}
const TAURI_FAST_CONNECT = isTauri();
const LIVEKIT_CONNECT_OPTIONS = TAURI_FAST_CONNECT
  ? ({
    // Desktop WebView can stall for long periods on failed signal handshakes.
    // Keep internal retries minimal and let our outer candidate retry loop run.
    maxRetries: 0,
    websocketTimeout: 10_000,
    peerConnectionTimeout: 12_000,
  } as const)
  : ({
    maxRetries: 4,
    websocketTimeout: 45_000,
    peerConnectionTimeout: 50_000,
  } as const);
const LIVEKIT_CONNECT_ATTEMPTS_PER_CANDIDATE = TAURI_FAST_CONNECT ? 1 : 2;
const LIVEKIT_CONNECT_RETRY_BASE_DELAY_MS = TAURI_FAST_CONNECT ? 250 : 400;
const LIVEKIT_CONNECT_ATTEMPT_TIMEOUT_MS = TAURI_FAST_CONNECT ? 12_000 : 25_000;
type MicUplinkState = 'idle' | 'sending' | 'stalled' | 'recovering' | 'muted' | 'no_track';
let livekitLogConfigured = false;
let livekitHeartbeatLogged = false;
let livekitHeartbeatClientMissingLogged = false;

type LivekitSignalClientInternals = {
  pingTimeoutDuration?: number;
  pingIntervalDuration?: number;
};

function ensureSafeLivekitPingTimeout(
  signalClient: LivekitSignalClientInternals,
  context: string
): boolean {
  const pingTimeout = signalClient.pingTimeoutDuration;
  const pingInterval = signalClient.pingIntervalDuration;
  if (
    !livekitHeartbeatLogged &&
    typeof pingTimeout === 'number' &&
    typeof pingInterval === 'number'
  ) {
    livekitHeartbeatLogged = true;
    console.info('[voice] LiveKit signal heartbeat config:', {
      context,
      pingTimeoutSeconds: pingTimeout,
      pingIntervalSeconds: pingInterval,
    });
  }

  if (typeof pingTimeout !== 'number' || typeof pingInterval !== 'number') return false;
  // Guard against overly aggressive timeout settings that can race with the
  // next ping tick and cause false disconnects under minor timer jitter.
  if (pingTimeout > pingInterval + 1) return false;

  const adjustedTimeout = Math.max(pingTimeout, pingInterval * 3, 15);
  if (adjustedTimeout <= pingTimeout) return false;

  signalClient.pingTimeoutDuration = adjustedTimeout;
  console.warn('[voice] Adjusted LiveKit signal ping timeout for stability:', {
    context,
    oldTimeoutSeconds: pingTimeout,
    intervalSeconds: pingInterval,
    newTimeoutSeconds: adjustedTimeout,
  });
  return true;
}

function tuneLivekitSignalHeartbeat(room: Room): void {
  if (!isCurrentRoom(room)) return;
  const engine = (room as unknown as { engine?: { client?: LivekitSignalClientInternals } }).engine;
  const signalClient = engine?.client;
  if (!signalClient) {
    if (!livekitHeartbeatClientMissingLogged) {
      livekitHeartbeatClientMissingLogged = true;
      console.warn('[voice] Unable to locate LiveKit signal client for heartbeat tuning.');
    }
    return;
  }

  ensureSafeLivekitPingTimeout(signalClient, 'connect-or-reconnect');
}

function configureLivekitLogging(): void {
  if (livekitLogConfigured) return;
  livekitLogConfigured = true;

  // Keep production browser consoles focused on actionable issues.
  // LiveKit emits verbose websocket lifecycle logs (including expected
  // close/error events during disconnect), which can look like fatal errors.
  if (typeof window !== 'undefined' && import.meta.env.PROD) {
    setLogLevel(LogLevel.warn);
  }
}

async function connectWithAttemptTimeout(room: Room, owner: CallSession, url: string, token: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const connect = room.connect(url, token, LIVEKIT_CONNECT_OPTIONS);
  // LiveKit does not accept an AbortSignal. A late success must close this room again.
  void connect.finally(() => {
    if (!isCurrentRoom(room)) void room.disconnect().catch(() => {});
  }).catch(() => {});
  let cleanupAbort: () => void = () => {};
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => reject(owner.signal.reason);
    owner.signal.addEventListener('abort', onAbort, { once: true });
    cleanupAbort = () => owner.signal.removeEventListener('abort', onAbort);
  });
  try {
    await Promise.race([connect, abort, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('LiveKit connect attempt timed out')), LIVEKIT_CONNECT_ATTEMPT_TIMEOUT_MS);
    })]);
    owner.assertCurrent();
  } finally {
    clearTimeout(timeout);
    cleanupAbort();
  }
}

/**
 * Whether the platform has OS-level process audio exclusion for loopback capture.
 * Tauri on Windows uses the WASAPI Process Loopback Exclusion API (Windows 10 2004+)
 * which captures all system audio EXCEPT Paracord's own process tree.
 * On all other platforms (browser, Tauri+Linux, Tauri+macOS) we must suppress
 * voice element playback during streaming to prevent echo.
 */
function hasProcessLoopbackExclusion(): boolean {
  return isTauri() && (navigator.platform?.startsWith('Win') ?? false);
}

/**
 * Suppress or restore voice <audio> element playback.
 * When suppressed, voice elements are fully silenced so their audio does not
 * reach the OS audio output and therefore cannot be captured by getDisplayMedia
 * or PulseAudio loopback.
 */
function suppressVoiceForStream(suppress: boolean): void {
  if (voiceSuppressedForStream === suppress) return;
  voiceSuppressedForStream = suppress;
  const elements = document.querySelectorAll<HTMLAudioElement>('[data-paracord-voice-audio]');
  if (suppress) {
    for (const el of elements) {
      el.muted = true;
      el.volume = 0;
      const stream = el.srcObject;
      if (stream instanceof MediaStream) {
        for (const track of stream.getAudioTracks()) {
          track.enabled = false;
        }
      }
    }
    console.info('[voice] Voice audio suppressed to prevent echo in stream capture');
  } else {
    // Restore to current deafen state
    const deaf = useVoiceStore.getState().selfDeaf;
    for (const el of elements) {
      el.muted = deaf;
      el.volume = deaf ? 0 : 1;
      const stream = el.srcObject;
      if (stream instanceof MediaStream) {
        for (const track of stream.getAudioTracks()) {
          track.enabled = !deaf;
        }
      }
    }
    console.info('[voice] Voice audio restored after stream capture ended');
  }
}

/** True only when the room's signaling transport is fully connected. */
function isRoomConnected(room: Room | null): boolean {
  return room != null && room.state === ConnectionState.Connected;
}

function clearActiveRoomListeners(): void {
  if (!activeRoomListenerCleanup) return;
  activeRoomListenerCleanup();
  activeRoomListenerCleanup = null;
}

function isRedMime(mime: string | undefined): boolean {
  return (mime || '').toLowerCase().includes('audio/red');
}

function isOpusMime(mime: string | undefined): boolean {
  return (mime || '').toLowerCase().includes('audio/opus');
}

function trackKey(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participantIdentity?: string
): string {
  return (
    publication.trackSid ||
    track.sid ||
    `${participantIdentity || 'unknown'}-${publication.source}-${publication.kind}`
  );
}

function setAttachedRemoteAudioMuted(muted: boolean): void {
  // When voice is suppressed for stream capture, keep elements fully silenced
  // regardless of the deafen state.  The actual deafen mute will be applied
  // when stream suppression is lifted.
  const effectiveMute = muted || voiceSuppressedForStream;
  for (const element of attachedRemoteAudioElements.values()) {
    element.muted = effectiveMute;
    // Belt-and-suspenders: setting volume to 0 ensures silence even when the
    // muted attribute is not respected for MediaStream sources in some
    // WebView/browser environments (e.g. Tauri WebView2).
    element.volume = effectiveMute ? 0 : 1;
    // Disable the underlying MediaStreamTrack objects so no audio data reaches
    // the output at all. This is the most reliable deafen mechanism because
    // some runtimes ignore muted/volume on elements with MediaStream sources.
    const stream = element.srcObject;
    if (stream instanceof MediaStream) {
      for (const audioTrack of stream.getAudioTracks()) {
        audioTrack.enabled = !effectiveMute;
      }
    }
  }
}

async function setAudioElementOutputDevice(
  element: HTMLAudioElement,
  deviceId: string | undefined
): Promise<void> {
  const sinkIdFn = (element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
    .setSinkId;
  if (typeof sinkIdFn !== 'function') return;
  const target = deviceId ?? 'default';
  try {
    await sinkIdFn.call(element, target);
  } catch (err) {
    console.warn('[voice] Failed to set audio output device on element:', err);
  }
}

async function applyAttachedRemoteAudioOutput(deviceId: string | undefined): Promise<void> {
  const ops: Promise<void>[] = [];
  for (const element of attachedRemoteAudioElements.values()) {
    ops.push(setAudioElementOutputDevice(element, deviceId));
  }
  await Promise.allSettled(ops);
}

function detachAllAttachedRemoteAudio(): void {
  for (const element of attachedRemoteAudioElements.values()) {
    try {
      element.srcObject = null;
    } catch {
      // ignore element cleanup errors
    }
    element.remove();
  }
  attachedRemoteAudioElements.clear();
}

function stopLocalMicAnalyser(resetSpeaking = true): void {
  if (localMicAnalyserInterval) {
    clearInterval(localMicAnalyserInterval);
    localMicAnalyserInterval = null;
  }
  if (localMicAnalyserCleanup) {
    void localMicAnalyserCleanup().catch(() => {
      // ignore analyser cleanup errors
    });
    localMicAnalyserCleanup = null;
  }
  localMicAnalyserRoom = null;
  localMicSpeakingFallback = false;
  localMicSmoothedVolume = 0;
  localMicUiLastUpdateAt = 0;
  useVoiceStore.setState({
    micInputActive: false,
    micInputLevel: 0,
  });
  if (resetSpeaking) {
    const localUserId = currentCallUser()?.id;
    if (localUserId) {
      setSpeakingForIdentity(localUserId, false);
    }
  }
}

function stopLocalAudioUplinkMonitor(): void {
  if (localAudioUplinkMonitorInterval) {
    clearInterval(localAudioUplinkMonitorInterval);
    localAudioUplinkMonitorInterval = null;
  }
  localAudioUplinkMonitorRoom = null;
  localAudioLastBytesSent = null;
  localAudioStalledIntervals = 0;
  localAudioRecoveryInFlight = false;
  useVoiceStore.setState({
    micUplinkState: 'idle',
    micUplinkBytesSent: null,
    micUplinkStalledIntervals: 0,
    micServerDetected: false,
  });
}

function stopRemoteAudioReconcile(): void {
  if (remoteAudioReconcileInterval) {
    clearInterval(remoteAudioReconcileInterval);
    remoteAudioReconcileInterval = null;
  }
  remoteAudioReconcileRoom = null;
}

function startRemoteAudioReconcile(room: Room): void {
  if (!isCurrentRoom(room)) return;
  stopRemoteAudioReconcile();
  remoteAudioReconcileRoom = room;
  remoteAudioReconcileInterval = setInterval(() => {
    if (remoteAudioReconcileRoom !== room) return;
    const state = useVoiceStore.getState();
    if (!state.connected || state.room !== room) return;
    syncRemoteAudioTracks(room, state.selfDeaf);
  }, 1500);
}

function startLocalAudioUplinkMonitor(room: Room): void {
  if (!isCurrentRoom(room)) return;
  stopLocalAudioUplinkMonitor();
  localAudioUplinkMonitorRoom = room;
  localAudioUplinkMonitorInterval = setInterval(() => {
    void (async () => {
      if (localAudioUplinkMonitorRoom !== room) return;
      const state = useVoiceStore.getState();
      if (!state.connected || state.selfMute || state.selfDeaf) {
        localAudioLastBytesSent = null;
        localAudioStalledIntervals = 0;
        useVoiceStore.setState({
          micUplinkState: 'muted',
          micUplinkBytesSent: null,
          micUplinkStalledIntervals: 0,
        });
        return;
      }
      // With no remote participants in the room, flat sender stats are normal.
      // Avoid false "stalled mic" recovery loops while the user is alone.
      if (room.remoteParticipants.size === 0) {
        localAudioLastBytesSent = null;
        localAudioStalledIntervals = 0;
        useVoiceStore.setState({
          micUplinkState: 'idle',
          micUplinkBytesSent: null,
          micUplinkStalledIntervals: 0,
        });
        return;
      }
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = publication?.track as LocalAudioTrack | undefined;
      if (!publication || !track || publication.isMuted) {
        localAudioLastBytesSent = null;
        localAudioStalledIntervals = 0;
        useVoiceStore.setState({
          micUplinkState: 'no_track',
          micUplinkBytesSent: null,
          micUplinkStalledIntervals: 0,
        });
        return;
      }

      const stats = await track.getSenderStats().catch(() => undefined);
      if (!stats) return;
      const bytesSent = stats.bytesSent ?? 0;

      if (localAudioLastBytesSent === null) {
        localAudioLastBytesSent = bytesSent;
        localAudioStalledIntervals = 0;
        useVoiceStore.setState({
          micUplinkState: 'sending',
          micUplinkBytesSent: bytesSent,
          micUplinkStalledIntervals: 0,
        });
        return;
      }

      if (bytesSent <= localAudioLastBytesSent) {
        localAudioStalledIntervals += 1;
      } else {
        if (localAudioStalledIntervals >= 2) {
          console.info('[voice] Mic uplink bytes recovered:', {
            bytesSent,
            previousBytesSent: localAudioLastBytesSent,
            trackSid: publication.trackSid,
            roomState: room.state,
          });
        }
        localAudioStalledIntervals = 0;
        useVoiceStore.setState({
          micUplinkState: 'sending',
          micUplinkBytesSent: bytesSent,
          micUplinkStalledIntervals: 0,
        });
      }
      localAudioLastBytesSent = bytesSent;

      if (isStallWarningInterval(localAudioStalledIntervals)) {
        console.warn('[voice] Mic uplink bytes stalled:', {
          stalledIntervals: localAudioStalledIntervals,
          bytesSent,
          trackSid: publication.trackSid,
          localSpeakingDetected: localMicSpeakingFallback,
          roomState: room.state,
        });
        useVoiceStore.setState({
          micUplinkState: 'stalled',
          micUplinkBytesSent: bytesSent,
          micUplinkStalledIntervals: localAudioStalledIntervals,
        });
      }

      // If we detect local speech but sender bytes are flat for ~8s,
      // recover by republishing the microphone track.
      // Skip recovery when room is not fully connected to avoid cascading errors.
      if (
        localAudioStalledIntervals >= 4 &&
        localMicSpeakingFallback &&
        room.remoteParticipants.size > 0 &&
        !localAudioRecoveryInFlight &&
        isRoomConnected(room)
      ) {
        localAudioRecoveryInFlight = true;
        useVoiceStore.setState({
          micUplinkState: 'recovering',
          micUplinkBytesSent: bytesSent,
          micUplinkStalledIntervals: localAudioStalledIntervals,
        });
        console.warn('[voice] Mic uplink appears stalled; restarting microphone track.');
        await setMicrophoneEnabledWithFallback(room, true, getSavedInputDeviceId()).catch(() => { });
        localAudioLastBytesSent = null;
        localAudioStalledIntervals = 0;
        localAudioRecoveryInFlight = false;
        useVoiceStore.setState({
          micUplinkState: 'sending',
          micUplinkBytesSent: null,
          micUplinkStalledIntervals: 0,
        });
      }
    })();
  }, 2000);
}

function shouldForceRedCompatibility(room: Room): boolean {
  // Force-opus mode for reliability: RED interoperability varies across
  // browser/WebView combinations and can cause one-way audio.
  void room;
  return false;
}

function refreshAudioCodecCompatibility(room: Room, reason = 'refresh'): void {
  if (!isCurrentRoom(room)) return;
  const nextForceRed = shouldForceRedCompatibility(room);
  const modeChanged = nextForceRed !== forceRedForCompatibility;
  if (modeChanged) {
    forceRedForCompatibility = nextForceRed;
    console.info(
      '[voice] Audio codec compatibility mode:',
      nextForceRed ? 'RED enabled for mixed-client peer' : 'Opus preferred'
    );
  }

  const state = useVoiceStore.getState();
  if (!state.connected || state.selfMute || state.selfDeaf) return;

  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const currentMime = (publication?.mimeType || '').toLowerCase();
  const hasKnownMime = currentMime.length > 0;
  const currentMatchesPolicy =
    publication != null &&
    (!hasKnownMime ||
      ((nextForceRed && isRedMime(currentMime)) || (!nextForceRed && isOpusMime(currentMime))));

  // Always verify the active publication codec after peer changes. Some event
  // orders can skip the republish even though policy changed.
  if (currentMatchesPolicy) return;

  const now = Date.now();
  if (now < audioCodecSwitchCooldownUntil) return;
  audioCodecSwitchCooldownUntil = now + 3500;

  const desiredMime = nextForceRed ? 'audio/red' : 'audio/opus';
  console.info(
    `[voice] Re-publishing microphone for codec compatibility (${reason}). desired=${desiredMime} current=${currentMime || 'unknown'}`
  );
  void setMicrophoneEnabledWithFallback(room, true, getSavedInputDeviceId()).then((ok) => {
    if (!ok) return;
    startLocalAudioUplinkMonitor(room);
    const afterMime = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.mimeType;
    console.info(`[voice] Microphone codec after republish: ${afterMime || 'unknown'}`);
  });
}

function startLocalMicAnalyser(room: Room): void {
  if (!isCurrentRoom(room)) return;
  stopLocalMicAnalyser(false);
  const localUserId = currentCallUser()?.id;
  if (!localUserId) return;

  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = publication?.track;
  if (!track || track.kind !== Track.Kind.Audio) {
    useVoiceStore.setState({
      micInputActive: false,
      micInputLevel: 0,
    });
    return;
  }

  try {
    const { calculateVolume, cleanup } = createAudioAnalyser(track as LocalAudioTrack, {
      cloneTrack: true,
      smoothingTimeConstant: 0.45,
    });
    localMicAnalyserRoom = room;
    localMicAnalyserCleanup = cleanup;
    localMicAnalyserInterval = setInterval(() => {
      if (localMicAnalyserRoom !== room) return;
      const state = useVoiceStore.getState();
      const micPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const locallyMuted =
        state.selfMute || state.selfDeaf || micPublication?.isMuted === true || !state.connected;
      const rawVolume = calculateVolume();
      // Apply a lightweight EMA + hysteresis to reduce false positives while
      // keeping detection responsive.
      localMicSmoothedVolume = smoothVolume(localMicSmoothedVolume, rawVolume, 0.55);
      const onThreshold = 0.055;
      const offThreshold = 0.03;
      const speaking = computeSpeaking({
        smoothedVolume: localMicSmoothedVolume,
        wasSpeaking: localMicSpeakingFallback,
        locallyMuted,
        onThreshold,
        offThreshold,
      });
      localMicSpeakingFallback = speaking;
      setSpeakingForIdentity(localUserId, speaking);
      const now = Date.now();
      if (now - localMicUiLastUpdateAt >= 200) {
        const micInputActive = localMicSmoothedVolume > onThreshold;
        useVoiceStore.setState({
          micInputActive,
          micInputLevel: Math.min(1, Math.max(0, localMicSmoothedVolume)),
        });
        localMicUiLastUpdateAt = now;
      }
    }, 100);
  } catch (err) {
    console.warn('[voice] Local mic analyser unavailable:', err);
    useVoiceStore.setState({
      micInputActive: false,
      micInputLevel: 0,
    });
  }
}

function synthesizeVoiceStateFromParticipant(
  participant: Participant,
  channelId: string,
  guildId: string | null
): VoiceState {
  const existing = useVoiceStore.getState().participants.get(participant.identity);

  // Derive self_stream and self_video from actual LiveKit track publications
  // rather than blindly preserving old stored values.
  let hasScreenShare = false;
  let hasCamera = false;
  for (const pub of participant.videoTrackPublications.values()) {
    const hasUsableTrack = !pub.track || pub.track.mediaStreamTrack?.readyState !== 'ended';
    if (
      pub.source === Track.Source.ScreenShare &&
      !pub.isMuted &&
      hasUsableTrack
    ) {
      hasScreenShare = true;
    }
    if (
      pub.source === Track.Source.Camera &&
      !pub.isMuted &&
      hasUsableTrack
    ) {
      hasCamera = true;
    }
  }

  return {
    user_id: participant.identity,
    channel_id: channelId,
    guild_id: existing?.guild_id || guildId || undefined,
    session_id: existing?.session_id || '',
    deaf: existing?.deaf || false,
    mute: existing?.mute || false,
    self_deaf: existing?.self_deaf || false,
    self_mute: existing?.self_mute || false,
    self_stream: hasScreenShare,
    self_video: hasCamera,
    suppress: existing?.suppress || false,
    request_to_speak_at: existing?.request_to_speak_at ?? null,
    username: existing?.username || participant.name || undefined,
    avatar_hash: existing?.avatar_hash,
  };
}

function syncLivekitRoomPresence(room: Room): void {
  if (!isCurrentRoom(room)) return;
  const current = useVoiceStore.getState();
  const channelId = current.channelId;
  if (!channelId) return;
  const guildId = current.guildId;

  const livekitStates: VoiceState[] = [
    synthesizeVoiceStateFromParticipant(room.localParticipant, channelId, guildId),
  ];
  for (const participant of room.remoteParticipants.values()) {
    livekitStates.push(synthesizeVoiceStateFromParticipant(participant, channelId, guildId));
  }
  const livekitIds = new Set(livekitStates.map((vs) => vs.user_id));

  useVoiceStore.setState((state) => {
    // Ignore stale room callbacks after a channel switch/rejoin.
    if (state.room !== room || state.channelId !== channelId) {
      return state;
    }
    const participants = new Map(state.participants);
    const channelParticipants = new Map(state.channelParticipants);
    const existingInChannel = channelParticipants.get(channelId) || [];

    for (const existing of existingInChannel) {
      if (!livekitIds.has(existing.user_id)) {
        const tracked = participants.get(existing.user_id);
        if (tracked?.channel_id === channelId) {
          participants.delete(existing.user_id);
        }
      }
    }
    for (const vs of livekitStates) {
      participants.set(vs.user_id, vs);
    }
    channelParticipants.set(channelId, livekitStates);
    return { participants, channelParticipants };
  });
}

function getSavedInputDeviceId(): string | undefined {
  const notif = getNotificationSettings();
  const deviceId =
    typeof notif['audioInputDeviceId'] === 'string'
      ? (notif['audioInputDeviceId'] as string).trim()
      : '';
  return deviceId.length > 0 ? deviceId : undefined;
}

type MicCaptureProfile = 'default' | 'pro_interface';

const PRO_AUDIO_INPUT_LABEL_PATTERNS = [
  /focusrite/,
  /scarlett/,
  /steinberg/,
  /pre\s?sonus|presonus/,
  /audient/,
  /behringer/,
  /motu/,
  /apollo/,
  /universal audio/,
  /ssl\s?[0-9]/,
  /rode\s?caster|rodecaster/,
  /usb audio codec/,
  /\baudio interface\b/,
];

let micCaptureProfileCache:
  | { key: string; profile: MicCaptureProfile; resolvedAt: number }
  | null = null;
const MIC_CAPTURE_PROFILE_CACHE_MS = 30_000;

async function resolveMicCaptureProfile(deviceId?: string): Promise<MicCaptureProfile> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return 'default';
  }

  const normalizedDeviceId = deviceId?.trim() || '';
  const cacheKey = normalizedDeviceId || '__default__';
  const now = Date.now();
  if (
    micCaptureProfileCache &&
    micCaptureProfileCache.key === cacheKey &&
    now - micCaptureProfileCache.resolvedAt < MIC_CAPTURE_PROFILE_CACHE_MS
  ) {
    return micCaptureProfileCache.profile;
  }

  let profile: MicCaptureProfile = 'default';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    let target: MediaDeviceInfo | undefined;

    if (normalizedDeviceId) {
      target = inputs.find((d) => d.deviceId === normalizedDeviceId);
    }

    if (!target) {
      target = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
    }

    const label = (target?.label || '').toLowerCase();
    if (label && PRO_AUDIO_INPUT_LABEL_PATTERNS.some((pattern) => pattern.test(label))) {
      profile = 'pro_interface';
    }
  } catch {
    profile = 'default';
  }

  micCaptureProfileCache = {
    key: cacheKey,
    profile,
    resolvedAt: now,
  };
  return profile;
}

function getSavedOutputDeviceId(): string | undefined {
  const notif = getNotificationSettings();
  const deviceId =
    typeof notif['audioOutputDeviceId'] === 'string'
      ? (notif['audioOutputDeviceId'] as string).trim()
      : '';
  return deviceId.length > 0 ? deviceId : undefined;
}

function getBooleanSetting(
  value: unknown,
  defaultValue: boolean
): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return defaultValue;
}

function getNotificationSettings(): Record<string, unknown> {
  return currentCall?.preferences ?? (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
}

function hasSavedVoiceSetting(key: string): boolean {
  const notif = getNotificationSettings();
  return Object.prototype.hasOwnProperty.call(notif, key);
}

/** Whether the user has noise suppression enabled (defaults to true). */
function getSavedNoiseSuppression(): boolean {
  const notif = getNotificationSettings();
  return getBooleanSetting(notif['noiseSuppression'], true);
}

/** Whether the user has echo cancellation enabled (defaults to true). */
function getSavedEchoCancellation(): boolean {
  const notif = getNotificationSettings();
  return getBooleanSetting(notif['echoCancellation'], true);
}

/** Whether automatic gain control is enabled (defaults to false). */
function getSavedAutoGainControl(): boolean {
  const notif = getNotificationSettings();
  return getBooleanSetting(notif['autoGainControl'], false);
}

/**
 * Optional stronger ML voice isolation mode.
 *
 * Disabled by default because some combinations of devices/drivers apply
 * overly aggressive gating that can clip word beginnings/endings.
 */
function getSavedVoiceIsolation(): boolean {
  const notif = getNotificationSettings();
  return getBooleanSetting(notif['voiceIsolation'], false);
}

/**
 * Build the audio capture options reflecting the user's saved voice settings.
 * When noise suppression is enabled we also request `voiceIsolation` which
 * is a much stronger ML-based noise suppressor available in Chrome 116+ and
 * Edge.  It suppresses keyboards, breathing, tapping, and other background
 * noise far more effectively than the basic `noiseSuppression` constraint.
 */
function buildAudioCaptureOptions(
  deviceId?: string,
  profile: MicCaptureProfile = 'default'
): Record<string, unknown> {
  let ns = getSavedNoiseSuppression();
  let ec = getSavedEchoCancellation();
  let agc = getSavedAutoGainControl();
  let voiceIsolation = getSavedVoiceIsolation();

  // Auto-profile for XLR/interface microphones (SM7B + Scarlett class):
  // - keep AGC off (prevents pumping/hiss)
  // - disable EC by default (avoids over-processing if user uses headphones)
  // - keep voiceIsolation off by default to avoid aggressive clipping
  //   (we apply a conservative denoiser processor below instead)
  // User-saved settings always take precedence if explicitly set.
  if (profile === 'pro_interface') {
    if (!hasSavedVoiceSetting('noiseSuppression')) ns = true;
    if (!hasSavedVoiceSetting('echoCancellation')) ec = false;
    if (!hasSavedVoiceSetting('autoGainControl')) agc = false;
    if (!hasSavedVoiceSetting('voiceIsolation')) voiceIsolation = false;
  }

  const opts: Record<string, unknown> = {
    autoGainControl: agc,
    echoCancellation: ec,
    noiseSuppression: ns,
    // Voice Isolation (W3C mediacapture-extensions) is a stronger, ML-based
    // alternative to basic noiseSuppression.  When enabled the browser will
    // isolate the user's voice and suppress environmental noise (keyboards,
    // fans, breathing, etc).  Unsupported browsers silently ignore this.
    voiceIsolation: ns && voiceIsolation,
    // Keep capture in canonical voice-chat format where possible.
    sampleRate: 48_000,
    sampleSize: 16,
    channelCount: 1,
    // Browser-specific fallbacks (ignored where unsupported).
    advanced: [{
      googEchoCancellation: ec,
      googAutoGainControl: agc,
      googNoiseSuppression: ns,
      googHighpassFilter: true,
    }],
  };
  if (deviceId) {
    opts.deviceId = deviceId;
  }
  return opts;
}

const PRO_INTERFACE_DENOISER_CONFIG = {
  // Conservative gate tuned to reduce idle interface hiss while preserving
  // natural speech onset/offset.
  openThreshold: -58,
  closeThreshold: -64,
  attackMs: 4,
  releaseMs: 280,
  holdMs: 520,
  // Do not fully mute when closed; only attenuate to avoid hard chattering.
  floorGain: 0.18,
} as const;

/**
 * Apply/remove mic processor based on capture profile.
 *
 * For pro audio interfaces, attach a conservative denoiser gate to suppress
 * steady preamp/interface hiss with minimal voice coloration.
 */
async function applyMicrophoneProcessor(
  room: Room,
  profile: MicCaptureProfile
): Promise<void> {
  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const localTrack = publication?.track;
  if (!localTrack) return;

  // Access optional processor APIs available on LocalAudioTrack in LiveKit.
  const audioTrack = localTrack as unknown as {
    setProcessor?: (p: unknown) => Promise<void>;
    getProcessor?: () => { name?: string } | undefined;
  };

  if (typeof audioTrack.setProcessor !== 'function') return;
  const processor =
    typeof audioTrack.getProcessor === 'function' ? audioTrack.getProcessor() : undefined;

  if (profile !== 'pro_interface') {
    if (!processor) return;
    try {
      await audioTrack.setProcessor(undefined);
      console.info('[voice] Removed microphone processor for default profile');
    } catch (err) {
      console.warn('[voice] Failed to remove microphone processor:', err);
    }
    return;
  }

  if (processor?.name === 'noise-gate') return;

  try {
    await audioTrack.setProcessor(new NoiseGateProcessor(PRO_INTERFACE_DENOISER_CONFIG));
    console.info('[voice] Applied pro-interface microphone denoiser');
  } catch (err) {
    console.warn('[voice] Failed to apply pro-interface microphone denoiser:', err);
  }
}

function normalizeDeviceId(deviceId?: string | null): string | undefined {
  if (!deviceId) return undefined;
  const trimmed = deviceId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isDeviceConstraintError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'OverconstrainedError' || err.name === 'NotFoundError';
  }
  if (typeof err === 'object' && err !== null) {
    const maybeName = (err as { name?: unknown }).name;
    const maybeConstraint = (err as { constraint?: unknown }).constraint;
    if (maybeName === 'OverconstrainedError' || maybeName === 'NotFoundError') {
      return true;
    }
    if (maybeConstraint === 'deviceId') {
      return true;
    }
  }
  return false;
}

type ScreenCapturePreset = {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
  /** 'detail' = crisp text/UI, 'motion' = games/action, 'film' = gradients/grain/movies */
  hint: 'detail' | 'motion' | 'film';
};

function clampEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.floor(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function fitCaptureResolution(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const safeSourceWidth = Math.max(2, sourceWidth);
  const safeSourceHeight = Math.max(2, sourceHeight);
  const widthScale = maxWidth / safeSourceWidth;
  const heightScale = maxHeight / safeSourceHeight;
  const scale = Math.min(1, widthScale, heightScale);
  return {
    width: clampEvenDimension(safeSourceWidth * scale),
    height: clampEvenDimension(safeSourceHeight * scale),
  };
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/**
 * Detect the best video codec the browser can encode for screen sharing.
 * Preference order: AV1 > VP9 > H.264.
 */
function detectBestVideoCodec(): 'av1' | 'vp9' | 'h264' {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (caps) {
      const mimeSet = new Set(caps.codecs.map((c) => c.mimeType.toLowerCase()));
      if (mimeSet.has('video/av1')) return 'av1';
      if (mimeSet.has('video/vp9')) return 'vp9';
    }
  } catch {
    // getCapabilities not supported; fall through.
  }
  return 'h264';
}

async function tuneScreenShareCaptureTrack(
  track: MediaStreamTrack,
  capture: ScreenCapturePreset
): Promise<void> {
  const beforeSettings = track.getSettings() as MediaTrackSettings & Record<string, unknown>;
  const sourceWidth = positiveInt(beforeSettings.width) ?? capture.width;
  const sourceHeight = positiveInt(beforeSettings.height) ?? capture.height;
  const sourceFps = positiveInt(beforeSettings.frameRate) ?? capture.frameRate;
  const target = fitCaptureResolution(sourceWidth, sourceHeight, capture.width, capture.height);

  const baseConstraints: MediaTrackConstraints = {
    width: { ideal: target.width, max: target.width },
    height: { ideal: target.height, max: target.height },
    frameRate: { ideal: capture.frameRate, max: capture.frameRate },
  };

  const sdrRequestedConstraints = baseConstraints as MediaTrackConstraints & Record<string, unknown>;
  // Ask browser to downscale in capture pipeline instead of full-res capture.
  sdrRequestedConstraints.resizeMode = 'crop-and-scale';
  // Experimental constraints ignored by unsupported browsers. These request
  // an SDR output track for HDR displays so SDR viewers do not see blown-out
  // highlights.
  sdrRequestedConstraints.colorSpace = 'srgb';
  sdrRequestedConstraints.dynamicRange = 'standard';

  try {
    await track.applyConstraints(sdrRequestedConstraints as MediaTrackConstraints);
  } catch (err) {
    // Fallback without experimental fields for browsers that reject unknown keys.
    console.warn('[voice] Screen share SDR constraints unsupported, applying base capture caps:', err);
    try {
      await track.applyConstraints(baseConstraints);
    } catch (fallbackErr) {
      console.warn('[voice] Failed to apply screen share capture caps:', fallbackErr);
    }
  }

  const afterSettings = track.getSettings() as MediaTrackSettings & Record<string, unknown>;
  console.info('[voice] Screen share capture settings:', {
    source: {
      width: sourceWidth,
      height: sourceHeight,
      fps: sourceFps,
      colorSpace: beforeSettings.colorSpace ?? 'unknown',
      dynamicRange: beforeSettings.dynamicRange ?? 'unknown',
    },
    target: {
      width: target.width,
      height: target.height,
      fps: capture.frameRate,
      maxBitrate: capture.maxBitrate,
    },
    applied: {
      width: positiveInt(afterSettings.width),
      height: positiveInt(afterSettings.height),
      fps: positiveInt(afterSettings.frameRate),
      colorSpace: afterSettings.colorSpace ?? 'unknown',
      dynamicRange: afterSettings.dynamicRange ?? 'unknown',
    },
  });
}

function attachRemoteAudioTrack(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  muted: boolean,
  participantIdentity?: string
): void {
  if (typeof document === 'undefined' || track.kind !== Track.Kind.Audio) return;
  const key = trackKey(track, publication, participantIdentity);
  const existing = attachedRemoteAudioElements.get(key);

  // If the existing element already has the right track attached, just
  // update mute/volume state without recreating. This avoids the brief
  // audio-on-wrong-device window that occurs when setSinkId is still pending.
  if (existing) {
    const existingStream = existing.srcObject instanceof MediaStream ? existing.srcObject : null;
    const existingTrack = existingStream?.getAudioTracks()[0] ?? null;
    // Do not churn attachments based on object identity alone. In some
    // runtimes the MediaStreamTrack wrapper identity can change while still
    // referring to the same underlying remote source, which causes repeated
    // detach/attach cycles over long calls.
    if (existingTrack && existingTrack.readyState !== 'ended') {
      const effectiveMute = muted || voiceSuppressedForStream;
      existing.muted = effectiveMute;
      existing.volume = effectiveMute ? 0 : 1;
      if (existingStream) {
        for (const at of existingStream.getAudioTracks()) {
          at.enabled = !effectiveMute;
        }
      }
      return;
    }

    // Existing element is stale (missing/ended track); rebuild it.
    track.detach(existing);
    existing.remove();
    attachedRemoteAudioElements.delete(key);
  }
  const audio = document.createElement('audio');
  // Do NOT autoplay; we start playback only after setSinkId completes to
  // prevent voice audio from briefly playing on the default device (which
  // WASAPI loopback captures, causing echo in outgoing streams).
  audio.autoplay = false;
  audio.style.display = 'none';
  audio.setAttribute('data-paracord-voice-audio', 'true');
  if (participantIdentity) {
    audio.setAttribute('data-paracord-voice-participant', participantIdentity);
  }
  if (publication.trackSid) {
    audio.setAttribute('data-paracord-voice-track-sid', publication.trackSid);
  }
  const streamingDeviceId = selectedAudioOutputDeviceId;
  const sinkReady = setAudioElementOutputDevice(audio, streamingDeviceId);
  // Attach FIRST. LiveKit's track.attach() internally resets element.muted
  // to false and may override other properties. We set our deafen overrides
  // AFTER attach so they stick.
  track.attach(audio);
  // When voice is suppressed for stream capture, force-mute regardless of
  // the deafen state to prevent voice audio reaching the OS audio output.
  const effectiveMute = muted || voiceSuppressedForStream;
  audio.muted = effectiveMute;
  audio.volume = effectiveMute ? 0 : 1;
  if (effectiveMute) {
    const stream = audio.srcObject;
    if (stream instanceof MediaStream) {
      for (const audioTrack of stream.getAudioTracks()) {
        audioTrack.enabled = false;
      }
    }
  }
  document.body.appendChild(audio);
  attachedRemoteAudioElements.set(key, audio);
  // Wait for sink routing to complete before playing so audio never
  // briefly outputs on the wrong device.
  void sinkReady.then(() => {
    audio.play().catch(() => {
      // Autoplay was blocked by browser policy. Retry on the next user
      // interaction so audio starts flowing once the user clicks/taps.
      const resumeOnGesture = () => {
        audio.play().catch(() => { });
        document.removeEventListener('click', resumeOnGesture);
        document.removeEventListener('keydown', resumeOnGesture);
      };
      document.addEventListener('click', resumeOnGesture, { once: true });
      document.addEventListener('keydown', resumeOnGesture, { once: true });
    });
  });

}

function detachRemoteAudioTrack(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participantIdentity?: string
): void {
  if (track.kind !== Track.Kind.Audio) return;
  const key = trackKey(track, publication, participantIdentity);
  const existing = attachedRemoteAudioElements.get(key);
  if (existing) {
    track.detach(existing);
    existing.remove();
    attachedRemoteAudioElements.delete(key);
    return;
  }
  const detached = track.detach();
  for (const element of detached) {
    if (element instanceof HTMLAudioElement) {
      for (const [sid, attached] of attachedRemoteAudioElements.entries()) {
        if (attached === element) {
          attachedRemoteAudioElements.delete(sid);
          break;
        }
      }
    }
    element.remove();
  }
}

function setSpeakingForIdentity(identity: string, speaking: boolean): void {
  if (!identity) return;
  useVoiceStore.setState((state) => {
    // This runs on a 100ms analyser tick; bail without publishing a new Set
    // when membership is unchanged so subscribers don't re-render 10x/sec.
    if (state.speakingUsers.has(identity) === speaking) return state;
    const next = new Set(state.speakingUsers);
    if (speaking) next.add(identity);
    else next.delete(identity);
    return { speakingUsers: next };
  });
}

function buildLocalVoiceState(
  channelId: string,
  guildId: string | null,
  sessionId: string,
  selfMute: boolean,
  selfDeaf: boolean,
  selfStream: boolean,
  selfVideo: boolean,
  suppress = false,
  requestToSpeakAt: string | null = null,
): VoiceState | null {
  const authUser = currentCallUser();
  if (!authUser) return null;
  return {
    user_id: authUser.id,
    channel_id: channelId,
    guild_id: guildId ?? undefined,
    session_id: sessionId,
    deaf: false,
    mute: false,
    self_deaf: selfDeaf,
    self_mute: selfMute,
    self_stream: selfStream,
    self_video: selfVideo,
    suppress,
    request_to_speak_at: requestToSpeakAt,
    username: authUser.username,
    avatar_hash: authUser.avatar_hash,
  };
}

async function setMicrophoneEnabledWithFallback(
  room: Room,
  enabled: boolean,
  preferredDeviceId?: string
): Promise<boolean> {
  if (!isCurrentRoom(room)) return false;
  // Guard: don't try to publish tracks if the room isn't connected.
  // Publishing in a reconnecting/disconnected state causes cascading
  // "engine not connected within timeout" errors.
  if (enabled && !isRoomConnected(room)) {
    console.warn('[voice] Skipping mic enable — room not connected (state:', room.state, ')');
    return false;
  }
  let preferredInputDeviceId = normalizeDeviceId(preferredDeviceId);
  if (preferredInputDeviceId && invalidAudioInputDeviceIds.has(preferredInputDeviceId)) {
    preferredInputDeviceId = undefined;
  }
  const redPreferred = forceRedForCompatibility || shouldForceRedCompatibility(room);
  forceRedForCompatibility = redPreferred;
  const microphonePublishOptions = {
    audioPreset: AudioPresets.speech,
    // Keep DTX off for speech stability. DTX/VAD can clip word starts/ends
    // on some microphones and noisy environments.
    dtx: false,
    // Adapt codec for mixed client versions in the same room.
    red: redPreferred,
    forceStereo: false,
    stopMicTrackOnMute: false,
  };
  const ensurePublishedTrackUnmuted = async () => {
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!publication?.isMuted) return;
    try {
      await publication.unmute();
    } catch (err) {
      console.warn('[voice] Failed to unmute published microphone track:', err);
    }
  };

  const maybeUpgradeProfileAfterPermission = async (
    initialProfile: MicCaptureProfile
  ): Promise<void> => {
    if (initialProfile !== 'default') return;
    const upgradedProfile = await resolveMicCaptureProfile(preferredInputDeviceId);
    if (upgradedProfile !== 'pro_interface') return;
    try {
      const upgradedCaptureOptions = buildAudioCaptureOptions(preferredInputDeviceId, upgradedProfile);
      await room.localParticipant.setMicrophoneEnabled(
        true,
        upgradedCaptureOptions,
        microphonePublishOptions
      );
      await ensurePublishedTrackUnmuted();
      await applyMicrophoneProcessor(room, upgradedProfile);
      console.info('[voice] Applied pro-interface mic profile after permission grant');
    } catch (err) {
      console.warn('[voice] Failed to apply upgraded pro-interface mic profile:', err);
    }
  };

  if (!enabled) {
    return room.localParticipant
      .setMicrophoneEnabled(false)
      .then(() => true)
      .catch((err) => {
        console.warn('[voice] Failed to disable microphone:', err);
        return false;
      });
  }

  // Build capture options that include the user's noise suppression,
  // echo cancellation, and voice isolation preferences so every mic
  // enable/republish path applies them consistently.
  const preferredProfile = await resolveMicCaptureProfile(preferredInputDeviceId);
  if (!isCurrentRoom(room)) return false;
  const captureOptions = buildAudioCaptureOptions(preferredInputDeviceId, preferredProfile);

  // If a mic track is already published, just unmute it instead of tearing
  // down and re-publishing. This avoids a failure window where the disable
  // succeeds but the re-enable fails, leaving the mic stuck off.
  const existingPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (existingPublication) {
    try {
      await ensurePublishedTrackUnmuted();
      await room.localParticipant.setMicrophoneEnabled(true, captureOptions, microphonePublishOptions);
      await applyMicrophoneProcessor(room, preferredProfile);
      await maybeUpgradeProfileAfterPermission(preferredProfile);
      return true;
    } catch (err) {
      console.warn('[voice] Failed to unmute existing mic track, will try fresh publish:', err);
    }
  }

  if (!isCurrentRoom(room)) return false;
  if (preferredInputDeviceId) {
    try {
      await room.localParticipant.setMicrophoneEnabled(
        true,
        captureOptions,
        microphonePublishOptions
      );
      await ensurePublishedTrackUnmuted();
      await applyMicrophoneProcessor(room, preferredProfile);
      await maybeUpgradeProfileAfterPermission(preferredProfile);
      return true;
    } catch (err) {
      if (isDeviceConstraintError(err)) {
        invalidAudioInputDeviceIds.add(preferredInputDeviceId);
      }
      console.warn('[voice] Saved input device failed, retrying default input:', err);
    }
  }

  try {
    if (!isCurrentRoom(room)) return false;
    const defaultProfile = await resolveMicCaptureProfile();
    if (!isCurrentRoom(room)) return false;
    const defaultCaptureOptions = buildAudioCaptureOptions(undefined, defaultProfile);
    await room.localParticipant.setMicrophoneEnabled(true, defaultCaptureOptions, microphonePublishOptions);
    await ensurePublishedTrackUnmuted();
    await applyMicrophoneProcessor(room, defaultProfile);
    await maybeUpgradeProfileAfterPermission(defaultProfile);
    return true;
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      console.error(
        '[voice] Microphone permission denied. Grant microphone access and try again.',
      );
    } else if (name === 'NotFoundError') {
      console.error('[voice] No microphone found on this device.');
    } else {
      console.warn('[voice] Failed to enable microphone:', err);
    }
    return false;
  }
}

function syncRemoteAudioTracks(room: Room, muted: boolean): void {
  if (!isCurrentRoom(room)) return;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShareAudio) {
        continue;
      }
      if (publication.kind === Track.Kind.Audio && !publication.isSubscribed) {
        publication.setSubscribed(true);
      }
      const track = publication.track;
      if (track && track.kind === Track.Kind.Audio) {
        attachRemoteAudioTrack(
          track as RemoteTrack,
          publication as RemoteTrackPublication,
          muted,
          participant.identity
        );
      }
    }
  }
}

function registerRoomListeners(
  room: Room,
  onDisconnected: (reason?: DisconnectReason) => void
): () => void {
  const guardedCallbacks = new WeakMap<object, unknown>();
  const guarded = <T extends (...args: never[]) => void>(callback: T): T => {
    if (!guardedCallbacks.has(callback)) {
      guardedCallbacks.set(callback, (...args: Parameters<T>) => { if (isCurrentRoom(room)) callback(...args); });
    }
    return guardedCallbacks.get(callback) as T;
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const gestureCleanups = new Set<() => void>();
  const schedule = (callback: () => void, delayMs: number) => {
    const timer = setTimeout(() => { timers.delete(timer); if (isCurrentRoom(room)) callback(); }, delayMs);
    timers.add(timer);
  };
  const speakingHandlers = new Map<string, (speaking: boolean) => void>();
  const bindParticipantSpeaking = (participant: Participant) => {
    const identity = participant.identity;
    if (!identity || speakingHandlers.has(identity)) return;
    const handler = (speaking: boolean) => {
      if (isCurrentRoom(room)) setSpeakingForIdentity(identity, speaking);
    };
    speakingHandlers.set(identity, handler);
    participant.on(ParticipantEvent.IsSpeakingChanged, handler);
    if (participant.isSpeaking) {
      setSpeakingForIdentity(identity, true);
    }
  };
  const unbindParticipantSpeaking = (participant: Participant) => {
    const identity = participant.identity;
    if (!identity) return;
    const handler = speakingHandlers.get(identity);
    if (handler) {
      participant.off(ParticipantEvent.IsSpeakingChanged, handler);
      speakingHandlers.delete(identity);
    }
    if (isCurrentRoom(room)) setSpeakingForIdentity(identity, false);
  };
  bindParticipantSpeaking(room.localParticipant);
  for (const participant of room.remoteParticipants.values()) {
    bindParticipantSpeaking(participant);
  }
  refreshAudioCodecCompatibility(room, 'initial-listener-bind');
  syncLivekitRoomPresence(room);
  startRemoteAudioReconcile(room);

  const onActiveSpeakersChanged = (speakers: Participant[]) => {
    const speakingIds = new Set(speakers.map((s) => s.identity));
    const localUserId = currentCallUser()?.id;
    const serverDetectedLocalSpeaking = !!(localUserId && speakingIds.has(localUserId));
    useVoiceStore.setState({ micServerDetected: serverDetectedLocalSpeaking });
    // Fallback to local analyser for self speaking so the local ring still
    // reflects microphone activity even when server speaker updates lag.
    if (localUserId && localMicSpeakingFallback) {
      speakingIds.add(localUserId);
    }
    useVoiceStore.getState().setSpeakingUsers(Array.from(speakingIds));
  };

  const onParticipantConnected = (participant: RemoteParticipant) => {
    bindParticipantSpeaking(participant);
    refreshAudioCodecCompatibility(room, `participant-connected:${participant.identity}`);
    // Re-check shortly after connect to catch late track metadata updates.
    schedule(() => refreshAudioCodecCompatibility(room, 'participant-connected-delayed'), 300);
    schedule(() => refreshAudioCodecCompatibility(room, 'participant-connected-late'), 1500);
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShareAudio) {
        continue;
      }
      if (publication.kind === Track.Kind.Audio && !publication.isSubscribed) {
        (publication as RemoteTrackPublication).setSubscribed(true);
      }
    }
    syncLivekitRoomPresence(room);
  };

  const onParticipantDisconnected = (participant: RemoteParticipant) => {
    unbindParticipantSpeaking(participant);
    refreshAudioCodecCompatibility(room, `participant-disconnected:${participant.identity}`);
    syncLivekitRoomPresence(room);
  };

  const onLocalTrackPublished = () => {
    startLocalMicAnalyser(room);
    startLocalAudioUplinkMonitor(room);
  };

  const onLocalTrackUnpublished = (
    publication: LocalTrackPublication,
    _participant: LocalParticipant
  ) => {
    if (publication.source === Track.Source.Microphone) {
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
    }
    // When the local camera track is unpublished, clear selfVideo.
    if (publication.source === Track.Source.Camera) {
      const state = useVoiceStore.getState();
      if (state.selfVideo) {
        console.info('[voice] Local camera track unpublished; clearing selfVideo');
        const localUserId = currentCallUser()?.id;
        const participants = new Map(state.participants);
        if (localUserId) {
          const existing = participants.get(localUserId);
          if (existing) {
            participants.set(localUserId, { ...existing, self_video: false });
          }
        }
        useVoiceStore.setState({ selfVideo: false, participants });
      }
    }
    // When the local screen-share track is unpublished (e.g. the user clicked
    // "Stop sharing" in the OS chrome, or the shared window was closed),
    // clear selfStream so the stream viewer UI is removed.
    if (publication.source === Track.Source.ScreenShare) {
      suppressVoiceForStream(false);
      const state = useVoiceStore.getState();
      if (state.selfStream) {
        console.info('[voice] Local screen share track unpublished; clearing selfStream');
        // Notify server that stream ended
        if (state.channelId) {
          callApi().stopStream(state.channelId).catch((err) => {
            console.warn('[voice] Failed to stop stream after local unpublish:', err);
          });
        }
        // Revert voice audio to normal output device
        const savedOutputId = getSavedOutputDeviceId() || '';
        const voiceEls = document.querySelectorAll<HTMLAudioElement>('[data-paracord-voice-audio]');
        for (const el of voiceEls) {
          el.setSinkId?.(savedOutputId).catch(() => { });
        }
        const localUserId = currentCallUser()?.id;
        const participants = new Map(state.participants);
        const channelParticipants = new Map(state.channelParticipants);
        if (localUserId) {
          const existing = participants.get(localUserId);
          if (existing) {
            participants.set(localUserId, { ...existing, self_stream: false });
          }
          // Also clear self_stream in channelParticipants so the sidebar
          // LIVE badge disappears immediately.
          if (state.channelId) {
            const chMembers = (channelParticipants.get(state.channelId) || []).map(m =>
              m.user_id === localUserId ? { ...m, self_stream: false } : m
            );
            channelParticipants.set(state.channelId, chMembers);
          }
        }
        useVoiceStore.setState({
          selfStream: false,
          participants,
          channelParticipants,
          streamAudioWarning: null,
          systemAudioCaptureActive: false,
          voiceSuppressedForStream: false,
        });
      }
    }
  };

  const onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: Participant
  ) => {
    if (publication.source === Track.Source.ScreenShareAudio) return;
    attachRemoteAudioTrack(track, publication, useVoiceStore.getState().selfDeaf, participant.identity);
  };

  const onTrackPublished = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    refreshAudioCodecCompatibility(room, `track-published:${participant.identity}`);
    // Update presence when camera or screen share tracks are published/unpublished
    if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
      syncLivekitRoomPresence(room);
    }
    if (publication.source === Track.Source.ScreenShareAudio) return;
    if (publication.kind !== Track.Kind.Audio) return;
    if (!publication.isSubscribed) {
      publication.setSubscribed(true);
    }
    // If track is already available at publish time, attach immediately.
    const track = publication.track;
    if (track && track.kind === Track.Kind.Audio) {
      attachRemoteAudioTrack(
        track as RemoteTrack,
        publication as RemoteTrackPublication,
        useVoiceStore.getState().selfDeaf,
        participant.identity
      );
    } else {
      // Ensure we attempt attachment again shortly after publication.
      schedule(() => {
        const latestTrack = publication.track;
        if (latestTrack && latestTrack.kind === Track.Kind.Audio) {
          attachRemoteAudioTrack(
            latestTrack as RemoteTrack,
            publication as RemoteTrackPublication,
            useVoiceStore.getState().selfDeaf,
            participant.identity
          );
        }
      }, 250);
    }
    // Keep speaking bindings current.
    bindParticipantSpeaking(participant);
  };

  const onTrackSubscriptionFailed = (trackSid: string, participant?: RemoteParticipant) => {
    console.warn('[voice] Track subscription failed:', trackSid, participant?.identity);
  };

  const onTrackSubscriptionStatusChanged = (
    publication: RemoteTrackPublication,
    status: string,
    participant?: RemoteParticipant
  ) => {
    refreshAudioCodecCompatibility(room, `track-subscription-status:${status}`);
    if (publication.source === Track.Source.ScreenShareAudio) return;
    if (publication.kind !== Track.Kind.Audio) return;
    if (status !== 'subscribed' && !publication.isSubscribed) {
      publication.setSubscribed(true);
    }
    if (status === 'subscribed' && publication.track && publication.track.kind === Track.Kind.Audio) {
      attachRemoteAudioTrack(
        publication.track as RemoteTrack,
        publication as RemoteTrackPublication,
        useVoiceStore.getState().selfDeaf,
        participant?.identity
      );
    }
    if (participant) {
      bindParticipantSpeaking(participant);
    }
  };

  const onTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    // ScreenShareAudio is managed by StreamViewer, not the voice audio pipeline.
    if (publication.source === Track.Source.ScreenShareAudio) return;
    detachRemoteAudioTrack(track, publication, participant.identity);
    // Update presence when video tracks are removed so camera/stream icons update
    if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
      syncLivekitRoomPresence(room);
    }
  };

  const onTrackMuted = (
    publication: TrackPublication,
    _participant: Participant
  ) => {
    if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
      syncLivekitRoomPresence(room);
    }
  };

  const onTrackUnmuted = (
    publication: TrackPublication,
    _participant: Participant
  ) => {
    if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
      syncLivekitRoomPresence(room);
    }
  };

  const onTrackUnpublished = (
    publication: TrackPublication,
    _participant: Participant
  ) => {
    if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
      syncLivekitRoomPresence(room);
    }
  };

  const onAudioPlaybackStatusChanged = () => {
    if (!room.canPlaybackAudio) {
      console.warn('[voice] Audio playback blocked; will retry on next user gesture');
      const resume = () => {
        if (isCurrentRoom(room)) room.startAudio().catch(() => { });
        document.removeEventListener('click', resume);
        document.removeEventListener('keydown', resume);
      };
      gestureCleanups.add(() => { document.removeEventListener('click', resume); document.removeEventListener('keydown', resume); });
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    }
  };

  const onMediaDevicesError = (err: Error) => {
    console.error('[voice] Media device error:', err.message);
  };

  const onLocalAudioSilenceDetected = () => {
    const now = Date.now();
    if (now < localSilenceRecoveryCooldownUntil) return;
    localSilenceRecoveryCooldownUntil = now + 15_000;
    if (room.remoteParticipants.size === 0) return;
    const state = useVoiceStore.getState();
    if (!state.connected || state.selfMute || state.selfDeaf) return;
    // Don't attempt mic recovery when the room is reconnecting or disconnected.
    // Publishing tracks in this state causes cascading "engine not connected" errors.
    if (!isRoomConnected(room)) return;
    console.warn('[voice] Local microphone appears silent; restarting microphone track.');
    void setMicrophoneEnabledWithFallback(room, true, getSavedInputDeviceId()).then((ok) => {
      if (ok) {
        startLocalAudioUplinkMonitor(room);
      }
    });
  };

  const onReconnecting = () => {
    const owner = roomOwners.get(room)?.owner;
    if (owner?.current) { owner.phase = 'reconnecting'; useVoiceStore.setState({ callPhase: 'reconnecting' }); }
    console.warn('[voice] LiveKit reconnecting...');
    logVoiceDiagnostic('[voice] LiveKit reconnecting');
  };

  const onReconnected = () => {
    const owner = roomOwners.get(room)?.owner;
    if (owner?.current) { owner.phase = 'connected'; useVoiceStore.setState({ callPhase: 'connected' }); }
    console.info('[voice] LiveKit reconnected successfully');
    logVoiceDiagnostic('[voice] LiveKit reconnected');
    tuneLivekitSignalHeartbeat(room);
    if (!isRoomConnected(room)) {
      console.warn('[voice] Reconnected event fired but room state is not Connected; skipping mic restore.');
      return;
    }
    refreshAudioCodecCompatibility(room, 'reconnected');
    // Re-sync remote audio tracks after reconnection to ensure all
    // subscribed tracks have attached <audio> elements.
    syncRemoteAudioTracks(room, useVoiceStore.getState().selfDeaf);
    syncLivekitRoomPresence(room);
    // Re-assert local mic publication state after reconnect. In some reconnect
    // paths, downstream resumes while upstream mic publication stalls.
    const state = useVoiceStore.getState();
    const shouldEnableMic = state.connected && !state.selfMute && !state.selfDeaf;
    void setMicrophoneEnabledWithFallback(room, shouldEnableMic, getSavedInputDeviceId()).then((ok) => {
      if (ok && shouldEnableMic) {
        startLocalAudioUplinkMonitor(room);
      }
      console.info('[voice] Reconnected microphone state restore:', {
        expectedEnabled: shouldEnableMic,
        success: ok,
      });
    });
  };

  const onDisconnectedEvent = (reason?: DisconnectReason) => {
    logVoiceDiagnostic('[voice] LiveKit disconnected', { reason: reason ?? 'unknown' });
    stopRemoteAudioReconcile();
    stopLocalMicAnalyser();
    stopLocalAudioUplinkMonitor();
    unbindParticipantSpeaking(room.localParticipant);
    for (const participant of room.remoteParticipants.values()) {
      unbindParticipantSpeaking(participant);
    }
    onDisconnected(reason);
  };

  room.on(RoomEvent.ActiveSpeakersChanged, guarded(onActiveSpeakersChanged));
  room.on(RoomEvent.ParticipantConnected, guarded(onParticipantConnected));
  room.on(RoomEvent.ParticipantDisconnected, guarded(onParticipantDisconnected));
  room.on(RoomEvent.LocalTrackPublished, guarded(onLocalTrackPublished));
  room.on(RoomEvent.LocalTrackUnpublished, guarded(onLocalTrackUnpublished));
  room.on(RoomEvent.TrackSubscribed, guarded(onTrackSubscribed));
  room.on(RoomEvent.TrackPublished, guarded(onTrackPublished));
  room.on(RoomEvent.TrackSubscriptionFailed, guarded(onTrackSubscriptionFailed));
  room.on(RoomEvent.TrackSubscriptionStatusChanged, guarded(onTrackSubscriptionStatusChanged));
  room.on(RoomEvent.TrackUnsubscribed, guarded(onTrackUnsubscribed));
  room.on(RoomEvent.TrackMuted, guarded(onTrackMuted));
  room.on(RoomEvent.TrackUnmuted, guarded(onTrackUnmuted));
  room.on(RoomEvent.TrackUnpublished, guarded(onTrackUnpublished));
  room.on(RoomEvent.AudioPlaybackStatusChanged, guarded(onAudioPlaybackStatusChanged));
  room.on(RoomEvent.MediaDevicesError, guarded(onMediaDevicesError));
  room.on(RoomEvent.LocalAudioSilenceDetected, guarded(onLocalAudioSilenceDetected));
  room.on(RoomEvent.Reconnecting, guarded(onReconnecting));
  room.on(RoomEvent.Reconnected, guarded(onReconnected));
  room.on(RoomEvent.Disconnected, guarded(onDisconnectedEvent));

  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const cleanup of gestureCleanups) cleanup();
    gestureCleanups.clear();
    room.off(RoomEvent.ActiveSpeakersChanged, guarded(onActiveSpeakersChanged));
    room.off(RoomEvent.ParticipantConnected, guarded(onParticipantConnected));
    room.off(RoomEvent.ParticipantDisconnected, guarded(onParticipantDisconnected));
    room.off(RoomEvent.LocalTrackPublished, guarded(onLocalTrackPublished));
    room.off(RoomEvent.LocalTrackUnpublished, guarded(onLocalTrackUnpublished));
    room.off(RoomEvent.TrackSubscribed, guarded(onTrackSubscribed));
    room.off(RoomEvent.TrackPublished, guarded(onTrackPublished));
    room.off(RoomEvent.TrackSubscriptionFailed, guarded(onTrackSubscriptionFailed));
    room.off(RoomEvent.TrackSubscriptionStatusChanged, guarded(onTrackSubscriptionStatusChanged));
    room.off(RoomEvent.TrackUnsubscribed, guarded(onTrackUnsubscribed));
    room.off(RoomEvent.TrackMuted, guarded(onTrackMuted));
    room.off(RoomEvent.TrackUnmuted, guarded(onTrackUnmuted));
    room.off(RoomEvent.TrackUnpublished, guarded(onTrackUnpublished));
    room.off(RoomEvent.AudioPlaybackStatusChanged, guarded(onAudioPlaybackStatusChanged));
    room.off(RoomEvent.MediaDevicesError, guarded(onMediaDevicesError));
    room.off(RoomEvent.LocalAudioSilenceDetected, guarded(onLocalAudioSilenceDetected));
    room.off(RoomEvent.Reconnecting, guarded(onReconnecting));
    room.off(RoomEvent.Reconnected, guarded(onReconnected));
    room.off(RoomEvent.Disconnected, guarded(onDisconnectedEvent));
    unbindParticipantSpeaking(room.localParticipant);
    for (const participant of room.remoteParticipants.values()) {
      unbindParticipantSpeaking(participant);
    }
  };
}

interface VoiceStoreState {
  callId: string | null;
  callScope: AccountScope | null;
  callPhase: CallPhase | 'idle';
  publishVoiceState: () => void;
  connected: boolean;
  joining: boolean;
  joiningChannelId: string | null;
  connectionError: string | null;
  connectionErrorChannelId: string | null;
  channelId: string | null;
  guildId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  selfStream: boolean;
  selfVideo: boolean;
  // Voice states for all users in current channel, keyed by user ID
  participants: Map<string, VoiceState>;
  // Global voice participants across all channels, keyed by channel ID
  channelParticipants: Map<string, VoiceState[]>;
  // Set of user IDs currently speaking (from LiveKit)
  speakingUsers: Set<string>;
  // LiveKit connection info
  livekitToken: string | null;
  livekitUrl: string | null;
  roomName: string | null;
  voiceSessionId: string | null;
  room: Room | null;
  micInputActive: boolean;
  micInputLevel: number;
  micServerDetected: boolean;
  micUplinkState: MicUplinkState;
  micUplinkBytesSent: number | null;
  micUplinkStalledIntervals: number;
  streamAudioWarning: string | null;
  systemAudioCaptureActive: boolean;
  showSystemAudioPrivacyWarning: boolean;
  voiceSuppressedForStream: boolean;
  watchedStreamerId: string | null;
  previewStreamerId: string | null;
  /** True while the PTT key is held down and the mic is unmuted via PTT. */
  pttEngaged: boolean;

  // Native media engine fields (QUIC-based alternative to LiveKit)
  /** When true, use the native MediaEngine instead of LiveKit for voice. */
  useNativeMedia: boolean;
  /** Active native MediaEngine instance (non-null when connected via native media). */
  mediaEngine: MediaEngine | null;

  joinChannel: (channelId: string, guildId?: string, internalRetryAttempt?: number) => Promise<void>;
  leaveChannel: () => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleDeaf: () => Promise<void>;
  startStream: (qualityPreset?: string, sourceId?: string) => Promise<void>;
  stopStream: () => void;
  toggleVideo: () => Promise<void>;
  /** Enumerate native capture cameras for device selection (native path only;
   *  returns [] on the LiveKit/browser path). Contract CAM1. */
  listCameraDevices: () => Promise<Array<{ id: string; label: string }>>;
  /** Applies the audio input device; resolves to false when the switch failed. */
  applyAudioInputDevice: (deviceId: string | null) => Promise<boolean>;
  /** Applies the audio output device; resolves to false when the switch failed. */
  applyAudioOutputDevice: (deviceId: string | null) => Promise<boolean>;
  /** Re-acquire the microphone with the latest noise suppression / echo
   *  cancellation settings from the auth store. Call after saving voice
   *  settings so changes take effect immediately without mute/unmute. */
  reapplyAudioConstraints: () => Promise<void>;
  clearConnectionError: () => void;
  handleMediaTransportLost: (reason: string) => Promise<void>;
  acknowledgeSystemAudioPrivacyWarning: () => void;
  setWatchedStreamer: (userId: string | null) => void;
  setPreviewStreamer: (userId: string | null) => void;
  setPttEngaged: (engaged: boolean) => void;

  // Gateway event handlers
  handleVoiceStateUpdate: (state: VoiceState, scope?: AccountScope) => void;
  // Load initial voice states from READY payload
  loadVoiceStates: (guildId: string, states: VoiceState[], scope?: AccountScope) => void;
  // Speaking state from LiveKit
  setSpeakingUsers: (userIds: string[]) => void;
  /**
   * Tear down any live call and drop all cached voice state. Called on logout —
   * without it the next account inherited the previous account's participant
   * lists and, if a call was active, kept the microphone open.
   */
  reset: () => Promise<void>;
}

export const useVoiceStore = create<VoiceStoreState>()((set, get) => ({
  callId: null, callScope: null, callPhase: 'idle',
  publishVoiceState: () => {
    const owner = currentCall;
    if (!owner?.current || owner.phase !== 'connected') return;
    const state = get();
    gateway.updateVoiceState(owner.target.scope.serverId, owner.target.guildId === 'dm' ? null : owner.target.guildId, owner.target.channelId, state.selfMute, state.selfDeaf, state.selfVideo, state.voiceSessionId);
  },
  connected: false,
  joining: false,
  joiningChannelId: null,
  connectionError: null,
  connectionErrorChannelId: null,
  channelId: null,
  guildId: null,
  selfMute: false,
  selfDeaf: false,
  selfStream: false,
  selfVideo: false,
  participants: new Map(),
  channelParticipants: new Map(),
  speakingUsers: new Set(),
  livekitToken: null,
  livekitUrl: null,
  roomName: null,
  voiceSessionId: null,
  room: null,
  micInputActive: false,
  micInputLevel: 0,
  micServerDetected: false,
  micUplinkState: 'idle',
  micUplinkBytesSent: null,
  micUplinkStalledIntervals: 0,
  streamAudioWarning: null,
  systemAudioCaptureActive: false,
  showSystemAudioPrivacyWarning: false,
  voiceSuppressedForStream: false,
  watchedStreamerId: null,
  previewStreamerId: null,
  pttEngaged: false,

  useNativeMedia: true,
  mediaEngine: null,

  joinChannel: (channelId, guildId) => {
    const context = captureOperationContext();
    const target = { scope: context.scope, channelId, guildId: guildId ?? null };
    if (currentCall?.current && accountScopeKey(currentCall.target.scope) === context.key
        && currentCall.target.channelId === channelId && currentCall.target.guildId === target.guildId) {
      context.dispose();
      return currentCall.joinPromise ?? Promise.resolve();
    }
    const previousMute = get().selfMute;
    const previousDeaf = get().selfDeaf;
    const priorRelease = currentCall ? closeCall(currentCall) : Promise.resolve();
    const owner: CallSession = new CallSession(context, target, () => currentCall === owner, () => { void closeCall(owner); },
      { ...((useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>) });
    currentCall = owner;
    set({ callId: owner.id, callScope: context.scope, callPhase: 'joining', joining: true,
      joiningChannelId: channelId, channelId, guildId: target.guildId, connected: false,
      connectionError: null, connectionErrorChannelId: null, selfMute: previousMute, selfDeaf: previousDeaf });
    owner.joinPromise = priorRelease.then(() => performCallJoin(owner, previousMute, previousDeaf));
    return owner.joinPromise;
  },

  leaveChannel: () => currentCall ? closeCall(currentCall) : Promise.resolve(),

  reset: () => {
    const owner = currentCall;
    // Clear synchronously. A pending release can never erase the next login's call.
    const release = owner ? closeCall(owner) : Promise.resolve();
    set({ channelParticipants: new Map(), participants: new Map(), speakingUsers: new Set(),
      showSystemAudioPrivacyWarning: false, pttEngaged: false });
    return release;
  },

  toggleMute: async () => {
    const owner = currentCall;
    const action = owner?.operation('microphone');
    const state = get();
    const nextSelfMute = !state.selfMute;
    const nextSelfDeaf = nextSelfMute ? state.selfDeaf : false;
    set({
      selfMute: nextSelfMute,
      selfDeaf: nextSelfDeaf,
    });

    // ── Native media engine mute ──────────────────────────────────
    if (state.mediaEngine) {
      state.mediaEngine.setMute(nextSelfMute);
      if (!nextSelfMute && state.selfDeaf) {
        // Unmuting also un-deafens
        state.mediaEngine.setDeaf(false);
      }
      return;
    }

    // ── LiveKit mute (unchanged) ──────────────────────────────────
    setAttachedRemoteAudioMuted(nextSelfDeaf);
    if (!state.room) return;
    // Don't attempt mic operations if the room is reconnecting or disconnected.
    if (!isRoomConnected(state.room)) {
      console.warn('[voice] toggleMute: room not connected, deferring mic change');
      return;
    }
    const targetMicEnabled = !nextSelfMute;
    const ok = await setMicrophoneEnabledWithFallback(state.room, targetMicEnabled, getSavedInputDeviceId());
    if (!action?.current()) return;
    if (ok && targetMicEnabled) {
      startLocalAudioUplinkMonitor(state.room as Room);
    } else if (!targetMicEnabled) {
      stopLocalAudioUplinkMonitor();
    }
    if (!ok && targetMicEnabled) {
      // Mic enable failed — revert UI to muted so it stays truthful.
      set({ selfMute: true });
    }
  },

  toggleDeaf: async () => {
    const owner = currentCall;
    const action = owner?.operation('microphone');
    const state = get();
    const nextSelfDeaf = !state.selfDeaf;
    const nextSelfMute = nextSelfDeaf ? true : state.selfMute;
    set({
      selfDeaf: nextSelfDeaf,
      selfMute: nextSelfMute,
    });

    // ── Native media engine deaf ──────────────────────────────────
    if (state.mediaEngine) {
      state.mediaEngine.setDeaf(nextSelfDeaf);
      state.mediaEngine.setMute(nextSelfMute);
      return;
    }

    // ── LiveKit deaf (unchanged) ──────────────────────────────────
    setAttachedRemoteAudioMuted(nextSelfDeaf);
    if (!state.room) return;
    // Don't attempt mic operations if the room is reconnecting or disconnected.
    if (!isRoomConnected(state.room)) {
      console.warn('[voice] toggleDeaf: room not connected, deferring mic change');
      return;
    }
    const targetMicEnabled = !nextSelfMute;
    const ok = await setMicrophoneEnabledWithFallback(state.room, targetMicEnabled, getSavedInputDeviceId());
    if (!action?.current()) return;
    if (ok && targetMicEnabled) {
      startLocalAudioUplinkMonitor(state.room as Room);
    } else if (!targetMicEnabled) {
      stopLocalAudioUplinkMonitor();
    }
    if (!ok && targetMicEnabled) {
      set({ selfMute: true });
    }
  },

  startStream: async (qualityPreset = '1080p60', sourceId?: string) => {
    const owner = currentCall;
    if (!owner?.current) throw new Error('Voice connection is not ready');
    const action = owner.operation('screen');
    const api = callApi(owner);
    const { channelId, room, mediaEngine } = get();

    // Native media path: use MediaEngine screen share instead of LiveKit
    if (channelId && mediaEngine) {
      if (action.current()) set({ streamAudioWarning: null, systemAudioCaptureActive: false });
      try {
        // Use the same quality presets as the LiveKit path so resolution,
        // framerate, and bitrate targets match what the user selected.
        // Bitrates are sized so frames stay compact on the wire: each frame is
        // fragmented into ~1200-byte datagrams and reassembly is
        // all-or-nothing, so oversized bitrates increase whole-frame loss
        // without visible quality gain for screen content. The "Movie" presets
        // are explicitly labeled with their bitrate and kept as advertised.
        const nativePresetMap: Record<string, ScreenCapturePreset> = {
          '720p30': { width: 1280, height: 720, frameRate: 30, maxBitrate: 5_000_000, hint: 'detail' },
          '1080p60': { width: 1920, height: 1080, frameRate: 60, maxBitrate: 12_000_000, hint: 'detail' },
          '1440p60': { width: 2560, height: 1440, frameRate: 60, maxBitrate: 18_000_000, hint: 'detail' },
          '4k60': { width: 3840, height: 2160, frameRate: 60, maxBitrate: 28_000_000, hint: 'motion' },
          'movie-50': { width: 3840, height: 2160, frameRate: 60, maxBitrate: 50_000_000, hint: 'film' },
          'movie-100': { width: 3840, height: 2160, frameRate: 60, maxBitrate: 100_000_000, hint: 'film' },
        };
        const capture = nativePresetMap[qualityPreset] ?? nativePresetMap['1080p60'];

        // Show the screen picker FIRST — if the user cancels, we don't need
        // to register (and then immediately unregister) with the server.
        await mediaEngine.startScreenShare({
          audio: true,
          maxFrameRate: capture.frameRate,
          maxWidth: capture.width,
          maxHeight: capture.height,
          maxBitrateBps: capture.maxBitrate,
          contentHint: capture.hint,
          sourceId,
        });
        action.assertCurrent();
        const nativeStreamAudioActive = mediaEngine.isScreenShareAudioActive();
        const nativeStreamAudioWarning = nativeStreamAudioActive
          ? null
          : 'Stream started without PC audio. Native system audio capture failed. Try stopping the stream and starting it again.';

        // Screen selected and tuned — now register with server
        await api.startStream(channelId, { quality_preset: qualityPreset });
        action.assertCurrent();
        // Handle user clicking "Stop sharing" in the browser's native overlay
        mediaEngine.onScreenShareEnded(() => {
          if (action.current() && get().selfStream) {
            get().stopStream();
          }
        });
        // Update local voice state for stream indicator and auto-watch self
        // so the StreamViewer subscribes to the published stream immediately.
        const localUserId = currentCallUser()?.id;
        if (action.current()) set((state) => {
          const participants = new Map(state.participants);
          const channelParticipants = new Map(state.channelParticipants);
          if (localUserId) {
            const existing = participants.get(localUserId);
            if (existing) {
              participants.set(localUserId, { ...existing, self_stream: true });
            } else {
              // Participant entry may not exist yet if the gateway
              // VOICE_STATE_UPDATE hasn't arrived. Build one so that
              // activeStreamers derivation works immediately.
              const vs = buildLocalVoiceState(
                channelId!, state.guildId || null,
                '', state.selfMute, state.selfDeaf, true, state.selfVideo,
              );
              if (vs) participants.set(localUserId, vs);
            }
            // Also update channelParticipants so the sidebar LIVE badge
            // renders immediately without waiting for a gateway event.
            if (channelId) {
              const chMembers = (channelParticipants.get(channelId) || []).map(m =>
                m.user_id === localUserId ? { ...m, self_stream: true } : m
              );
              channelParticipants.set(channelId, chMembers);
            }
          }
          return {
            selfStream: true,
            participants,
            channelParticipants,
            watchedStreamerId: localUserId ?? state.watchedStreamerId,
            streamAudioWarning: nativeStreamAudioWarning,
            systemAudioCaptureActive: nativeStreamAudioActive,
          };
        });
      } catch (error) {
      if (!action.current()) return;
        if (!action.current()) return;
        logVoiceDiagnostic('[voice] startStream native error', { error: String(error), type: typeof error, isError: error instanceof Error, name: (error as { name?: string })?.name, message: (error as { message?: string })?.message });
        await mediaEngine.stopScreenShare();
        api.stopStream(channelId).catch(() => { });
        if (action.current()) set({ selfStream: false, streamAudioWarning: null, systemAudioCaptureActive: false });
        throw error;
      }
      return;
    }

    if (!channelId || !room) {
      throw new Error('Voice connection is not ready');
    }
    if (!isRoomConnected(room)) {
      throw new Error('Voice connection is not stable — try again in a moment');
    }
    if (action.current()) set({ streamAudioWarning: null, systemAudioCaptureActive: false });
    try {
      // 1. Start screen share FIRST to preserve the transient user activation
      //    with resolution/framerate constraints matching the preset.
      //    We configure BOTH capture constraints (resolution/fps the browser
      //    captures at) AND encoding parameters (bitrate/fps the WebRTC
      //    encoder targets). Without explicit encoding params LiveKit falls
      //    back to very conservative defaults causing blocky, low-fps streams.
      const presetMap: Record<string, ScreenCapturePreset> = {
        '720p30': { width: 1280, height: 720, frameRate: 30, maxBitrate: 5_000_000, hint: 'detail' },
        '1080p60': { width: 1920, height: 1080, frameRate: 60, maxBitrate: 12_000_000, hint: 'detail' },
        '1440p60': { width: 2560, height: 1440, frameRate: 60, maxBitrate: 18_000_000, hint: 'detail' },
        '4k60': { width: 3840, height: 2160, frameRate: 60, maxBitrate: 28_000_000, hint: 'motion' },
        'movie-50': { width: 3840, height: 2160, frameRate: 60, maxBitrate: 50_000_000, hint: 'film' },
        'movie-100': { width: 3840, height: 2160, frameRate: 60, maxBitrate: 100_000_000, hint: 'film' },
      };
      const capture = presetMap[qualityPreset] ?? presetMap['1080p60'];
      const isTauriApp = isTauri();
      const browserContentHint = capture.hint === 'film' ? 'motion' : capture.hint;

      await room.localParticipant.setScreenShareEnabled(true, {
        // In Tauri, skip browser audio capture; we use native WASAPI/PulseAudio
        // loopback instead to avoid capturing voice chat audio.
        audio: !isTauriApp,
        // systemAudio: 'include' tells Chrome/Edge to pre-check the "Share
        // audio" checkbox in the picker when sharing a screen or tab, so
        // audio is captured automatically without extra user interaction.
        // Note: window-level sharing does NOT support audio (OS limitation).
        systemAudio: isTauriApp ? undefined : 'include',
        selfBrowserSurface: 'include',
        surfaceSwitching: 'include',
        preferCurrentTab: false,
        resolution: { width: capture.width, height: capture.height, frameRate: capture.frameRate },
        contentHint: browserContentHint,
      }, {
        screenShareEncoding: {
          maxBitrate: capture.maxBitrate,
          maxFramerate: capture.frameRate,
          priority: 'high',
        },
        screenShareSimulcastLayers: [],
        // Pick the best codec the browser can actually encode.
        // AV1 > VP9 > H.264 for quality at equivalent bitrate, especially
        // in dark areas and gradients.  backupCodec (h264) covers subscribers
        // that can't decode the primary.
        videoCodec: detectBestVideoCodec(),
        backupCodec: { codec: 'h264' },
        // Always maintain framerate for screen shares. Frame drops are far
        // more noticeable than resolution drops, and the viewer's display is
        // typically smaller than the source resolution anyway.
        degradationPreference: 'maintain-framerate',
        scalabilityMode: 'L1T1',
        // Screen share audio needs a proper bitrate and stereo.  Without
        // these the SDK falls back to publishDefaults which use
        // AudioPresets.speech (24 kbps mono) is far too low for system audio.
        audioPreset: { maxBitrate: 128_000 },
        forceStereo: true,
        dtx: false,
        red: false,
      });

      // 2. Register stream state on the server.
      // When connected via LiveKit fallback (native media was intended but
      // failed), pass fallback=livekit so the server uses the LiveKit path.
      const isLivekitFallback = get().useNativeMedia && !get().mediaEngine;
      const { data } = await api.startStream(channelId, {
        quality_preset: qualityPreset,
        ...(isLivekitFallback ? { fallback: 'livekit' } : {}),
      });

      // Keep the existing LiveKit session and publish screen share in-place.
      // Join tokens already allow screen-share sources for speakers.
      const normalizedUrl = normalizeLivekitUrl(data.url, data.url_candidates);

      const streamNotif = owner.preferences;
      const streamOutputId = normalizeDeviceId(
        typeof streamNotif['audioOutputDeviceId'] === 'string'
          ? (streamNotif['audioOutputDeviceId'] as string)
          : undefined
      );
      const streamInputId = normalizeDeviceId(
        typeof streamNotif['audioInputDeviceId'] === 'string'
          ? (streamNotif['audioInputDeviceId'] as string)
          : undefined
      );
      if (streamOutputId) {
        await room.switchActiveDevice('audiooutput', streamOutputId).catch(() => { });
      }

      // Keep microphone state aligned with current mute/deafen state.
      const shouldEnableMic = !(get().selfMute || get().selfDeaf);
      await setMicrophoneEnabledWithFallback(room, shouldEnableMic, streamInputId);
      if (shouldEnableMic) {
        startLocalAudioUplinkMonitor(room as Room);
      }
      setAttachedRemoteAudioMuted(get().selfDeaf);
      syncRemoteAudioTracks(room, get().selfDeaf);

      const screenShareVideoPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const screenShareVideoTrack = screenShareVideoPub?.track?.mediaStreamTrack;
      if (screenShareVideoTrack) {
        await tuneScreenShareCaptureTrack(screenShareVideoTrack, capture);
      } else {
        console.warn('[voice] Screen share video track not immediately available for constraint tuning');
      }

      let streamAudioWarning: string | null = null;
      const systemAudioCaptureActive = false;

      const waitForScreenShareAudioPublication = async (
        timeoutMs = 1600
      ): Promise<LocalTrackPublication | undefined> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const publication = room.localParticipant.getTrackPublication(
            Track.Source.ScreenShareAudio
          ) as LocalTrackPublication | undefined;
          if (publication?.track) {
            return publication;
          }
          await owner.delay(120);
        }

        return room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio
        ) as LocalTrackPublication | undefined;
      };

      if (isTauriApp) {
        if (!hasAcknowledgedSystemAudioPrivacyWarning()) {
          if (action.current()) set({ showSystemAudioPrivacyWarning: true });
        }
        streamAudioWarning = 'Desktop system audio requires the native media connection. This fallback stream shares video only.';
      } else {
        const screenShareAudioPub = await waitForScreenShareAudioPublication();
        if (screenShareAudioPub?.track) {
          console.info('[voice] Screen share audio track published; viewers will hear stream audio');
        } else {
          streamAudioWarning =
            'Stream started without audio. Share an entire screen/tab and keep "Share audio" enabled.';
          console.warn(
            '[voice] No screen share audio track; audio not captured.',
            'This happens when sharing a window (audio not supported) or if',
            '"Share audio" was unchecked. Share an entire screen for automatic audio.'
          );
        }
      }

      // Suppress voice audio playback on platforms without OS-level process
      // audio exclusion.  This prevents voice chat from being captured by
      // getDisplayMedia / PulseAudio loopback and echoed back through the
      // stream.  On Tauri+Windows the Process Loopback Exclusion API handles
      // this at the OS level, so voice plays normally.
      if (!hasProcessLoopbackExclusion()) {
        suppressVoiceForStream(true);
        if (action.current()) set({ voiceSuppressedForStream: true });
        if (!streamAudioWarning) {
          streamAudioWarning =
            'Voice chat audio is muted during streaming to prevent echo. ' +
            'Other channel members can still hear you.';
        }
      }

      // Post-publish sender tuning: boost starting bitrate and widen
      // keyframe interval so the encoder doesn't waste bits on ramp-up
      // or too-frequent keyframes.
      try {
        const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        const sender = pub?.track?.sender;
        if (sender) {
          const params = sender.getParameters();
          if (params.encodings?.[0]) {
            params.encodings[0].maxBitrate = capture.maxBitrate;
            // Explicit framerate cap so the encoder never sacrifices fps.
            params.encodings[0].maxFramerate = capture.frameRate;
            // Prevent scale-down that some browsers apply by default.
            params.encodings[0].scaleResolutionDownBy = 1.0;
            params.encodings[0].networkPriority = 'high';
            // Keyframe interval: balance between quality (fewer keyframes
            // = more bits for P-frames) and error recovery (shorter interval
            // = faster recovery from artifacts). 2 seconds is a good middle
            // ground for game streaming.
            // @ts-expect-error keyInterval is a non-standard but widely
            // supported Chrome/Edge extension to RTCRtpEncodingParameters
            params.encodings[0].keyInterval = 120; // 2 seconds at 60fps
            await sender.setParameters(params);
          }
        }
      } catch (err) {
        console.warn('[voice] Post-publish sender tuning failed (non-critical):', err);
      }
      // Update local voice state for stream indicator and auto-watch self
      // so the StreamViewer subscribes to the published stream immediately.
      const localUserId = currentCallUser()?.id;
      if (action.current()) set((state) => {
        const participants = new Map(state.participants);
        const channelParticipants = new Map(state.channelParticipants);
        if (localUserId) {
          const existing = participants.get(localUserId);
          if (existing) {
            participants.set(localUserId, { ...existing, self_stream: true });
          } else {
            const vs = buildLocalVoiceState(
              channelId!, state.guildId || null,
              '', state.selfMute, state.selfDeaf, true, state.selfVideo,
            );
            if (vs) participants.set(localUserId, vs);
          }
          if (channelId) {
            const chMembers = (channelParticipants.get(channelId) || []).map(m =>
              m.user_id === localUserId ? { ...m, self_stream: true } : m
            );
            channelParticipants.set(channelId, chMembers);
          }
        }
        return {
          selfStream: true,
          livekitToken: data.token,
          livekitUrl: normalizedUrl,
          roomName: data.room_name,
          streamAudioWarning,
          systemAudioCaptureActive,
          participants,
          channelParticipants,
          watchedStreamerId: localUserId ?? state.watchedStreamerId,
        };
      });
    } catch (error) {
      if (!action.current()) return;
      suppressVoiceForStream(false);
      await room.localParticipant.setScreenShareEnabled(false).catch(() => { });
      // Notify server that stream failed
      if (channelId) {
        api.stopStream(channelId).catch((err) => {
          console.warn('[voice] Failed to stop stream after start failure rollback:', err);
        });
      }
      if (action.current()) set({ selfStream: false, streamAudioWarning: null, systemAudioCaptureActive: false, voiceSuppressedForStream: false });
      throw error;
    }
  },

  stopStream: () => {
    const owner = currentCall;
    if (!owner?.current) return;
    owner.operation('screen');
    const api = callApi(owner);
    const { channelId, room, mediaEngine, selfStream: wasStreaming } = get();
    if (!wasStreaming) return; // Already stopped — prevent re-entrant calls
    // Mark stream as stopped IMMEDIATELY so the onScreenShareEnded callback
    // (which fires when tracks are stopped below) doesn't re-enter stopStream.
    set({ selfStream: false });
    // Notify server to clear stream state
    if (channelId) {
      api.stopStream(channelId).catch((err) => {
        console.warn('[voice] Failed to stop stream on manual stop:', err);
      });
    }
    // Native media path
    if (mediaEngine) {
      void mediaEngine.stopScreenShare();
    }
    room?.localParticipant.setScreenShareEnabled(false).catch(() => { });
    // Restore voice audio that was suppressed to prevent echo in stream capture.
    suppressVoiceForStream(false);
    // Revert voice audio elements to the user's selected output device
    const savedOutputId = getSavedOutputDeviceId() || '';
    const voiceEls = document.querySelectorAll<HTMLAudioElement>('[data-paracord-voice-audio]');
    for (const el of voiceEls) {
      el.setSinkId?.(savedOutputId).catch(() => { });
    }
    // Revert stream audio elements back to the default device
    const streamEls = document.querySelectorAll<HTMLAudioElement>('[data-paracord-stream-audio]');
    for (const el of streamEls) {
      el.setSinkId?.('default').catch(() => { });
    }
    // Also update the local user's voice-state entry so that
    // participants-derived flags reflect the stream ending immediately,
    // even before a gateway event arrives.
    const localUserId = currentCallUser()?.id;
    set((state) => {
      const participants = new Map(state.participants);
      const channelParticipants = new Map(state.channelParticipants);
      if (localUserId) {
        const existing = participants.get(localUserId);
        if (existing) {
          participants.set(localUserId, { ...existing, self_stream: false });
        }
        // Also clear self_stream in channelParticipants so the sidebar
        // LIVE badge disappears immediately.
        if (state.channelId) {
          const chMembers = (channelParticipants.get(state.channelId) || []).map(m =>
            m.user_id === localUserId ? { ...m, self_stream: false } : m
          );
          channelParticipants.set(state.channelId, chMembers);
        }
      }
      // If the user was auto-watching their own stream, clear the viewer.
      const clearWatched =
        localUserId && state.watchedStreamerId === localUserId;
      return {
        selfStream: false,
        participants,
        channelParticipants,
        ...(clearWatched ? { watchedStreamerId: null } : {}),
        streamAudioWarning: null,
        systemAudioCaptureActive: false,
        voiceSuppressedForStream: false,
      };
    });
  },

  toggleVideo: async () => {
    const owner = currentCall;
    const action = owner?.operation('camera');
    const state = get();
    const nextSelfVideo = !state.selfVideo;
    const localUserId = currentCallUser()?.id;

    const setLocalSelfVideo = (enabled: boolean) => {
      if (!action?.current()) return;
      set((prev) => {
        const participants = new Map(prev.participants);
        if (localUserId) {
          const existing = participants.get(localUserId);
          if (existing) {
            participants.set(localUserId, { ...existing, self_video: enabled });
          }
        }
        // Keep channelParticipants in sync so lobby / LIVE-adjacent UI sees camera state.
        const channelParticipants = new Map(prev.channelParticipants);
        if (prev.channelId && localUserId) {
          const members = (channelParticipants.get(prev.channelId) || []).map((m) =>
            m.user_id === localUserId ? { ...m, self_video: enabled } : m,
          );
          channelParticipants.set(prev.channelId, members);
        }
        return { selfVideo: enabled, participants, channelParticipants };
      });
    };

    // Native media path
    if (state.mediaEngine) {
      if (nextSelfVideo) {
        try {
          await state.mediaEngine.enableVideo(true);
          setLocalSelfVideo(true);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to enable camera';
          console.warn('[voice] Failed to enable camera:', message);
          useToastStore.getState().addToast('error', message);
          setLocalSelfVideo(false);
        }
      } else {
        try {
          await state.mediaEngine.enableVideo(false);
        } catch (err) {
          console.warn('[voice] Failed to disable camera:', err);
        }
        setLocalSelfVideo(false);
      }
      return;
    }
    if (!state.room) {
      setLocalSelfVideo(nextSelfVideo);
      return;
    }
    const room = state.room;
    setLocalSelfVideo(nextSelfVideo);

    if (nextSelfVideo) {
      // Enable camera
      const notif = getNotificationSettings();
      const videoDeviceId =
        typeof notif['videoInputDeviceId'] === 'string'
          ? (notif['videoInputDeviceId'] as string).trim()
          : '';
      const captureOpts: Record<string, unknown> = {
        resolution: { width: 1280, height: 720, frameRate: 30 },
      };
      if (videoDeviceId) {
        captureOpts.deviceId = videoDeviceId;
      }
      try {
        await room.localParticipant.setCameraEnabled(true, captureOpts);
        syncLivekitRoomPresence(room);
      } catch (err) {
        console.warn('[voice] Failed to enable camera:', err);
        setLocalSelfVideo(false);
      }
    } else {
      try {
        await room.localParticipant.setCameraEnabled(false);
        syncLivekitRoomPresence(room);
      } catch (err) {
        console.warn('[voice] Failed to disable camera:', err);
      }
    }
  },
  listCameraDevices: async () => {
    const state = get();
    // Native device enumeration is exposed by TauriMediaEngine (not on the
    // MediaEngine interface, since the browser/LiveKit path enumerates cameras
    // through the DOM MediaDevices API instead).
    const engine = state.mediaEngine as
      | (MediaEngine & { listCameraDevices?: () => Promise<Array<{ id: string; label: string }>> })
      | null;
    if (isTauri() && engine?.listCameraDevices) {
      try {
        return await engine.listCameraDevices();
      } catch (err) {
        console.warn('[voice] Failed to list native cameras:', err);
        return [];
      }
    }
    return [];
  },
  applyAudioInputDevice: async (deviceId) => {
    const owner = currentCall;
    const action = owner?.operation('input-device');
    if (owner?.current) owner.preferences['audioInputDeviceId'] = deviceId;
    const state = get();
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (isTauri() && state.mediaEngine != null) {
      if (!owner?.current || !action) return false;
      try {
        await switchNativeInputDevice(normalizedDeviceId ?? null, { id: state.mediaEngine.sessionOwnerId ?? owner.id, assertCurrent: action.assertCurrent });
        return true;
      } catch (err) {
        console.warn('[voice] Failed to switch native input device:', err);
        return false;
      }
    }
    const room = state.room;
    // No active room: the selection is persisted and applied on next connect,
    // so this is a success, not a swallowed failure.
    if (!room) return true;
    let resolvedDeviceId = normalizedDeviceId;
    if (resolvedDeviceId && invalidAudioInputDeviceIds.has(resolvedDeviceId)) {
      resolvedDeviceId = undefined;
    }
    try {
      try {
        await room.switchActiveDevice('audioinput', resolvedDeviceId ?? 'default');
      } catch (err) {
        // Device constraints can fail for stale IDs and occasionally even for
        // "default" when browser/device state changes. Recover by forcing a
        // fresh mic publish path with default capture selection.
        if (isDeviceConstraintError(err)) {
          console.warn(
            '[voice] Input device constraints failed; resetting to default microphone:',
            err
          );
          if (resolvedDeviceId) {
            invalidAudioInputDeviceIds.add(resolvedDeviceId);
          }
          resolvedDeviceId = undefined;
        } else {
          throw err;
        }
      }
      // If the user is currently unmuted, ensure the active mic is enabled
      // on the newly selected device.
      if (!action?.current()) return false;
      if (!state.selfMute && !state.selfDeaf) {
        const ok = await setMicrophoneEnabledWithFallback(room, true, resolvedDeviceId);
        if (ok) {
          startLocalAudioUplinkMonitor(room);
        }
      }
      return true;
    } catch (err) {
      console.warn('[voice] Failed to switch input device:', err);
      return false;
    }
  },
  applyAudioOutputDevice: async (deviceId) => {
    const owner = currentCall;
    const action = owner?.operation('output-device');
    if (owner?.current) owner.preferences['audioOutputDeviceId'] = deviceId;
    const state = get();
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    selectedAudioOutputDeviceId = normalizedDeviceId;
    const room = state.room;
    let ok = true;
    if (room) {
      try {
        await room.switchActiveDevice('audiooutput', normalizedDeviceId ?? 'default');
        if (!action?.current()) return false;
        await applyAttachedRemoteAudioOutput(normalizedDeviceId);
      } catch (err) {
        console.warn('[voice] Failed to switch output device:', err);
        ok = false;
      }
    }
    // On the native (QUIC) path the WebView's setSinkId cannot reach cpal's
    // output device, so also route the OS output device through the native
    // media command. Degrades to a no-op on web / older desktop builds.
    if (isTauri() && state.mediaEngine != null) {
      if (!owner?.current || !action) return false;
      try {
        await switchNativeOutputDevice(normalizedDeviceId ?? null, { id: state.mediaEngine.sessionOwnerId ?? owner.id, assertCurrent: action.assertCurrent });
      } catch (err) {
        console.warn('[voice] Failed to switch native output device:', err);
        ok = false;
      }
    }
    return ok;
  },
  reapplyAudioConstraints: async () => {
    const owner = currentCall;
    if (!owner?.current) return;
    const preferences = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
    for (const key of ['noiseSuppression', 'echoCancellation', 'autoGainControl', 'voiceIsolation']) {
      if (key in preferences) owner.preferences[key] = preferences[key];
    }
    const state = get();
    const room = state.room;
    if (!room || !state.connected) return;
    // Only re-acquire if the mic is currently active (not muted/deafened).
    if (state.selfMute || state.selfDeaf) return;
    const inputId = getSavedInputDeviceId();
    try {
      await setMicrophoneEnabledWithFallback(room, true, inputId);
    } catch (err) {
      console.warn('[voice] Failed to reapply audio constraints:', err);
    }
  },
  clearConnectionError: () => set({ connectionError: null, connectionErrorChannelId: null }),
  handleMediaTransportLost: async (reason) => {
    const owner = currentCall;
    if (owner) await closeCall(owner, reason || 'Voice connection lost');
  },
  acknowledgeSystemAudioPrivacyWarning: () => {
    persistSystemAudioPrivacyWarningAcknowledgement();
    set({ showSystemAudioPrivacyWarning: false });
  },

  handleVoiceStateUpdate: (voiceState, scope) => {
    if (currentCall && (!scope || accountScopeKey(scope) !== currentCall.context.key)) return;
    const owner = currentCall;
    const previous = get().participants.get(voiceState.user_id);
    if (!voiceState.channel_id && voiceState.session_id && previous?.session_id && previous.session_id !== voiceState.session_id) return;
    if (owner?.current && voiceState.user_id === owner.context.scope.userId && voiceState.session_id) {
      if (voiceState.session_id !== owner.membershipSessionId) return;
      if (!voiceState.channel_id) { void closeCall(owner); return; }
    }
    // Determine join/leave sounds BEFORE mutating state so we can compare
    // the previous channel of the updating user against our current channel.
    const currentState = get();
    const localUserId = currentCallUser()?.id;
    const myChannelId = currentState.channelId;

    if (
      localUserId &&
      myChannelId &&
      currentState.connected &&
      voiceState.user_id !== localUserId
    ) {
      const previousVoiceState = currentState.participants.get(voiceState.user_id);
      const wasInMyChannel = previousVoiceState?.channel_id === myChannelId;
      const isNowInMyChannel = voiceState.channel_id === myChannelId;

      if (!wasInMyChannel && isNowInMyChannel) {
        // Someone joined our voice channel
        playVoiceJoinSound();
      } else if (wasInMyChannel && !isNowInMyChannel) {
        // Someone left our voice channel
        playVoiceLeaveSound();
      }
    }

    set((state) => {
      // Ignore stale self-leave updates while the local LiveKit room or native
      // media engine is still connected. The server can emit transient
      // participant_left events during reconnects, but local connection state
      // is the stronger signal for "still in voice".
      if (
        voiceState.user_id === localUserId &&
        !voiceState.channel_id &&
        state.connected &&
        state.channelId &&
        (
          (state.room && state.room.state !== ConnectionState.Disconnected) ||
          state.mediaEngine != null
        )
      ) {
        return state;
      }

      // For the local user, prefer local self_stream/self_video state over
      // gateway values. The gateway event may carry stale self_stream: true
      // that was dispatched before the server processed our stopStream call,
      // which would re-show the LIVE badge after we just cleared it locally.
      let mergedVoiceState = voiceState;
      if (voiceState.user_id === localUserId && voiceState.channel_id && state.connected) {
        mergedVoiceState = {
          ...voiceState,
          self_stream: state.selfStream,
          self_video: state.selfVideo,
        };
      }

      const participants = new Map(state.participants);
      if (mergedVoiceState.channel_id) {
        participants.set(mergedVoiceState.user_id, mergedVoiceState);
      } else {
        participants.delete(mergedVoiceState.user_id);
      }

      // Update global channel participants
      const channelParticipants = new Map(state.channelParticipants);
      // A non-null channel_id means a move to that channel. Remove user from
      // all existing channel lists first to avoid duplicate sidebar entries.
      for (const [chId, members] of channelParticipants) {
        const filtered = members.filter((p) => p.user_id !== mergedVoiceState.user_id);
        if (filtered.length === 0) {
          channelParticipants.delete(chId);
        } else if (filtered.length !== members.length) {
          channelParticipants.set(chId, filtered);
        }
      }
      if (mergedVoiceState.channel_id) {
        const existing = channelParticipants.get(mergedVoiceState.channel_id) || [];
        channelParticipants.set(mergedVoiceState.channel_id, [...existing, mergedVoiceState]);
      }

      const watchedStreamerId =
        state.watchedStreamerId && participants.has(state.watchedStreamerId)
          ? state.watchedStreamerId
          : null;
      const previewStreamerId =
        state.previewStreamerId && participants.has(state.previewStreamerId)
          ? state.previewStreamerId
          : null;

      return { participants, channelParticipants, watchedStreamerId, previewStreamerId };
    });
  },

  loadVoiceStates: (guildId, states, scope) =>
    set((prev) => {
      if (currentCall && (!scope || accountScopeKey(scope) !== currentCall.context.key)) return prev;
      const channelParticipants = new Map(prev.channelParticipants);
      const participants = new Map(prev.participants);
      const myId = currentCallUser()?.id;
      const existingLocal = myId ? prev.participants.get(myId) : undefined;
      // Preserve local voice presence when we're actively connected in this
      // guild, even if READY briefly arrives with stale or empty voice states.
      const localVoiceState =
        prev.connected && prev.channelId && prev.guildId === guildId
          ? buildLocalVoiceState(
            prev.channelId,
            guildId,
            existingLocal?.session_id ?? '',
            prev.selfMute,
            prev.selfDeaf,
            prev.selfStream,
            prev.selfVideo
          )
          : null;

      // READY can carry stale self rows after crashes/restarts; always skip our
      // own row and rely on active local connection state instead.
      const shouldSkipReadySelf = true;
      // READY is authoritative for this guild. Clear old entries first.
      for (const [chId, members] of channelParticipants) {
        const retained = members.filter((m) => m.guild_id !== guildId);
        if (retained.length === 0) {
          channelParticipants.delete(chId);
        } else {
          channelParticipants.set(chId, retained);
        }
      }
      for (const [userId, state] of participants) {
        if (state.guild_id === guildId) {
          participants.delete(userId);
        }
      }
      const latestByUser = new Map<string, VoiceState>();
      for (const vs of states) {
        if (!vs.channel_id) continue;
        if (shouldSkipReadySelf && vs.user_id === myId) continue;
        latestByUser.set(vs.user_id, {
          ...vs,
          guild_id: vs.guild_id || guildId,
        });
      }
      for (const vs of latestByUser.values()) {
        const targetChannelId = vs.channel_id;
        if (!targetChannelId) continue;
        const existing = channelParticipants.get(targetChannelId) || [];
        channelParticipants.set(targetChannelId, [...existing, vs]);
        participants.set(vs.user_id, vs);
      }

      if (localVoiceState?.channel_id) {
        const existing = (channelParticipants.get(localVoiceState.channel_id) || []).filter(
          (p) => p.user_id !== localVoiceState.user_id
        );
        existing.push(localVoiceState);
        channelParticipants.set(localVoiceState.channel_id, existing);
        participants.set(localVoiceState.user_id, localVoiceState);
      }
      return { channelParticipants, participants };
    }),

  setSpeakingUsers: (userIds) =>
    set((state) => {
      // ActiveSpeakers / native speaking ticks can repeat the same membership;
      // skip allocating a new Set (and notifying subscribers) when unchanged.
      if (
        state.speakingUsers.size === userIds.length &&
        userIds.every((id) => state.speakingUsers.has(id))
      ) {
        return state;
      }
      return { speakingUsers: new Set(userIds) };
    }),

  setWatchedStreamer: (userId) =>
    set({
      watchedStreamerId: userId,
    }),

  setPreviewStreamer: (userId) =>
    set({
      previewStreamerId: userId,
    }),

  setPttEngaged: (engaged) => set({ pttEngaged: engaged }),
}));

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { if (currentCall) void closeCall(currentCall); });
}
subscribeServerDisconnect(serverId => {
  if (currentCall?.target.scope.serverId === serverId) void closeCall(currentCall);
});
registerSessionReset('voice', () => useVoiceStore.getState().reset());

function createLivekitRoom(): Room {
  return new Room({
        // Audio capture defaults: read user's voice settings for noise
        // suppression, echo cancellation, and voice isolation.
        audioCaptureDefaults: buildAudioCaptureOptions() as AudioCaptureOptions,
        // Publish defaults tuned for voice chat.
        publishDefaults: {
          audioPreset: AudioPresets.speech,
          dtx: false,
          // Prefer broad compatibility across browsers/WebViews and mixed
          // client versions. Some peers fail to decode RED reliably, causing
          // one-way audio (you can hear them, they can't hear you).
          red: false,
          forceStereo: false,
          stopMicTrackOnMute: false,
          // Default screen share encoding as a safety net. The startStream
          // method passes preset-specific encoding on each publish, but this
          // ensures any fallback screen-share path still gets decent quality.
          screenShareEncoding: {
            maxBitrate: 15_000_000,
            maxFramerate: 60,
            priority: 'high',
          },
          screenShareSimulcastLayers: [],
        },
        // Adaptive stream adjusts subscribed quality based on element size.
        // Disabled because it causes screen share viewers to get low quality
        // when the video element hasn't been resized to full size yet.
        adaptiveStream: false,
        // Pause video layers no subscriber is watching.
        dynacast: true,
        // livekit-client v2.17 defaults to single-PC mode. In this deployment
        // we observe periodic signal disconnect loops with that mode enabled.
        // Force dual-PC mode for stability unless/until upstream behavior changes.
        singlePeerConnection: false,
        // Let the LiveKit reconnect policy handle transient disconnects
        // instead of proactively tearing down on page lifecycle events.
        // With disconnectOnPageLeave enabled, HMR reloads, service worker
        // updates, and browser power-saving pagehide events all cause
        // spurious disconnects while the user is idle in a voice call.
        // LiveKit's participant_left webhook handles server-side cleanup
        // when the WebRTC peer connection truly goes away.
        disconnectOnPageLeave: false,
        // Be generous with reconnection so transient signal drops
        // (e.g. hairpin NAT, brief proxy hiccups) don't kick the user.
        reconnectPolicy: {
          nextRetryDelayInMs: (context) => {
            // Retry up to 15 times with 1-second delays (about 15 seconds
            // total).  Returning null stops retrying.
            if (context.retryCount >= 15) return null;
            return 1000;
          },
        },
      });
}

/** Only the owner being closed may clear the current projection or shared DOM. */
function closeCall(owner: CallSession, error?: string): Promise<void> {
  const existing = callReleasePromises.get(owner);
  if (existing) return existing;
  const closingCurrent = currentCall === owner;
  const release = owner.close();
  callReleasePromises.set(owner, release);
  if (closingCurrent) {
    clearActiveRoomListeners();
    stopLocalMicAnalyser();
    stopLocalAudioUplinkMonitor();
    stopRemoteAudioReconcile();
    detachAllAttachedRemoteAudio();
    suppressVoiceForStream(false);
    forceRedForCompatibility = false;
    selectedAudioOutputDeviceId = undefined;
    currentCall = null;
    useVoiceStore.setState(state => {
      const channelParticipants = new Map(state.channelParticipants);
      const members = (channelParticipants.get(owner.target.channelId) ?? [])
        .filter(member => member.user_id !== owner.context.user.id);
      if (members.length) channelParticipants.set(owner.target.channelId, members);
      else channelParticipants.delete(owner.target.channelId);
      return {
        callId: null, callScope: null, callPhase: error ? 'failed' : 'idle',
        connected: false, joining: false, joiningChannelId: null, channelId: null, guildId: null,
        connectionError: error ?? null, connectionErrorChannelId: error ? owner.target.channelId : null,
        room: null, mediaEngine: null, livekitToken: null, livekitUrl: null, roomName: null, voiceSessionId: null,
        selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false,
        participants: new Map(), channelParticipants, speakingUsers: new Set(),
        streamAudioWarning: null, systemAudioCaptureActive: false, voiceSuppressedForStream: false,
        watchedStreamerId: null, previewStreamerId: null, pttEngaged: false,
      };
    });
  }
  // A canceled join can still return a receipt. Keep its captured account alive
  // until that response settles; never send compensation using the next login.
  void (owner.joinPromise ?? Promise.resolve()).catch(() => {}).then(async () => {
    try {
      const sessionId = owner.membershipSessionId;
      if (sessionId && !owner.context.signal.aborted) {
        await createCallVoiceApi(owner.context).leave(owner.target.channelId, owner.target.guildId === 'dm', sessionId);
      }
    } catch (failure) {
      console.warn('[voice] Conditional membership cleanup pending:', failure);
    } finally {
      owner.context.dispose();
    }
  });
  return release;
}

function ownLivekitRoom(owner: CallSession, room: Room): () => Promise<void> {
  const lease = { owner, active: true };
  roomOwners.set(room, lease);
  // The SDK's capture promises cannot be aborted. Stop any tracks they produce
  // after release, including a permission dialog resolved after disconnect.
  const participant = room.localParticipant as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const key of ['setMicrophoneEnabled', 'setCameraEnabled', 'setScreenShareEnabled', 'publishTrack']) {
    const original = participant[key]?.bind(room.localParticipant);
    if (!original) continue;
    participant[key] = async (...args) => {
      if (!isCurrentRoom(room)) throw new DOMException('The call has ended.', 'AbortError');
      const result = await original(...args);
      if (!isCurrentRoom(room)) {
        for (const publication of room.localParticipant.trackPublications.values()) publication.track?.stop();
        await room.disconnect().catch(() => {});
        throw new DOMException('The call has ended.', 'AbortError');
      }
      return result;
    };
  }
  const removeListeners = registerRoomListeners(room, reason => {
    if (isCurrentRoom(room)) void closeCall(owner, `Voice connection lost${reason === undefined ? '' : ` (${reason})`}`);
  });
  return owner.own(async () => {
    lease.active = false;
    removeListeners();
    if (localMicAnalyserRoom === room) stopLocalMicAnalyser();
    if (localAudioUplinkMonitorRoom === room) stopLocalAudioUplinkMonitor();
    if (remoteAudioReconcileRoom === room) stopRemoteAudioReconcile();
    for (const publication of room.localParticipant.trackPublications.values()) publication.track?.stop();
    await room.disconnect();
  });
}

function bindEngine(owner: CallSession, engine: MediaEngine): void {
  const { channelId, guildId, scope } = owner.target;
  engine.onParticipantJoin(owner.guard(userId => {
    useVoiceStore.getState().handleVoiceStateUpdate({
      user_id: userId, channel_id: channelId, guild_id: guildId === 'dm' ? undefined : guildId ?? undefined,
      session_id: '', self_mute: false, self_deaf: false, self_stream: false, self_video: false,
      mute: false, deaf: false, suppress: false,
    }, scope);
  }));
  engine.onParticipantLeave(owner.guard(userId => {
    useVoiceStore.getState().handleVoiceStateUpdate({
      user_id: userId, channel_id: undefined, session_id: '', self_mute: false, self_deaf: false,
      self_stream: false, self_video: false, mute: false, deaf: false, suppress: false,
    }, scope);
  }));
  engine.onSpeakingChange(owner.guard(speakers => {
    useVoiceStore.getState().setSpeakingUsers([...speakers.keys()].map(id => id === 'local' ? owner.context.user.id : id));
  }));
  engine.onTransportLost(owner.guard(reason => { void closeCall(owner, reason); }));
  engine.onCameraFailure?.(owner.guard(error => {
    useVoiceStore.setState({ selfVideo: false });
    useToastStore.getState().addToast('error', error.message);
  }));
}

function commitCall(owner: CallSession, data: VoiceJoinResponse, media: { room: Room } | { mediaEngine: MediaEngine }, muted: boolean, deafened: boolean): void {
  owner.assertCurrent();
  owner.phase = 'connected';
  const local = buildLocalVoiceState(owner.target.channelId, owner.target.guildId, data.session_id ?? '', muted, deafened, false, false, data.suppress === true);
  useVoiceStore.setState(state => {
    const channelParticipants = new Map(state.channelParticipants);
    const participants = new Map<string, VoiceState>();
    for (const member of channelParticipants.get(owner.target.channelId) ?? []) participants.set(member.user_id, member);
    if (local) {
      participants.set(local.user_id, local);
      channelParticipants.set(owner.target.channelId, [...participants.values()]);
    }
    return {
      ...media, room: 'room' in media ? media.room : null, mediaEngine: 'mediaEngine' in media ? media.mediaEngine : null,
      callPhase: 'connected', connected: true, joining: false, joiningChannelId: null,
      channelId: owner.target.channelId, guildId: owner.target.guildId,
      livekitToken: data.token, livekitUrl: data.url, roomName: data.room_name,
      voiceSessionId: data.session_id ?? null, selfMute: muted, selfDeaf: deafened,
      participants, channelParticipants,
    };
  });
  if ('room' in media) syncLivekitRoomPresence(media.room);
  playVoiceJoinSound();
}

async function performCallJoin(owner: CallSession, previousMute: boolean, previousDeaf: boolean): Promise<void> {
  configureLivekitLogging();
  const api = createCallVoiceApi(owner.context);
  const { channelId, guildId } = owner.target;
  const isDm = guildId === 'dm';
  const ptt = getNotificationSettings()['voiceInputMode'] === 'push_to_talk';
  const shouldMute = previousMute || previousDeaf || ptt;
  const receiveJoin = async (fallback?: 'livekit') => {
    owner.assertCurrent();
    owner.membershipUncertain = true;
    const { data } = await api.join(channelId, isDm, fallback);
    owner.membershipSessionId = data.session_id ?? null;
    owner.membershipUncertain = !data.session_id;
    owner.assertCurrent();
    return data;
  };
  try {
    let data = await receiveJoin();
    if (data.native_media || useVoiceStore.getState().useNativeMedia) {
      const candidates = (data.media_endpoint_candidates?.length ? data.media_endpoint_candidates : [data.media_endpoint, data.url])
        .filter((url): url is string => typeof url === 'string' && !!url.trim());
      const token = data.media_token || data.token;
      let nativeError: unknown = new Error('Server did not return native media connection details');
      if (candidates.length && token) {
        for (const endpoint of candidates) {
          owner.assertCurrent();
          const engine = await createMediaEngine();
          const release = owner.own(() => engine.disconnect());
          try {
            owner.assertCurrent();
            bindEngine(owner, engine);
            await engine.connect(endpoint, token, data.cert_hash, {
              id: owner.id,
              signal: owner.signal,
              account: owner.context,
              // The join response's pin is correct now; a reconnect minutes or
              // hours later may not be, because the server rotates its media
              // certificate. Let the engine re-read it rather than replay it.
              refreshCertHash: () => api.mediaCertificatePin(),
            });
            owner.assertCurrent();
            const muted = shouldMute || data.suppress === true;
            engine.setMute(muted);
            engine.setDeaf(previousDeaf);
            commitCall(owner, data, { mediaEngine: engine }, muted, previousDeaf);
            return;
          } catch (error) {
            nativeError = error;
            await release();
            owner.assertCurrent();
          }
        }
      }
      if (data.native_media || (candidates.length && token)) {
        if (!allowNativeToLivekitFallback() || !(data.livekit_available || (data.url && data.token))) throw nativeError;
        if (owner.membershipSessionId) await api.leave(channelId, isDm, owner.membershipSessionId);
        owner.membershipSessionId = null;
        data = await receiveJoin('livekit');
      }
    }
    owner.assertCurrent();
    const candidates = buildLivekitConnectCandidates(data.url, data.url_candidates);
    if (!candidates.length) candidates.push(normalizeLivekitUrlFromServerValue(data.url));
    if (TAURI_FAST_CONNECT && candidates.length > 1) {
      const best = await findReachableLivekitUrl(candidates, 3_000);
      owner.assertCurrent();
      candidates.splice(0, candidates.length, best, ...candidates.filter(candidate => candidate !== best));
    }
    let lastError: unknown = new Error('Unable to establish LiveKit signaling connection');
    for (const candidate of candidates) {
      for (let retry = 0; retry < LIVEKIT_CONNECT_ATTEMPTS_PER_CANDIDATE; retry++) {
        owner.assertCurrent();
        const room = createLivekitRoom();
        const release = ownLivekitRoom(owner, room);
        try {
          await connectWithAttemptTimeout(room, owner, candidate, data.token);
          tuneLivekitSignalHeartbeat(room);
          await room.startAudio().catch(() => {});
          owner.assertCurrent();
          const output = getSavedOutputDeviceId();
          selectedAudioOutputDeviceId = output;
          if (output) await room.switchActiveDevice('audiooutput', output).catch(() => {});
          owner.assertCurrent();
          await applyAttachedRemoteAudioOutput(output);
          owner.assertCurrent();
          const microphone = await setMicrophoneEnabledWithFallback(room, !shouldMute && !data.suppress, getSavedInputDeviceId());
          owner.assertCurrent();
          commitCall(owner, data, { room }, shouldMute || !microphone || data.suppress === true, previousDeaf);
          if (microphone && !shouldMute) startLocalAudioUplinkMonitor(room);
          setAttachedRemoteAudioMuted(previousDeaf);
          syncRemoteAudioTracks(room, previousDeaf);
          return;
        } catch (error) {
          lastError = error;
          await release();
          owner.assertCurrent();
          if (!isTransientVoiceConnectError(error instanceof Error ? error.message : String(error))) break;
          await owner.delay(computeConnectRetryDelayMs(retry, LIVEKIT_CONNECT_RETRY_BASE_DELAY_MS));
        }
      }
    }
    throw lastError;
  } catch (error) {
    if (!owner.current) { await closeCall(owner); return; }
    const message = error instanceof Error ? error.message : 'Unable to connect to voice';
    await closeCall(owner, owner.membershipUncertain ? `${message}. Server membership has not been confirmed.` : message);
  }
}
