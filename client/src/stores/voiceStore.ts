import { create } from 'zustand';
import type { VoiceState } from '../types';
import { voiceApi } from '../api/voice';
import {
  Room,
  RoomEvent,
  ParticipantEvent,
  Track,
  DisconnectReason,
  ConnectionState,
  AudioPresets,
  createAudioAnalyser,
  type AudioCaptureOptions,
  type Participant,
  type LocalAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useAuthStore } from './authStore';
import { playVoiceJoinSound, playVoiceLeaveSound } from '../lib/voiceSounds';
import { NoiseGateProcessor } from '../lib/noiseGate';
import { startNativeSystemAudio, stopNativeSystemAudio } from '../lib/systemAudioCapture';

const INTERNAL_LIVEKIT_HOSTS = new Set([
  'host.docker.internal',
  'livekit',
  'docker-livekit-1',
  '0.0.0.0',
  '::',
]);

function resolveClientRtcHostname(): string {
  if (typeof window === 'undefined') {
    return 'localhost';
  }
  const host = window.location.hostname;
  if (!host) {
    return 'localhost';
  }
  // Tauri and local dev hosts should map to loopback for local LiveKit.
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host.endsWith('.localhost')
  ) {
    return 'localhost';
  }
  return host;
}

function normalizeLivekitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (INTERNAL_LIVEKIT_HOSTS.has(parsed.hostname)) {
      parsed.hostname = resolveClientRtcHostname();
    }
    // Ensure the URL uses a WebSocket protocol. LiveKit needs ws:// or wss://.
    let protocol = parsed.protocol;
    if (protocol === 'http:') protocol = 'ws:';
    else if (protocol === 'https:') protocol = 'wss:';
    // livekit-client can fail on URLs normalized to "...//rtc" when base path is "/".
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url
      .replace('host.docker.internal', 'localhost')
      .replace('livekit', 'localhost')
      .replace('0.0.0.0', 'localhost')
      .replace('[::]', 'localhost')
      .replace('::', 'localhost')
      .replace(/\/+$/, '');
  }
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
let forceRedForCompatibility = false;
let audioCodecSwitchCooldownUntil = 0;
let activeNoiseGate: NoiseGateProcessor | null = null;
type MicUplinkState = 'idle' | 'sending' | 'stalled' | 'recovering' | 'muted' | 'no_track';

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
  for (const element of attachedRemoteAudioElements.values()) {
    element.muted = muted;
    // Belt-and-suspenders: setting volume to 0 ensures silence even when the
    // muted attribute is not respected for MediaStream sources in some
    // WebView/browser environments (e.g. Tauri WebView2).
    element.volume = muted ? 0 : 1;
    // Disable the underlying MediaStreamTrack objects so no audio data reaches
    // the output at all. This is the most reliable deafen mechanism because
    // some runtimes ignore muted/volume on elements with MediaStream sources.
    const stream = element.srcObject;
    if (stream instanceof MediaStream) {
      for (const audioTrack of stream.getAudioTracks()) {
        audioTrack.enabled = !muted;
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
    const localUserId = useAuthStore.getState().user?.id;
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

      if (
        localAudioStalledIntervals > 0 &&
        (localAudioStalledIntervals === 2 ||
          localAudioStalledIntervals === 4 ||
          localAudioStalledIntervals === 6)
      ) {
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
      // If speaking detection is unavailable/misses, still force recovery
      // after a longer stall to avoid persistent one-way audio.
      if (
        localAudioStalledIntervals >= 4 &&
        (localMicSpeakingFallback || localAudioStalledIntervals >= 6) &&
        !localAudioRecoveryInFlight
      ) {
        localAudioRecoveryInFlight = true;
        useVoiceStore.setState({
          micUplinkState: 'recovering',
          micUplinkBytesSent: bytesSent,
          micUplinkStalledIntervals: localAudioStalledIntervals,
        });
        console.warn('[voice] Mic uplink appears stalled; restarting microphone track.');
        await setMicrophoneEnabledWithFallback(room, true, getSavedInputDeviceId()).catch(() => {});
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
  const currentMatchesPolicy =
    publication != null &&
    ((nextForceRed && isRedMime(currentMime)) || (!nextForceRed && isOpusMime(currentMime)));

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
  stopLocalMicAnalyser(false);
  const localUserId = useAuthStore.getState().user?.id;
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
      localMicSmoothedVolume = localMicSmoothedVolume * 0.55 + rawVolume * 0.45;
      const onThreshold = 0.055;
      const offThreshold = 0.03;
      const speaking = locallyMuted
        ? false
        : localMicSpeakingFallback
          ? localMicSmoothedVolume > offThreshold
          : localMicSmoothedVolume > onThreshold;
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
    if (
      pub.source === Track.Source.ScreenShare &&
      pub.track &&
      pub.track.mediaStreamTrack?.readyState !== 'ended'
    ) {
      hasScreenShare = true;
    }
    if (
      pub.source === Track.Source.Camera &&
      pub.track &&
      pub.track.mediaStreamTrack?.readyState !== 'ended'
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
    username: existing?.username || participant.name || undefined,
    avatar_hash: existing?.avatar_hash,
  };
}

function syncLivekitRoomPresence(room: Room): void {
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
  const notif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
  const deviceId =
    typeof notif['audioInputDeviceId'] === 'string'
      ? (notif['audioInputDeviceId'] as string).trim()
      : '';
  return deviceId.length > 0 ? deviceId : undefined;
}

function getSavedOutputDeviceId(): string | undefined {
  const notif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
  const deviceId =
    typeof notif['audioOutputDeviceId'] === 'string'
      ? (notif['audioOutputDeviceId'] as string).trim()
      : '';
  return deviceId.length > 0 ? deviceId : undefined;
}

/** Whether the user has noise suppression enabled (defaults to true). */
function getSavedNoiseSuppression(): boolean {
  const notif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
  return Boolean(notif['noiseSuppression'] ?? true);
}

/** Whether the user has echo cancellation enabled (defaults to true). */
function getSavedEchoCancellation(): boolean {
  const notif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
  return Boolean(notif['echoCancellation'] ?? true);
}

/**
 * Build the audio capture options reflecting the user's saved voice settings.
 * When noise suppression is enabled we also request `voiceIsolation` which
 * is a much stronger ML-based noise suppressor available in Chrome 116+ and
 * Edge.  It suppresses keyboards, breathing, tapping, and other background
 * noise far more effectively than the basic `noiseSuppression` constraint.
 */
function buildAudioCaptureOptions(deviceId?: string): Record<string, unknown> {
  const ns = getSavedNoiseSuppression();
  const ec = getSavedEchoCancellation();
  const opts: Record<string, unknown> = {
    autoGainControl: true,
    echoCancellation: ec,
    noiseSuppression: ns,
    // Voice Isolation (W3C mediacapture-extensions) is a stronger, ML-based
    // alternative to basic noiseSuppression.  When enabled the browser will
    // isolate the user's voice and suppress environmental noise (keyboards,
    // fans, breathing, etc).  Unsupported browsers silently ignore this.
    voiceIsolation: ns,
    channelCount: 1,
  };
  if (deviceId) {
    opts.deviceId = deviceId;
  }
  return opts;
}

/**
 * Apply or remove the noise gate processor on the published mic track.
 * Called after mic is enabled and after voice settings are saved.
 */
async function applyNoiseGateIfNeeded(room: Room): Promise<void> {
  const nsEnabled = getSavedNoiseSuppression();
  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const localTrack = publication?.track;
  if (!localTrack) return;

  // Cast to access setProcessor — LiveKit LocalAudioTrack has this method
  const audioTrack = localTrack as unknown as {
    setProcessor(p: NoiseGateProcessor | undefined): Promise<void>;
    getProcessor(): { name: string } | undefined;
  };

  if (nsEnabled) {
    // Only create a new gate if one isn't already active
    if (!activeNoiseGate || audioTrack.getProcessor()?.name !== 'noise-gate') {
      if (activeNoiseGate) {
        await activeNoiseGate.destroy().catch(() => {});
      }
      activeNoiseGate = new NoiseGateProcessor();
      try {
        await audioTrack.setProcessor(activeNoiseGate);
        console.info('[voice] Noise gate processor attached');
      } catch (err) {
        console.warn('[voice] Failed to attach noise gate processor:', err);
        activeNoiseGate = null;
      }
    }
  } else {
    // Remove noise gate
    if (activeNoiseGate) {
      try {
        await audioTrack.setProcessor(undefined as unknown as NoiseGateProcessor);
      } catch {
        // Some versions don't support removing — just destroy
      }
      await activeNoiseGate.destroy().catch(() => {});
      activeNoiseGate = null;
      console.info('[voice] Noise gate processor removed');
    }
  }
}

function normalizeDeviceId(deviceId?: string | null): string | undefined {
  if (!deviceId) return undefined;
  const trimmed = deviceId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  if (existing) {
    track.detach(existing);
    existing.remove();
    attachedRemoteAudioElements.delete(key);
  }
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.style.display = 'none';
  audio.setAttribute('data-paracord-voice-audio', 'true');
  if (participantIdentity) {
    audio.setAttribute('data-paracord-voice-participant', participantIdentity);
  }
  if (publication.trackSid) {
    audio.setAttribute('data-paracord-voice-track-sid', publication.trackSid);
  }
  void setAudioElementOutputDevice(audio, selectedAudioOutputDeviceId);
  // Attach FIRST — LiveKit's track.attach() internally resets element.muted
  // to false and may override other properties. We set our deafen overrides
  // AFTER attach so they stick.
  track.attach(audio);
  audio.muted = muted;
  audio.volume = muted ? 0 : 1;
  if (muted) {
    const stream = audio.srcObject;
    if (stream instanceof MediaStream) {
      for (const audioTrack of stream.getAudioTracks()) {
        audioTrack.enabled = false;
      }
    }
  }
  document.body.appendChild(audio);
  attachedRemoteAudioElements.set(key, audio);
  void audio.play().catch(() => {
    // Autoplay was blocked by browser policy. Retry on the next user
    // interaction so audio starts flowing once the user clicks/taps.
    const resumeOnGesture = () => {
      audio.play().catch(() => {});
      document.removeEventListener('click', resumeOnGesture);
      document.removeEventListener('keydown', resumeOnGesture);
    };
    document.addEventListener('click', resumeOnGesture, { once: true });
    document.addEventListener('keydown', resumeOnGesture, { once: true });
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
  selfVideo: boolean
): VoiceState | null {
  const authUser = useAuthStore.getState().user;
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
    suppress: false,
    username: authUser.username,
    avatar_hash: authUser.avatar_hash,
  };
}

async function setMicrophoneEnabledWithFallback(
  room: Room,
  enabled: boolean,
  preferredDeviceId?: string
): Promise<boolean> {
  const redPreferred = forceRedForCompatibility || shouldForceRedCompatibility(room);
  forceRedForCompatibility = redPreferred;
  const microphonePublishOptions = {
    audioPreset: AudioPresets.speech,
    // Mirror peer compatibility mode: RED pairs better with DTX, while Opus-only
    // mode is more reliable with continuous packets.
    dtx: redPreferred,
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

  if (!enabled) {
    return room.localParticipant
      .setMicrophoneEnabled(false)
      .then(() => true)
      .catch((err) => {
        console.warn('[voice] Failed to disable microphone:', err);
        return false;
      });
  }

  // Force a fresh publication before enabling so selected input device and
  // publish options are always applied.
  try {
    const existingPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (existingPublication) {
      await room.localParticipant.setMicrophoneEnabled(false);
    }
  } catch (err) {
    console.warn('[voice] Failed to reset existing microphone publication:', err);
  }

  // Build capture options that include the user's noise suppression,
  // echo cancellation, and voice isolation preferences so every mic
  // enable/republish path applies them consistently.
  const captureOptions = buildAudioCaptureOptions(preferredDeviceId);

  if (preferredDeviceId) {
    try {
      await room.localParticipant.setMicrophoneEnabled(
        true,
        captureOptions,
        microphonePublishOptions
      );
      await ensurePublishedTrackUnmuted();
      await applyNoiseGateIfNeeded(room);
      return true;
    } catch (err) {
      console.warn('[voice] Saved input device failed, retrying default input:', err);
    }
  }

  try {
    const defaultCaptureOptions = buildAudioCaptureOptions();
    await room.localParticipant.setMicrophoneEnabled(true, defaultCaptureOptions, microphonePublishOptions);
    await ensurePublishedTrackUnmuted();
    await applyNoiseGateIfNeeded(room);
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
): void {
  const speakingHandlers = new Map<string, (speaking: boolean) => void>();
  const bindParticipantSpeaking = (participant: Participant) => {
    const identity = participant.identity;
    if (!identity || speakingHandlers.has(identity)) return;
    const handler = (speaking: boolean) => {
      setSpeakingForIdentity(identity, speaking);
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
    setSpeakingForIdentity(identity, false);
  };
  bindParticipantSpeaking(room.localParticipant);
  for (const participant of room.remoteParticipants.values()) {
    bindParticipantSpeaking(participant);
  }
  refreshAudioCodecCompatibility(room, 'initial-listener-bind');
  syncLivekitRoomPresence(room);
  startRemoteAudioReconcile(room);

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    const speakingIds = new Set(speakers.map((s) => s.identity));
    const localUserId = useAuthStore.getState().user?.id;
    const serverDetectedLocalSpeaking = !!(localUserId && speakingIds.has(localUserId));
    useVoiceStore.setState({ micServerDetected: serverDetectedLocalSpeaking });
    // Fallback to local analyser for self speaking so the local ring still
    // reflects microphone activity even when server speaker updates lag.
    if (localUserId && localMicSpeakingFallback) {
      speakingIds.add(localUserId);
    }
    useVoiceStore.getState().setSpeakingUsers(Array.from(speakingIds));
  });
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    bindParticipantSpeaking(participant);
    refreshAudioCodecCompatibility(room, `participant-connected:${participant.identity}`);
    // Re-check shortly after connect to catch late track metadata updates.
    setTimeout(() => refreshAudioCodecCompatibility(room, 'participant-connected-delayed'), 300);
    setTimeout(() => refreshAudioCodecCompatibility(room, 'participant-connected-late'), 1500);
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShareAudio) {
        continue;
      }
      if (publication.kind === Track.Kind.Audio && !publication.isSubscribed) {
        publication.setSubscribed(true);
      }
    }
    syncLivekitRoomPresence(room);
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    unbindParticipantSpeaking(participant);
    refreshAudioCodecCompatibility(room, `participant-disconnected:${participant.identity}`);
    syncLivekitRoomPresence(room);
  });
  room.on(RoomEvent.LocalTrackPublished, () => {
    startLocalMicAnalyser(room);
    startLocalAudioUplinkMonitor(room);
  });
  room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if (publication.source === Track.Source.Microphone) {
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
    }
    // When the local camera track is unpublished, clear selfVideo.
    if (publication.source === Track.Source.Camera) {
      const state = useVoiceStore.getState();
      if (state.selfVideo) {
        console.info('[voice] Local camera track unpublished — clearing selfVideo');
        const localUserId = useAuthStore.getState().user?.id;
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
      void stopNativeSystemAudio();
      const state = useVoiceStore.getState();
      if (state.selfStream) {
        console.info('[voice] Local screen share track unpublished — clearing selfStream');
        const localUserId = useAuthStore.getState().user?.id;
        const participants = new Map(state.participants);
        if (localUserId) {
          const existing = participants.get(localUserId);
          if (existing) {
            participants.set(localUserId, { ...existing, self_stream: false });
          }
        }
        useVoiceStore.setState({ selfStream: false, participants });
      }
    }
  });
  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, publication: RemoteTrackPublication, participant: Participant) => {
      if (publication.source === Track.Source.ScreenShareAudio) return;
      attachRemoteAudioTrack(track, publication, useVoiceStore.getState().selfDeaf, participant.identity);
    }
  );
  room.on(RoomEvent.TrackPublished, (publication, participant) => {
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
      setTimeout(() => {
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
  });
  room.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant) => {
    console.warn('[voice] Track subscription failed:', trackSid, participant?.identity);
  });
  room.on(RoomEvent.TrackSubscriptionStatusChanged, (publication, status, participant) => {
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
  });
  room.on(
    RoomEvent.TrackUnsubscribed,
    (track: RemoteTrack, publication: RemoteTrackPublication, participant: Participant) => {
      detachRemoteAudioTrack(track, publication, participant.identity);
      // Update presence when video tracks are removed so camera/stream icons update
      if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
        syncLivekitRoomPresence(room);
      }
    }
  );
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (!room.canPlaybackAudio) {
      console.warn('[voice] Audio playback blocked — will retry on next user gesture');
      const resume = () => {
        room.startAudio().catch(() => {});
        document.removeEventListener('click', resume);
        document.removeEventListener('keydown', resume);
      };
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    }
  });
  room.on(RoomEvent.MediaDevicesError, (err: Error) => {
    console.error('[voice] Media device error:', err.message);
  });
  room.on(RoomEvent.LocalAudioSilenceDetected, () => {
    const now = Date.now();
    if (now < localSilenceRecoveryCooldownUntil) return;
    localSilenceRecoveryCooldownUntil = now + 15_000;
    const state = useVoiceStore.getState();
    if (!state.connected || state.selfMute || state.selfDeaf) return;
    console.warn('[voice] Local microphone appears silent; restarting microphone track.');
    void setMicrophoneEnabledWithFallback(room, true, getSavedInputDeviceId()).then((ok) => {
      if (ok) {
        startLocalAudioUplinkMonitor(room);
      }
    });
  });
  room.on(RoomEvent.Reconnecting, () => {
    console.warn('[voice] LiveKit reconnecting...');
  });
  room.on(RoomEvent.Reconnected, () => {
    console.info('[voice] LiveKit reconnected successfully');
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
  });
  room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    stopRemoteAudioReconcile();
    stopLocalMicAnalyser();
    stopLocalAudioUplinkMonitor();
    unbindParticipantSpeaking(room.localParticipant);
    for (const participant of room.remoteParticipants.values()) {
      unbindParticipantSpeaking(participant);
    }
    onDisconnected(reason);
  });
}

interface VoiceStoreState {
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
  room: Room | null;
  micInputActive: boolean;
  micInputLevel: number;
  micServerDetected: boolean;
  micUplinkState: MicUplinkState;
  micUplinkBytesSent: number | null;
  micUplinkStalledIntervals: number;
  watchedStreamerId: string | null;
  previewStreamerId: string | null;

  joinChannel: (channelId: string, guildId?: string) => Promise<void>;
  leaveChannel: () => Promise<void>;
  toggleMute: () => void;
  toggleDeaf: () => void;
  startStream: (qualityPreset?: string) => Promise<void>;
  stopStream: () => void;
  toggleVideo: () => void;
  applyAudioInputDevice: (deviceId: string | null) => Promise<void>;
  applyAudioOutputDevice: (deviceId: string | null) => Promise<void>;
  /** Re-acquire the microphone with the latest noise suppression / echo
   *  cancellation settings from the auth store. Call after saving voice
   *  settings so changes take effect immediately without mute/unmute. */
  reapplyAudioConstraints: () => Promise<void>;
  clearConnectionError: () => void;
  setWatchedStreamer: (userId: string | null) => void;
  setPreviewStreamer: (userId: string | null) => void;

  // Gateway event handlers
  handleVoiceStateUpdate: (state: VoiceState) => void;
  // Load initial voice states from READY payload
  loadVoiceStates: (guildId: string, states: VoiceState[]) => void;
  // Speaking state from LiveKit
  setSpeakingUsers: (userIds: string[]) => void;
}

export const useVoiceStore = create<VoiceStoreState>()((set, get) => ({
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
  room: null,
  micInputActive: false,
  micInputLevel: 0,
  micServerDetected: false,
  micUplinkState: 'idle',
  micUplinkBytesSent: null,
  micUplinkStalledIntervals: 0,
  watchedStreamerId: null,
  previewStreamerId: null,

  joinChannel: async (channelId, guildId) => {
    const previousSelfMute = get().selfMute;
    const previousSelfDeaf = get().selfDeaf;
    const shouldMuteOnJoin = previousSelfMute || previousSelfDeaf;
    const existingRoom = get().room;
    if (existingRoom) {
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
      stopRemoteAudioReconcile();
      existingRoom.removeAllListeners();
      existingRoom.disconnect();
    }
    forceRedForCompatibility = false;
    detachAllAttachedRemoteAudio();
    let room: Room | null = null;
    let joinedServer = false;
    set({
      joining: true,
      joiningChannelId: channelId,
      connectionError: null,
      connectionErrorChannelId: null,
      watchedStreamerId: null,
      previewStreamerId: null,
    });
    try {
      const { data } = await voiceApi.joinChannel(channelId);
      joinedServer = true;
      room = new Room({
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
        // Clean up when the browser tab closes / navigates away.
        disconnectOnPageLeave: true,
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
      const normalizedUrl = normalizeLivekitUrl(data.url);

      // Read saved audio device preferences from user settings.
      const savedInputId = getSavedInputDeviceId();
      const savedOutputId = getSavedOutputDeviceId();
      selectedAudioOutputDeviceId = savedOutputId;

      // Register listeners before connecting so we do not miss early
      // subscriptions published during initial room sync.
      const thisRoom = room;
      registerRoomListeners(room, (reason?: DisconnectReason) => {
        // Ignore disconnect events from stale rooms (e.g. when joinChannel
        // was called again, the old room fires Disconnected asynchronously).
        if (get().room !== thisRoom) return;
        console.warn('[voice] LiveKit room disconnected, reason:', reason);
        detachAllAttachedRemoteAudio();
        void stopNativeSystemAudio();
        // Do NOT call voiceApi.leaveChannel() here — that tells the server
        // to delete the room, destroying it for all participants.  Let
        // LiveKit's participant_left webhook handle server-side cleanup
        // when the WebRTC peer connection truly goes away.
        const cId = get().channelId;
        const auth = useAuthStore.getState().user;
        set((prev) => {
          const channelParticipants = new Map(prev.channelParticipants);
          if (cId && auth) {
            const members = channelParticipants.get(cId);
            if (members) {
              const filtered = members.filter((p) => p.user_id !== auth.id);
              if (filtered.length === 0) channelParticipants.delete(cId);
              else channelParticipants.set(cId, filtered);
            }
          }
          return {
            connected: false,
            channelId: null,
            guildId: null,
            selfMute: false,
            selfDeaf: false,
            selfStream: false,
            selfVideo: false,
            participants: new Map(),
            channelParticipants,
            speakingUsers: new Set<string>(),
            livekitToken: null,
            livekitUrl: null,
            roomName: null,
            room: null,
            joining: false,
            joiningChannelId: null,
            watchedStreamerId: null,
            previewStreamerId: null,
          };
        });
      });

      // Prevent long client retries from making voice joins feel stuck.
      await Promise.race([
        room.connect(normalizedUrl, data.token),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Voice connection timed out.')), 12000);
        }),
      ]);
      await room.startAudio().catch((err) => {
        console.warn('[voice] Failed to start audio playback:', err);
      });

      // Apply saved audio output device before publishing so remote audio
      // plays through the correct speakers/headphones.
      if (savedOutputId) {
        await room.switchActiveDevice('audiooutput', savedOutputId).catch(() => { });
      }
      await applyAttachedRemoteAudioOutput(savedOutputId);

      // Enable/disable microphone based on previous mute/deafen state.
      const microphoneEnabled = await setMicrophoneEnabledWithFallback(
        room,
        !shouldMuteOnJoin,
        savedInputId
      );
      if (microphoneEnabled && !shouldMuteOnJoin) {
        startLocalAudioUplinkMonitor(room);
      }
      setAttachedRemoteAudioMuted(previousSelfDeaf);
      syncRemoteAudioTracks(room, previousSelfDeaf);

      // Add local user to channelParticipants immediately so the sidebar
      // shows them without waiting for the gateway VOICE_STATE_UPDATE event.
      const localVoiceState = buildLocalVoiceState(
        channelId,
        guildId || null,
        data.session_id ?? '',
        shouldMuteOnJoin || !microphoneEnabled,
        previousSelfDeaf,
        false,
        false
      );
      set((prev) => {
        const channelParticipants = new Map(prev.channelParticipants);
        const participants = new Map(prev.participants);
        if (localVoiceState) {
          const existing = (channelParticipants.get(channelId) || []).filter(
            (p) => p.user_id !== localVoiceState.user_id
          );
          existing.push(localVoiceState);
          channelParticipants.set(channelId, existing);
          participants.set(localVoiceState.user_id, localVoiceState);
        }
        return {
          connected: true,
          joining: false,
          joiningChannelId: null,
          channelId,
          guildId: guildId || null,
          livekitToken: data.token,
          livekitUrl: normalizedUrl,
          roomName: data.room_name,
          room,
          participants,
          channelParticipants,
          selfMute: shouldMuteOnJoin || !microphoneEnabled,
          selfDeaf: previousSelfDeaf,
          watchedStreamerId: null,
          previewStreamerId: null,
        };
      });
      syncLivekitRoomPresence(room);
    } catch (error) {
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
      stopRemoteAudioReconcile();
      room?.removeAllListeners();
      room?.disconnect();
      detachAllAttachedRemoteAudio();
      if (joinedServer) {
        await voiceApi.leaveChannel(channelId).catch((err) => {
          console.warn('[voice] rollback leave API error after failed join:', err);
        });
      }
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Unable to connect to voice right now.';
      set({
        connected: false,
        joining: false,
        joiningChannelId: null,
        channelId: null,
        guildId: null,
        room: null,
        selfStream: false,
        livekitToken: null,
        livekitUrl: null,
        roomName: null,
        connectionError: message,
        connectionErrorChannelId: channelId,
        watchedStreamerId: null,
        previewStreamerId: null,
      });
      throw error;
    }
  },

  leaveChannel: async () => {
    const { channelId } = get();
    if (channelId) {
      await voiceApi.leaveChannel(channelId).catch((err) => {
        console.warn('[voice] leave channel API error (continuing disconnect):', err);
      });
    }
    const authUser = useAuthStore.getState().user;
    const currentRoom = get().room;
    if (currentRoom) {
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
      stopRemoteAudioReconcile();
      currentRoom.removeAllListeners();
      currentRoom.disconnect();
    }
    void stopNativeSystemAudio();
    forceRedForCompatibility = false;
    detachAllAttachedRemoteAudio();
    selectedAudioOutputDeviceId = undefined;
    set((state) => {
      // Remove local user from channelParticipants
      const channelParticipants = new Map(state.channelParticipants);
      if (channelId && authUser) {
        const members = channelParticipants.get(channelId);
        if (members) {
          const filtered = members.filter((p) => p.user_id !== authUser.id);
          if (filtered.length === 0) {
            channelParticipants.delete(channelId);
          } else {
            channelParticipants.set(channelId, filtered);
          }
        }
      }
      return {
        connected: false,
        channelId: null,
        guildId: null,
        selfMute: false,
        selfDeaf: false,
        selfStream: false,
        selfVideo: false,
        participants: new Map(),
        channelParticipants,
        speakingUsers: new Set<string>(),
        livekitToken: null,
        livekitUrl: null,
        roomName: null,
        room: null,
        joining: false,
        joiningChannelId: null,
        connectionError: null,
        connectionErrorChannelId: null,
        watchedStreamerId: null,
        previewStreamerId: null,
      };
    });
  },

  toggleMute: () => {
    const state = get();
    const nextSelfMute = !state.selfMute;
    const nextSelfDeaf = nextSelfMute ? state.selfDeaf : false;
    set({
      selfMute: nextSelfMute,
      selfDeaf: nextSelfDeaf,
    });
    setAttachedRemoteAudioMuted(nextSelfDeaf);
    if (!state.room) return;
    const targetMicEnabled = !nextSelfMute;
    void setMicrophoneEnabledWithFallback(state.room, targetMicEnabled, getSavedInputDeviceId()).then(
      (ok) => {
        if (ok && targetMicEnabled) {
          startLocalAudioUplinkMonitor(state.room as Room);
        } else if (!targetMicEnabled) {
          stopLocalAudioUplinkMonitor();
        }
        if (ok || !targetMicEnabled) return;
        // Keep UI truthful: if we failed to unmute the microphone, remain self-muted.
        set({ selfMute: true });
      }
    );
  },

  toggleDeaf: () => {
    const state = get();
    const nextSelfDeaf = !state.selfDeaf;
    const nextSelfMute = nextSelfDeaf ? true : state.selfMute;
    set({
      selfDeaf: nextSelfDeaf,
      selfMute: nextSelfMute,
    });
    setAttachedRemoteAudioMuted(nextSelfDeaf);
    if (!state.room) return;
    const targetMicEnabled = !nextSelfMute;
    void setMicrophoneEnabledWithFallback(state.room, targetMicEnabled, getSavedInputDeviceId()).then(
      (ok) => {
        if (ok && targetMicEnabled) {
          startLocalAudioUplinkMonitor(state.room as Room);
        } else if (!targetMicEnabled) {
          stopLocalAudioUplinkMonitor();
        }
        if (ok || !targetMicEnabled) return;
        set({ selfMute: true });
      }
    );
  },

  startStream: async (qualityPreset = '1080p60') => {
    const { channelId, room } = get();
    if (!channelId || !room) {
      throw new Error('Voice connection is not ready');
    }
    try {
      // 1. Register stream on server and get an upgraded token with
      //    screen-share publish permissions.
      const { data } = await voiceApi.startStream(channelId, { quality_preset: qualityPreset });

      // 2. Reconnect to the LiveKit room with the upgraded stream token so
      //    LiveKit grants us permission to publish screen-share tracks.
      //    Remove listeners before disconnect so the Disconnected event
      //    from this intentional disconnect doesn't reset the store.
      const normalizedUrl = normalizeLivekitUrl(data.url);
      const shouldMuteAfterReconnect = get().selfMute || get().selfDeaf;
      detachAllAttachedRemoteAudio();
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
      stopRemoteAudioReconcile();
      room.removeAllListeners();
      await room.disconnect();
      await room.connect(normalizedUrl, data.token);
      await room.startAudio().catch((err) => {
        console.warn('[voice] Failed to start audio playback after reconnect:', err);
      });

      // Restore saved audio devices after reconnect.
      const streamNotif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
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

      // Re-enable microphone after reconnect with saved input device
      await setMicrophoneEnabledWithFallback(room, !shouldMuteAfterReconnect, streamInputId);
      if (!shouldMuteAfterReconnect) {
        startLocalAudioUplinkMonitor(room);
      }
      setAttachedRemoteAudioMuted(get().selfDeaf);
      const streamRoom = room;
      registerRoomListeners(room, (reason?: DisconnectReason) => {
        if (get().room !== streamRoom) return;
        console.warn('[voice] LiveKit room disconnected (stream), reason:', reason);
        detachAllAttachedRemoteAudio();
        void stopNativeSystemAudio();
        const cId = get().channelId;
        const auth = useAuthStore.getState().user;
        set((prev) => {
          const channelParticipants = new Map(prev.channelParticipants);
          if (cId && auth) {
            const members = channelParticipants.get(cId);
            if (members) {
              const filtered = members.filter((p) => p.user_id !== auth.id);
              if (filtered.length === 0) channelParticipants.delete(cId);
              else channelParticipants.set(cId, filtered);
            }
          }
          return {
            connected: false, channelId: null, guildId: null,
            selfMute: false, selfDeaf: false, selfStream: false, selfVideo: false,
            participants: new Map(), channelParticipants,
            speakingUsers: new Set<string>(),
            livekitToken: null, livekitUrl: null, roomName: null,
            room: null, joining: false, joiningChannelId: null,
            watchedStreamerId: null, previewStreamerId: null,
          };
        });
      });
      syncRemoteAudioTracks(room, get().selfDeaf);

      // 3. Now that we have the right permissions, start screen share
      //    with resolution/framerate constraints matching the preset.
      //    We configure BOTH capture constraints (resolution/fps the browser
      //    captures at) AND encoding parameters (bitrate/fps the WebRTC
      //    encoder targets). Without explicit encoding params LiveKit falls
      //    back to very conservative defaults causing blocky, low-fps streams.
      const presetMap: Record<string, {
        width: number;
        height: number;
        frameRate: number;
        maxBitrate: number;
        /** 'detail' = optimize for sharp text/UI, 'motion' = optimize for video playback */
        hint: 'detail' | 'motion';
      }> = {
        '720p30':      { width: 1280, height: 720,  frameRate: 30, maxBitrate: 5_000_000,   hint: 'detail' },
        '1080p60':     { width: 1920, height: 1080, frameRate: 60, maxBitrate: 15_000_000,  hint: 'detail' },
        '1440p60':     { width: 2560, height: 1440, frameRate: 60, maxBitrate: 25_000_000,  hint: 'detail' },
        '4k60':        { width: 3840, height: 2160, frameRate: 60, maxBitrate: 40_000_000,  hint: 'detail' },
        'movie-50':    { width: 3840, height: 2160, frameRate: 60, maxBitrate: 50_000_000,  hint: 'motion' },
        'movie-100':   { width: 3840, height: 2160, frameRate: 60, maxBitrate: 100_000_000, hint: 'motion' },
      };
      const capture = presetMap[qualityPreset] ?? presetMap['1080p60'];

      await room.localParticipant.setScreenShareEnabled(true, {
        audio: true,
        // systemAudio: 'include' tells Chrome/Edge to pre-check the "Share
        // audio" checkbox in the picker when sharing a screen or tab, so
        // audio is captured automatically without extra user interaction.
        // Note: window-level sharing does NOT support audio (OS limitation).
        systemAudio: 'include',
        selfBrowserSurface: 'include',
        surfaceSwitching: 'include',
        preferCurrentTab: false,
        resolution: { width: capture.width, height: capture.height, frameRate: capture.frameRate },
        contentHint: capture.hint,
      }, {
        screenShareEncoding: {
          maxBitrate: capture.maxBitrate,
          maxFramerate: capture.frameRate,
          priority: 'high',
        },
        screenShareSimulcastLayers: [],
        videoCodec: 'h264',
        // Always maintain framerate for screen shares. Frame drops are far
        // more noticeable than resolution drops, and the viewer's display is
        // typically smaller than the source resolution anyway.
        degradationPreference: 'maintain-framerate',
        scalabilityMode: 'L1T1',
      });

      // Verify whether screen share audio was captured and published
      const screenShareAudioPub = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShareAudio
      );
      if (screenShareAudioPub) {
        console.info('[voice] Screen share audio track published — viewers will hear stream audio');
      } else {
        console.warn(
          '[voice] No screen share audio track — audio not captured.',
          'This happens when sharing a window (audio not supported) or if',
          '"Share audio" was unchecked. Share an entire screen for automatic audio.'
        );

        // If no screen share audio was captured (e.g. window sharing), attempt
        // native system audio capture via Tauri WASAPI loopback.
        try {
          const nativeAudioTrack = await startNativeSystemAudio();
          if (nativeAudioTrack) {
            await room.localParticipant.publishTrack(nativeAudioTrack, {
              source: Track.Source.ScreenShareAudio,
            });
            console.info('[voice] Published native system audio as ScreenShareAudio');
          }
        } catch (err) {
          console.warn('[voice] Native system audio capture failed:', err);
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
            // Wider keyframe interval: fewer full frames = more bits for
            // quality on P-frames. Default is often 2-3 seconds; we push
            // to 4 seconds for screen content that changes incrementally.
            // @ts-expect-error keyInterval is a non-standard but widely
            // supported Chrome/Edge extension to RTCRtpEncodingParameters
            params.encodings[0].keyInterval = 240; // 4 seconds at 60fps
            await sender.setParameters(params);
          }
        }
      } catch (err) {
        console.warn('[voice] Post-publish sender tuning failed (non-critical):', err);
      }
      set({
        selfStream: true,
        livekitToken: data.token,
        livekitUrl: normalizedUrl,
        roomName: data.room_name,
      });
    } catch (error) {
      void stopNativeSystemAudio();
      await room.localParticipant.setScreenShareEnabled(false).catch(() => { });
      set({ selfStream: false });
      throw error;
    }
  },

  stopStream: () =>
    set((state) => {
      state.room?.localParticipant.setScreenShareEnabled(false).catch(() => { });
      void stopNativeSystemAudio();
      // Also update the local user's voice-state entry so that
      // participants-derived flags reflect the stream ending immediately,
      // even before a gateway event arrives.
      const localUserId = useAuthStore.getState().user?.id;
      const participants = new Map(state.participants);
      if (localUserId) {
        const existing = participants.get(localUserId);
        if (existing) {
          participants.set(localUserId, { ...existing, self_stream: false });
        }
      }
      return { selfStream: false, participants };
    }),

  toggleVideo: () => {
    const state = get();
    const nextSelfVideo = !state.selfVideo;
    if (!state.room) {
      set({ selfVideo: nextSelfVideo });
      return;
    }
    const room = state.room;
    set({ selfVideo: nextSelfVideo });

    if (nextSelfVideo) {
      // Enable camera
      const notif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
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
      void room.localParticipant
        .setCameraEnabled(true, captureOpts)
        .then(() => {
          // Update local participant's voice state
          const localUserId = useAuthStore.getState().user?.id;
          if (localUserId) {
            set((prev) => {
              const participants = new Map(prev.participants);
              const existing = participants.get(localUserId);
              if (existing) {
                participants.set(localUserId, { ...existing, self_video: true });
              }
              return { participants };
            });
          }
          syncLivekitRoomPresence(room);
        })
        .catch((err) => {
          console.warn('[voice] Failed to enable camera:', err);
          set({ selfVideo: false });
        });
    } else {
      // Disable camera
      void room.localParticipant
        .setCameraEnabled(false)
        .then(() => {
          const localUserId = useAuthStore.getState().user?.id;
          if (localUserId) {
            set((prev) => {
              const participants = new Map(prev.participants);
              const existing = participants.get(localUserId);
              if (existing) {
                participants.set(localUserId, { ...existing, self_video: false });
              }
              return { participants };
            });
          }
          syncLivekitRoomPresence(room);
        })
        .catch((err) => {
          console.warn('[voice] Failed to disable camera:', err);
        });
    }
  },
  applyAudioInputDevice: async (deviceId) => {
    const state = get();
    const room = state.room;
    if (!room) return;
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    try {
      await room.switchActiveDevice('audioinput', normalizedDeviceId ?? 'default');
      // If the user is currently unmuted, ensure the active mic is enabled
      // on the newly selected device.
      if (!state.selfMute && !state.selfDeaf) {
        const ok = await setMicrophoneEnabledWithFallback(room, true, normalizedDeviceId);
        if (ok) {
          startLocalAudioUplinkMonitor(room);
        }
      }
    } catch (err) {
      console.warn('[voice] Failed to switch input device:', err);
    }
  },
  applyAudioOutputDevice: async (deviceId) => {
    const room = get().room;
    if (!room) return;
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    selectedAudioOutputDeviceId = normalizedDeviceId;
    try {
      await room.switchActiveDevice('audiooutput', normalizedDeviceId ?? 'default');
      await applyAttachedRemoteAudioOutput(normalizedDeviceId);
    } catch (err) {
      console.warn('[voice] Failed to switch output device:', err);
    }
  },
  reapplyAudioConstraints: async () => {
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

  handleVoiceStateUpdate: (voiceState) => {
    // Determine join/leave sounds BEFORE mutating state so we can compare
    // the previous channel of the updating user against our current channel.
    const currentState = get();
    const localUserId = useAuthStore.getState().user?.id;
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
      // Ignore stale self-leave updates while the local LiveKit room is still
      // connected. The server can emit transient participant_left events during
      // reconnects, but local room state is the stronger signal for "still in voice".
      if (
        voiceState.user_id === localUserId &&
        !voiceState.channel_id &&
        state.connected &&
        state.channelId &&
        state.room &&
        state.room.state !== ConnectionState.Disconnected
      ) {
        return state;
      }

      const participants = new Map(state.participants);
      if (voiceState.channel_id) {
        participants.set(voiceState.user_id, voiceState);
      } else {
        participants.delete(voiceState.user_id);
      }

      // Update global channel participants
      const channelParticipants = new Map(state.channelParticipants);
      // A non-null channel_id means a move to that channel. Remove user from
      // all existing channel lists first to avoid duplicate sidebar entries.
      for (const [chId, members] of channelParticipants) {
        const filtered = members.filter((p) => p.user_id !== voiceState.user_id);
        if (filtered.length === 0) {
          channelParticipants.delete(chId);
        } else if (filtered.length !== members.length) {
          channelParticipants.set(chId, filtered);
        }
      }
      if (voiceState.channel_id) {
        const existing = channelParticipants.get(voiceState.channel_id) || [];
        channelParticipants.set(voiceState.channel_id, [...existing, voiceState]);
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

  loadVoiceStates: (guildId, states) =>
    set((prev) => {
      const channelParticipants = new Map(prev.channelParticipants);
      const participants = new Map(prev.participants);
      const myId = useAuthStore.getState().user?.id;
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
    set(() => ({
      speakingUsers: new Set(userIds),
    })),

  setWatchedStreamer: (userId) =>
    set({
      watchedStreamerId: userId,
    }),

  setPreviewStreamer: (userId) =>
    set({
      previewStreamerId: userId,
    }),
}));
