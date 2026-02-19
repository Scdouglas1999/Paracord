import { create } from 'zustand';
import type { VoiceState } from '../types';
import { voiceApi } from '../api/voice';
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
import { useServerListStore } from './serverListStore';
import { playVoiceJoinSound, playVoiceLeaveSound } from '../lib/voiceSounds';
import { startNativeSystemAudio, stopNativeSystemAudio } from '../lib/systemAudioCapture';
import { isTauri } from '../lib/tauriEnv';
import { getStoredServerUrl, resolveApiBaseUrl } from '../lib/apiBaseUrl';
import { NoiseGateProcessor } from '../lib/noiseGate';

const INTERNAL_LIVEKIT_HOSTS = new Set([
  'host.docker.internal',
  'livekit',
  'docker-livekit-1',
  '0.0.0.0',
  '::',
]);
const SYSTEM_AUDIO_PRIVACY_ACK_KEY = 'paracord:system-audio-privacy-ack';

function hasAcknowledgedSystemAudioPrivacyWarning(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(SYSTEM_AUDIO_PRIVACY_ACK_KEY) === '1';
}

function persistSystemAudioPrivacyWarningAcknowledgement(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SYSTEM_AUDIO_PRIVACY_ACK_KEY, '1');
}

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

function getApiDerivedServerBaseUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const apiBaseUrl = resolveApiBaseUrl();
    const parsed = new URL(apiBaseUrl, window.location.origin);
    if (!/^https?:$/.test(parsed.protocol)) {
      return null;
    }
    // Vite's WS proxy cannot carry LiveKit signaling, so in dev mode point
    // directly at the backend server (bypassing Vite).
    if (!import.meta.env.PROD && /:(5173|1420)\b/.test(parsed.host)) {
      return import.meta.env.VITE_DEV_PROXY_TARGET || 'https://localhost:8443';
    }
    let pathname = parsed.pathname.replace(/\/+$/, '');
    if (
      pathname === '/api' ||
      pathname === '/api/v1' ||
      pathname === '/health' ||
      pathname === '/api/v1/health'
    ) {
      pathname = '';
    }
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return null;
  }
}

function getPreferredServerBaseUrl(): string | null {
  const apiDerivedBase = getApiDerivedServerBaseUrl();
  if (apiDerivedBase) {
    return apiDerivedBase;
  }
  const serverState = useServerListStore.getState();
  const activeServer = serverState.getActiveServer();
  if (activeServer?.url) {
    return activeServer.url;
  }
  const anyConnectedServer = serverState.servers.find((s) => s.connected);
  if (anyConnectedServer?.url) {
    return anyConnectedServer.url;
  }
  return getStoredServerUrl();
}

function toLivekitProxyUrlFromHttpBase(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    const wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${parsed.host}/livekit`;
  } catch {
    return null;
  }
}

function getWindowOriginLivekitUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const host = window.location.host;
  if (!host) {
    return null;
  }
  // Skip the window-origin candidate when running on a Vite dev server.
  // Vite's WebSocket proxy cannot handle LiveKit's signaling protocol,
  // so attempting it always fails and just delays the real connection.
  if (!import.meta.env.PROD && /:(5173|1420)\b/.test(host)) {
    return null;
  }
  const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsScheme}//${host}/livekit`;
}

function getEnvDirectLivekitUrl(): string | null {
  const raw = import.meta.env.VITE_LIVEKIT_DIRECT_URL;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function allowDirectLivekitFallback(): boolean {
  const raw = import.meta.env.VITE_ENABLE_LIVEKIT_DIRECT_FALLBACK;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isLivekitProxyPath(pathname: string): boolean {
  const normalized = pathname.trim().replace(/\/+$/, '');
  return normalized === '/livekit' || normalized.startsWith('/livekit/');
}

function parseUrlSafe(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isPrivateIpv4Hostname(hostname: string): boolean {
  const parts = hostname.trim().split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT range, often used by residential gateways.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  );
}

function allowLoopbackLivekitFallback(): boolean {
  const raw = import.meta.env.VITE_ENABLE_LIVEKIT_LOOPBACK_FALLBACK;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  // Default to desktop runtime only. Browser dev on localhost often proxies
  // to a remote backend, where rewriting candidates to localhost breaks voice.
  return isTauri();
}

function buildLoopbackLivekitProxyVariants(candidate: string): string[] {
  if (typeof window === 'undefined') return [];
  if (!allowLoopbackLivekitFallback()) return [];
  if (!isLoopbackHostname(window.location.hostname)) return [];
  const parsed = parseUrlSafe(candidate);
  if (!parsed) return [];
  if (!isLivekitProxyPath(parsed.pathname)) return [];
  if (isLoopbackHostname(parsed.hostname)) return [];

  const port = parsed.port ? `:${parsed.port}` : '';
  const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return [`${parsed.protocol}//localhost${port}${suffix}`, `${parsed.protocol}//127.0.0.1${port}${suffix}`];
}

function expandLivekitCandidateVariants(candidate: string): string[] {
  const normalized = normalizeLivekitUrlFromServerValue(candidate);
  // When the client runs on loopback (desktop app/local dev), trying the
  // same /livekit endpoint on localhost first avoids unstable hairpin NAT
  // paths through the host's public IP.
  return [...buildLoopbackLivekitProxyVariants(normalized), normalized];
}

function preferDirectLivekitCandidates(candidates: string[]): string[] {
  const direct: string[] = [];
  const proxied: string[] = [];
  const unknown: string[] = [];
  for (const candidate of candidates) {
    const parsed = parseUrlSafe(candidate);
    if (!parsed) {
      unknown.push(candidate);
      continue;
    }
    if (isLivekitProxyPath(parsed.pathname)) {
      proxied.push(candidate);
    } else {
      direct.push(candidate);
    }
  }

  const runningOnLoopbackClient =
    typeof window !== 'undefined' && isLoopbackHostname(window.location.hostname);
  if (runningOnLoopbackClient) {
    const proxiedLoopback: string[] = [];
    const proxiedPrivateLan: string[] = [];
    const proxiedPublic: string[] = [];
    for (const candidate of proxied) {
      const parsed = parseUrlSafe(candidate);
      if (!parsed) {
        proxiedPublic.push(candidate);
        continue;
      }
      if (isLoopbackHostname(parsed.hostname)) {
        proxiedLoopback.push(candidate);
      } else if (isPrivateIpv4Hostname(parsed.hostname)) {
        proxiedPrivateLan.push(candidate);
      } else {
        proxiedPublic.push(candidate);
      }
    }
    return [...proxiedLoopback, ...proxiedPrivateLan, ...proxiedPublic, ...direct, ...unknown];
  }

  // In production, /livekit proxy is the safest default. Direct endpoints
  // are optional fallbacks for deployments that explicitly expose LiveKit.
  return [...proxied, ...direct, ...unknown];
}

function buildLivekitConnectCandidates(
  serverReturnedUrl: string,
  serverProvidedCandidates?: string[]
): string[] {
  const preferredBase = getPreferredServerBaseUrl();
  const preferredUrl = preferredBase ? toLivekitProxyUrlFromHttpBase(preferredBase) : null;
  const envDirectUrl = getEnvDirectLivekitUrl();
  const provided = Array.isArray(serverProvidedCandidates)
    ? serverProvidedCandidates.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const expandedCandidates = [
    ...provided,
    envDirectUrl,
    getWindowOriginLivekitUrl(),
    preferredUrl,
    serverReturnedUrl,
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => expandLivekitCandidateVariants(value));

  const deduped = Array.from(new Set(expandedCandidates));
  const ordered = preferDirectLivekitCandidates(deduped);
  if (allowDirectLivekitFallback()) {
    return ordered;
  }

  const proxiedOnly = ordered.filter((candidate) => {
    const parsed = parseUrlSafe(candidate);
    return parsed ? isLivekitProxyPath(parsed.pathname) : false;
  });
  return proxiedOnly.length > 0 ? proxiedOnly : ordered;
}

/**
 * Build the LiveKit proxy URL from the client's own server connection.
 *
 * Instead of relying on the server-returned URL (which may have the wrong
 * ws/wss protocol or hostname), we derive the WebSocket URL from the stored
 * server URL that the client already uses for API calls. This guarantees:
 *   - Correct protocol: https â†’ wss, http â†’ ws
 *   - Correct host:port (same as what the client is connected to)
 *   - The /livekit proxy path
 */
function normalizeLivekitUrl(serverReturnedUrl: string, serverProvidedCandidates?: string[]): string {
  const candidates = buildLivekitConnectCandidates(serverReturnedUrl, serverProvidedCandidates);
  return candidates[0] ?? normalizeLivekitUrlFromServerValue(serverReturnedUrl);
}

function normalizeLivekitUrlFromServerValue(serverReturnedUrl: string): string {
  // Legacy normalization for dev mode, Docker, and other setups.
  try {
    const parsed = new URL(serverReturnedUrl);
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
    return serverReturnedUrl
      .replace('host.docker.internal', 'localhost')
      .replace('livekit', 'localhost')
      .replace('0.0.0.0', 'localhost')
      .replace('[::]', 'localhost')
      .replace('::', 'localhost')
      .replace(/\/+$/, '');
  }
}

function isTransientVoiceConnectError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('interrupted while the page was loading') ||
    normalized.includes('operation was aborted') ||
    normalized.includes('aborted') ||
    normalized.includes('signal connection') ||
    normalized.includes('websocket') ||
    normalized.includes('timed out') ||
    normalized.includes('livekit') ||
    normalized.includes('connection')
  );
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
let joinAttemptSeq = 0;
let activeJoinAttempt = 0;
// Tracks the Room object being constructed inside joinChannel() before it is
// stored in Zustand state.  A subsequent join/leave can disconnect this room
// to prevent two Room.connect() calls from racing against the same LiveKit
// signaling endpoint.
let inFlightJoinRoom: Room | null = null;
// Tracks the in-flight Room.disconnect() promise so joinChannel can await it
// before opening a new connection. Without this, the old WebSocket teardown
// can block the new connection if they target the same host.
let pendingDisconnect: Promise<void> | null = null;
let pendingDisconnectStartedAt = 0;
const DISCONNECT_WAIT_ON_JOIN_MS = 5_000;
const DISCONNECT_WAIT_ON_LEAVE_MS = 600;
const MIN_DISCONNECT_QUIET_PERIOD_MS = 2_500;
const LIVEKIT_CONNECT_OPTIONS = {
  maxRetries: 4,
  websocketTimeout: 45_000,
  peerConnectionTimeout: 50_000,
} as const;
const LIVEKIT_CONNECT_ATTEMPTS_PER_CANDIDATE = 2;
const LIVEKIT_CONNECT_RETRY_BASE_DELAY_MS = 400;
type MicUplinkState = 'idle' | 'sending' | 'stalled' | 'recovering' | 'muted' | 'no_track';
let livekitLogConfigured = false;
let livekitHeartbeatLogged = false;
let livekitHeartbeatPatchLogged = false;
let livekitHeartbeatClientMissingLogged = false;

type LivekitSignalClientInternals = {
  pingTimeoutDuration?: number;
  pingIntervalDuration?: number;
  startPingInterval?: () => void;
  __paracordHeartbeatGuardPatched?: boolean;
  __paracordHeartbeatGuardOriginalStartPingInterval?: () => void;
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
  const engine = (room as unknown as { engine?: { client?: LivekitSignalClientInternals } }).engine;
  const signalClient = engine?.client;
  if (!signalClient) {
    if (!livekitHeartbeatClientMissingLogged) {
      livekitHeartbeatClientMissingLogged = true;
      console.warn('[voice] Unable to locate LiveKit signal client for heartbeat tuning.');
    }
    return;
  }

  if (!signalClient.__paracordHeartbeatGuardPatched) {
    const originalStartPingInterval = signalClient.startPingInterval?.bind(signalClient);
    if (originalStartPingInterval) {
      signalClient.__paracordHeartbeatGuardOriginalStartPingInterval = originalStartPingInterval;
      signalClient.startPingInterval = () => {
        ensureSafeLivekitPingTimeout(signalClient, 'startPingInterval');
        originalStartPingInterval();
      };
      signalClient.__paracordHeartbeatGuardPatched = true;
      if (!livekitHeartbeatPatchLogged) {
        livekitHeartbeatPatchLogged = true;
        console.info('[voice] Installed LiveKit signal heartbeat guard patch.');
      }
    }
  }

  const adjusted = ensureSafeLivekitPingTimeout(signalClient, 'connect-or-reconnect');
  if (adjusted) {
    if (signalClient.__paracordHeartbeatGuardOriginalStartPingInterval) {
      signalClient.__paracordHeartbeatGuardOriginalStartPingInterval();
    } else if (typeof signalClient.startPingInterval === 'function') {
      signalClient.startPingInterval();
    }
  }
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

function startPendingDisconnect(disconnectPromise: Promise<void>): void {
  pendingDisconnectStartedAt = Date.now();
  let tracked: Promise<void>;
  tracked = disconnectPromise
    .catch((err) => {
      console.warn('[voice] Room disconnect errored:', err);
    })
    .then(() => undefined)
    .finally(() => {
      if (pendingDisconnect === tracked) {
        pendingDisconnect = null;
        pendingDisconnectStartedAt = 0;
      }
    });
  pendingDisconnect = tracked;
}

async function waitForPendingDisconnect(maxWaitMs: number): Promise<{ timedOut: boolean; ageMs: number }> {
  const disconnectPromise = pendingDisconnect;
  if (!disconnectPromise) {
    return { timedOut: false, ageMs: 0 };
  }
  const startedAt = pendingDisconnectStartedAt || Date.now();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve();
    }, maxWaitMs);
  });
  await Promise.race([disconnectPromise, timeoutPromise]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  return {
    timedOut,
    ageMs: Date.now() - startedAt,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const notif = (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
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
  return (useAuthStore.getState().settings?.notifications ?? {}) as Record<string, unknown>;
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
  /** 'detail' = optimize for sharp text/UI, 'motion' = optimize for video playback */
  hint: 'detail' | 'motion';
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
    // getCapabilities not supported â€” fall through
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
  // Do NOT autoplay â€” we start playback only after setSinkId completes to
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
  // Attach FIRST â€" LiveKit's track.attach() internally resets element.muted
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
        audio.play().catch(() => {});
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
    const defaultProfile = await resolveMicCaptureProfile();
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

  const onActiveSpeakersChanged = (speakers: Participant[]) => {
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
  };

  const onParticipantConnected = (participant: RemoteParticipant) => {
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
        console.info('[voice] Local camera track unpublished â€” clearing selfVideo');
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
      suppressVoiceForStream(false);
      const state = useVoiceStore.getState();
      if (state.selfStream) {
        console.info('[voice] Local screen share track unpublished â€" clearing selfStream');
        // Notify server that stream ended
        if (state.channelId) {
          voiceApi.stopStream(state.channelId).catch((err) => {
            console.warn('[voice] Failed to stop stream after local unpublish:', err);
          });
        }
        // Revert voice audio to normal output device
        const savedOutputId = getSavedOutputDeviceId() || '';
        const voiceEls = document.querySelectorAll<HTMLAudioElement>('[data-paracord-voice-audio]');
        for (const el of voiceEls) {
          el.setSinkId?.(savedOutputId).catch(() => {});
        }
        const localUserId = useAuthStore.getState().user?.id;
        const participants = new Map(state.participants);
        if (localUserId) {
          const existing = participants.get(localUserId);
          if (existing) {
            participants.set(localUserId, { ...existing, self_stream: false });
          }
        }
        useVoiceStore.setState({
          selfStream: false,
          participants,
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
      console.warn('[voice] Audio playback blocked â€” will retry on next user gesture');
      const resume = () => {
        room.startAudio().catch(() => {});
        document.removeEventListener('click', resume);
        document.removeEventListener('keydown', resume);
      };
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
    console.warn('[voice] LiveKit reconnecting...');
  };

  const onReconnected = () => {
    console.info('[voice] LiveKit reconnected successfully');
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
    stopRemoteAudioReconcile();
    stopLocalMicAnalyser();
    stopLocalAudioUplinkMonitor();
    unbindParticipantSpeaking(room.localParticipant);
    for (const participant of room.remoteParticipants.values()) {
      unbindParticipantSpeaking(participant);
    }
    onDisconnected(reason);
  };

  room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
  room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
  room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  room.on(RoomEvent.TrackPublished, onTrackPublished);
  room.on(RoomEvent.TrackSubscriptionFailed, onTrackSubscriptionFailed);
  room.on(RoomEvent.TrackSubscriptionStatusChanged, onTrackSubscriptionStatusChanged);
  room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
  room.on(RoomEvent.TrackMuted, onTrackMuted);
  room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);
  room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
  room.on(RoomEvent.AudioPlaybackStatusChanged, onAudioPlaybackStatusChanged);
  room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
  room.on(RoomEvent.LocalAudioSilenceDetected, onLocalAudioSilenceDetected);
  room.on(RoomEvent.Reconnecting, onReconnecting);
  room.on(RoomEvent.Reconnected, onReconnected);
  room.on(RoomEvent.Disconnected, onDisconnectedEvent);

  return () => {
    room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
    room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
    room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    room.off(RoomEvent.TrackPublished, onTrackPublished);
    room.off(RoomEvent.TrackSubscriptionFailed, onTrackSubscriptionFailed);
    room.off(RoomEvent.TrackSubscriptionStatusChanged, onTrackSubscriptionStatusChanged);
    room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    room.off(RoomEvent.TrackMuted, onTrackMuted);
    room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
    room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
    room.off(RoomEvent.AudioPlaybackStatusChanged, onAudioPlaybackStatusChanged);
    room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.off(RoomEvent.LocalAudioSilenceDetected, onLocalAudioSilenceDetected);
    room.off(RoomEvent.Reconnecting, onReconnecting);
    room.off(RoomEvent.Reconnected, onReconnected);
    room.off(RoomEvent.Disconnected, onDisconnectedEvent);
    unbindParticipantSpeaking(room.localParticipant);
    for (const participant of room.remoteParticipants.values()) {
      unbindParticipantSpeaking(participant);
    }
  };
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
  streamAudioWarning: string | null;
  systemAudioCaptureActive: boolean;
  showSystemAudioPrivacyWarning: boolean;
  voiceSuppressedForStream: boolean;
  watchedStreamerId: string | null;
  previewStreamerId: string | null;

  joinChannel: (channelId: string, guildId?: string, internalRetryAttempt?: number) => Promise<void>;
  leaveChannel: () => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleDeaf: () => Promise<void>;
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
  acknowledgeSystemAudioPrivacyWarning: () => void;
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
  streamAudioWarning: null,
  systemAudioCaptureActive: false,
  showSystemAudioPrivacyWarning: false,
  voiceSuppressedForStream: false,
  watchedStreamerId: null,
  previewStreamerId: null,

  joinChannel: async (channelId, guildId, internalRetryAttempt = 0) => {
    configureLivekitLogging();
    const currentState = get();
    if (
      currentState.connected &&
      currentState.channelId === channelId &&
      currentState.room &&
      currentState.room.state !== ConnectionState.Disconnected
    ) {
      // Idempotent join: avoid tearing down and recreating the same room
      // connection when duplicate click handlers fire.
      return;
    }
    if (currentState.joining && currentState.joiningChannelId === channelId) {
      // Keep join single-flight for a channel; overlapping joins can race the
      // signaling engine and produce spurious websocket close errors.
      return;
    }
    const joinAttempt = ++joinAttemptSeq;
    activeJoinAttempt = joinAttempt;
    const previousSelfMute = get().selfMute;
    const previousSelfDeaf = get().selfDeaf;
    const shouldMuteOnJoin = previousSelfMute || previousSelfDeaf;
    // Disconnect any in-flight Room from a concurrent join that hasn't
    // stored its room in state yet.  Without this, two Room.connect()
    // calls can race against the same LiveKit signaling endpoint.
    if (inFlightJoinRoom) {
      const staleRoom = inFlightJoinRoom;
      inFlightJoinRoom = null;
      startPendingDisconnect(staleRoom.disconnect());
    }
    const existingRoom = get().room;
    if (existingRoom) {
      clearActiveRoomListeners();
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
      stopRemoteAudioReconcile();
      startPendingDisconnect(existingRoom.disconnect());
    }
    // Wait for any in-flight Room.disconnect() (from leaveChannel or above)
    // so the old WebSocket is fully closed before we open a new one.
    // On Windows WebView2, rapidly opening a new socket to the same host can
    // race with teardown of the previous socket and trigger long reconnect
    // fallback paths. Prefer waiting for disconnect completion, then only add
    // a small quiet period if teardown was very fast.
    if (pendingDisconnect) {
      const { timedOut, ageMs } = await waitForPendingDisconnect(DISCONNECT_WAIT_ON_JOIN_MS);
      if (timedOut) {
        console.warn(
          `[voice] Disconnect still in-flight after ${DISCONNECT_WAIT_ON_JOIN_MS}ms; proceeding with join.`
        );
      } else {
        console.info(`[voice] Disconnect completed before join (age=${ageMs}ms).`);
      }
      const quietPeriodRemainingMs = Math.max(0, MIN_DISCONNECT_QUIET_PERIOD_MS - ageMs);
      if (quietPeriodRemainingMs > 0) {
        console.info(
          `[voice] Waiting ${quietPeriodRemainingMs}ms quiet period before LiveKit connect.`
        );
        await new Promise<void>((resolve) => setTimeout(resolve, quietPeriodRemainingMs));
      }
    }
    forceRedForCompatibility = false;
    detachAllAttachedRemoteAudio();
    let room: Room | null = null;
    let joinedServer = false;
    // Bail early if this join was superseded during the quiet period.
    if (activeJoinAttempt !== joinAttempt) {
      return;
    }
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
      // Bail if superseded during the API call — avoids creating a Room
      // and starting a LiveKit connect that will just be torn down.
      if (activeJoinAttempt !== joinAttempt) {
        // Roll back the server join so the voice state stays clean.
        voiceApi.leaveChannel(channelId).catch(() => {});
        set({ joining: false, joiningChannelId: null });
        return;
      }
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
      // Track this Room so a concurrent joinChannel/leaveChannel can disconnect
      // it before it lands in Zustand state.
      inFlightJoinRoom = room;

      const connectCandidates = buildLivekitConnectCandidates(data.url, data.url_candidates);
      const normalizedUrl = connectCandidates[0] ?? normalizeLivekitUrlFromServerValue(data.url);

      // Read saved audio device preferences from user settings.
      const savedInputId = getSavedInputDeviceId();
      const savedOutputId = getSavedOutputDeviceId();
      selectedAudioOutputDeviceId = savedOutputId;

      // Register listeners before connecting so we do not miss early
      // subscriptions published during initial room sync.
      const thisRoom = room;
      activeRoomListenerCleanup = registerRoomListeners(room, (reason?: DisconnectReason) => {
        // Ignore disconnect events from stale rooms (e.g. when joinChannel
        // was called again, the old room fires Disconnected asynchronously).
        if (get().room !== thisRoom) return;
        activeRoomListenerCleanup = null;
        console.warn('[voice] LiveKit room disconnected, reason:', reason);
        // If we were streaming, explicitly clear stream state server-side.
        const wasStreaming = get().selfStream;
        const streamChannelId = get().channelId;
        if (wasStreaming && streamChannelId) {
          voiceApi.stopStream(streamChannelId).catch((err) => {
            console.warn('[voice] Failed to stop stream during disconnect cleanup:', err);
          });
        }
        detachAllAttachedRemoteAudio();
        void stopNativeSystemAudio();
        suppressVoiceForStream(false);
        // Do NOT call voiceApi.leaveChannel() here â€" that tells the server
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
            streamAudioWarning: null,
            systemAudioCaptureActive: false,
            voiceSuppressedForStream: false,
            watchedStreamerId: null,
            previewStreamerId: null,
          };
        });
      });

      // Use LiveKit's native connection timeout/retry logic for initial join.
      console.log('[voice] Connecting to LiveKit at:', normalizedUrl);
      console.log('[voice] Server returned URL:', data.url, 'â†’ normalized:', normalizedUrl);
      console.log('[voice] LiveKit candidate order:', connectCandidates);
      let connected = false;
      let lastConnectError: unknown = null;
      const totalAttempts = connectCandidates.length * LIVEKIT_CONNECT_ATTEMPTS_PER_CANDIDATE;
      let attemptCounter = 0;
      outer: for (let i = 0; i < connectCandidates.length; i += 1) {
        const candidate = connectCandidates[i]!;
        for (let retry = 0; retry < LIVEKIT_CONNECT_ATTEMPTS_PER_CANDIDATE; retry += 1) {
          if (activeJoinAttempt !== joinAttempt) {
            lastConnectError = new Error('Voice join superseded by a newer attempt');
            break outer;
          }
          attemptCounter += 1;
          const retryLabel =
            LIVEKIT_CONNECT_ATTEMPTS_PER_CANDIDATE > 1
              ? ` (candidate ${i + 1}/${connectCandidates.length}, retry ${retry + 1}/${LIVEKIT_CONNECT_ATTEMPTS_PER_CANDIDATE})`
              : '';
          console.info(
            `[voice] LiveKit connect attempt ${attemptCounter}/${totalAttempts}${retryLabel}: ${candidate}`
          );
          try {
            await room.connect(candidate, data.token, LIVEKIT_CONNECT_OPTIONS);
            tuneLivekitSignalHeartbeat(room);
            connected = true;
            if (attemptCounter > 1) {
              console.info('[voice] LiveKit connected after retry.');
            }
            break outer;
          } catch (connectErr) {
            lastConnectError = connectErr;
            const remainingAttempts = totalAttempts - attemptCounter;
            const connectMessage =
              connectErr instanceof Error
                ? connectErr.message
                : typeof connectErr === 'string'
                  ? connectErr
                  : '';
            const retryable = remainingAttempts > 0 && isTransientVoiceConnectError(connectMessage);
            if (retryable) {
              console.info(
                `[voice] LiveKit connect attempt ${attemptCounter}/${totalAttempts} failed; retrying:`,
                connectErr
              );
            } else {
              console.warn(
                `[voice] LiveKit connect attempt ${attemptCounter}/${totalAttempts} failed:`,
                connectErr
              );
            }
            try {
              await room.disconnect();
            } catch {
              // ignore disconnect errors between attempts
            }
            if (remainingAttempts > 0) {
              const retryDelayMs = LIVEKIT_CONNECT_RETRY_BASE_DELAY_MS * (retry + 1);
              await delay(retryDelayMs);
            }
          }
        }
      }
      if (!connected) {
        throw (
          lastConnectError instanceof Error
            ? lastConnectError
            : new Error('Unable to establish LiveKit signaling connection')
        );
      }
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
      if (activeJoinAttempt !== joinAttempt) {
        inFlightJoinRoom = null;
        clearActiveRoomListeners();
        stopLocalMicAnalyser();
        stopLocalAudioUplinkMonitor();
        stopRemoteAudioReconcile();
        startPendingDisconnect(room.disconnect());
        detachAllAttachedRemoteAudio();
        return;
      }
      // Room is about to be stored in state — stop tracking it as in-flight.
      inFlightJoinRoom = null;
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
      inFlightJoinRoom = null;
      const isLatestJoinAttempt = activeJoinAttempt === joinAttempt;
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Unable to connect to voice right now.';
      console.error('[voice] Join attempt failed', {
        channelId,
        isLatestJoinAttempt,
        joinedServer,
        internalRetryAttempt,
        message,
      });
      if (!isLatestJoinAttempt) {
        clearActiveRoomListeners();
        stopLocalMicAnalyser();
        stopLocalAudioUplinkMonitor();
        stopRemoteAudioReconcile();
        if (room) {
          startPendingDisconnect(room.disconnect());
        }
        detachAllAttachedRemoteAudio();
        return;
      }
      clearActiveRoomListeners();
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
      stopRemoteAudioReconcile();
      if (room) {
        startPendingDisconnect(room.disconnect());
      }
      detachAllAttachedRemoteAudio();
      if (joinedServer) {
        await voiceApi.leaveChannel(channelId).catch((err) => {
          console.warn('[voice] rollback leave API error after failed join:', err);
        });
      }
      const shouldAutoRetry =
        internalRetryAttempt < 1 &&
        joinedServer &&
        isTransientVoiceConnectError(message);
      if (shouldAutoRetry) {
        console.warn(
          `[voice] Transient signaling failure detected; auto-retrying join once (attempt ${internalRetryAttempt + 2}/2).`
        );
        set({
          joining: false,
          joiningChannelId: null,
        });
        await delay(500);
        return get().joinChannel(channelId, guildId, internalRetryAttempt + 1);
      }
      suppressVoiceForStream(false);
      set({
        connected: false,
        joining: false,
        joiningChannelId: null,
        channelId: null,
        guildId: null,
        room: null,
        selfStream: false,
        streamAudioWarning: null,
        systemAudioCaptureActive: false,
        voiceSuppressedForStream: false,
        livekitToken: null,
        livekitUrl: null,
        roomName: null,
        connectionError: message,
        connectionErrorChannelId: channelId,
        watchedStreamerId: null,
        previewStreamerId: null,
      });
      return;
    }
  },

  leaveChannel: async () => {
    activeJoinAttempt = ++joinAttemptSeq;
    const { channelId } = get();
    const authUser = useAuthStore.getState().user;
    // Disconnect any in-flight Room from a concurrent join that hasn't
    // stored its room in state yet.
    if (inFlightJoinRoom) {
      const staleRoom = inFlightJoinRoom;
      inFlightJoinRoom = null;
      startPendingDisconnect(staleRoom.disconnect());
    }
    // Disconnect room and update UI FIRST so the user gets instant feedback.
    const currentRoom = get().room;
    if (currentRoom) {
      clearActiveRoomListeners();
      stopLocalMicAnalyser();
      stopLocalAudioUplinkMonitor();
      stopRemoteAudioReconcile();
      // Store the disconnect promise so joinChannel can await it before
      // opening a new connection. Without this, the old WebSocket teardown
      // races with the new connect(), causing "could not establish signal
      // connection" errors on rejoin.
      startPendingDisconnect(currentRoom.disconnect());
    }
    void stopNativeSystemAudio();
    suppressVoiceForStream(false);
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
        streamAudioWarning: null,
        systemAudioCaptureActive: false,
        voiceSuppressedForStream: false,
        watchedStreamerId: null,
        previewStreamerId: null,
      };
    });
    // Await the disconnect (with a timeout) so the WebSocket teardown has
    // a better chance of completing before the user triggers a rejoin.
    // The UI has already updated above, so this await doesn't block the user
    // visually â€” it just keeps the async leaveChannel() promise open a bit
    // longer which helps joinChannel's pendingDisconnect check.
    if (pendingDisconnect) {
      await waitForPendingDisconnect(DISCONNECT_WAIT_ON_LEAVE_MS);
    }
    // Notify server AFTER UI is clean. Fire-and-forget with a short timeout
    // so a slow/hung server doesn't block anything. The server also detects
    // our departure when the WebSocket/WebRTC connection drops.
    if (channelId) {
      voiceApi.leaveChannel(channelId).catch((err) => {
        console.warn('[voice] leave channel API error (continuing disconnect):', err);
      });
    }
  },

  toggleMute: async () => {
    const state = get();
    const nextSelfMute = !state.selfMute;
    const nextSelfDeaf = nextSelfMute ? state.selfDeaf : false;
    set({
      selfMute: nextSelfMute,
      selfDeaf: nextSelfDeaf,
    });
    setAttachedRemoteAudioMuted(nextSelfDeaf);
    if (!state.room) return;
    // Don't attempt mic operations if the room is reconnecting or disconnected.
    if (!isRoomConnected(state.room)) {
      console.warn('[voice] toggleMute: room not connected, deferring mic change');
      return;
    }
    const targetMicEnabled = !nextSelfMute;
    const ok = await setMicrophoneEnabledWithFallback(state.room, targetMicEnabled, getSavedInputDeviceId());
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
    const state = get();
    const nextSelfDeaf = !state.selfDeaf;
    const nextSelfMute = nextSelfDeaf ? true : state.selfMute;
    set({
      selfDeaf: nextSelfDeaf,
      selfMute: nextSelfMute,
    });
    setAttachedRemoteAudioMuted(nextSelfDeaf);
    if (!state.room) return;
    // Don't attempt mic operations if the room is reconnecting or disconnected.
    if (!isRoomConnected(state.room)) {
      console.warn('[voice] toggleDeaf: room not connected, deferring mic change');
      return;
    }
    const targetMicEnabled = !nextSelfMute;
    const ok = await setMicrophoneEnabledWithFallback(state.room, targetMicEnabled, getSavedInputDeviceId());
    if (ok && targetMicEnabled) {
      startLocalAudioUplinkMonitor(state.room as Room);
    } else if (!targetMicEnabled) {
      stopLocalAudioUplinkMonitor();
    }
    if (!ok && targetMicEnabled) {
      set({ selfMute: true });
    }
  },

  startStream: async (qualityPreset = '1080p60') => {
    const { channelId, room } = get();
    if (!channelId || !room) {
      throw new Error('Voice connection is not ready');
    }
    if (!isRoomConnected(room)) {
      throw new Error('Voice connection is not stable — try again in a moment');
    }
    set({ streamAudioWarning: null, systemAudioCaptureActive: false });
    try {
      // 1. Register stream state on the server.
      const { data } = await voiceApi.startStream(channelId, { quality_preset: qualityPreset });

      // Keep the existing LiveKit session and publish screen share in-place.
      // Join tokens already allow screen-share sources for speakers.
      const normalizedUrl = normalizeLivekitUrl(data.url, data.url_candidates);

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

      // Keep microphone state aligned with current mute/deafen state.
      const shouldEnableMic = !(get().selfMute || get().selfDeaf);
      await setMicrophoneEnabledWithFallback(room, shouldEnableMic, streamInputId);
      if (shouldEnableMic) {
        startLocalAudioUplinkMonitor(room as Room);
      }
      setAttachedRemoteAudioMuted(get().selfDeaf);
      syncRemoteAudioTracks(room, get().selfDeaf);

      // Voice audio no longer needs to be rerouted to a different device.
      // The Process Loopback Exclusion API excludes our own process audio
      // at the OS level, so voice plays on the normal default device.

      // 2. Start screen share
      //    with resolution/framerate constraints matching the preset.
      //    We configure BOTH capture constraints (resolution/fps the browser
      //    captures at) AND encoding parameters (bitrate/fps the WebRTC
      //    encoder targets). Without explicit encoding params LiveKit falls
      //    back to very conservative defaults causing blocky, low-fps streams.
      const presetMap: Record<string, ScreenCapturePreset> = {
        '720p30':      { width: 1280, height: 720,  frameRate: 30, maxBitrate: 8_000_000,   hint: 'motion' },
        '1080p60':     { width: 1920, height: 1080, frameRate: 60, maxBitrate: 25_000_000,  hint: 'motion' },
        '1440p60':     { width: 2560, height: 1440, frameRate: 60, maxBitrate: 35_000_000,  hint: 'motion' },
        '4k60':        { width: 3840, height: 2160, frameRate: 60, maxBitrate: 50_000_000,  hint: 'motion' },
        'movie-50':    { width: 3840, height: 2160, frameRate: 60, maxBitrate: 60_000_000,  hint: 'motion' },
        'movie-100':   { width: 3840, height: 2160, frameRate: 60, maxBitrate: 100_000_000, hint: 'motion' },
      };
      const capture = presetMap[qualityPreset] ?? presetMap['1080p60'];
      const isTauriApp = isTauri();

      await room.localParticipant.setScreenShareEnabled(true, {
        // In Tauri, skip browser audio capture â€” we use native WASAPI/PulseAudio
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
        contentHint: capture.hint,
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
        // AudioPresets.speech (24 kbps mono) â€" far too low for system audio.
        audioPreset: { maxBitrate: 128_000 },
        forceStereo: true,
        dtx: false,
        red: false,
      });

      const screenShareVideoPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const screenShareVideoTrack = screenShareVideoPub?.track?.mediaStreamTrack;
      if (screenShareVideoTrack) {
        await tuneScreenShareCaptureTrack(screenShareVideoTrack, capture);
      } else {
        console.warn('[voice] Screen share video track not immediately available for constraint tuning');
      }

      let streamAudioWarning: string | null = null;
      let systemAudioCaptureActive = false;

      const publishNativeSystemAudio = async (): Promise<boolean> => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const nativeAudioTrack = await startNativeSystemAudio();
          if (!nativeAudioTrack) {
            if (attempt < 2) {
              await delay(250);
            }
            continue;
          }

          try {
            await room.localParticipant.publishTrack(nativeAudioTrack, {
              source: Track.Source.ScreenShareAudio,
              audioPreset: { maxBitrate: 128_000 },
              forceStereo: true,
              dtx: false,
              red: false,
            });
            console.info('[voice] Published native system audio as ScreenShareAudio (Tauri)');
            return true;
          } catch (err) {
            console.warn('[voice] Failed to publish native system audio track:', err);
            void stopNativeSystemAudio();
            if (attempt < 2) {
              await delay(250);
            }
          }
        }

        return false;
      };

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
          await delay(120);
        }

        return room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio
        ) as LocalTrackPublication | undefined;
      };

      if (isTauriApp) {
        if (!hasAcknowledgedSystemAudioPrivacyWarning()) {
          set({ showSystemAudioPrivacyWarning: true });
        }
        // In Tauri, publish native loopback audio with a retry path so brief
        // backend races don't leave the stream silently video-only.
        const nativePublished = await publishNativeSystemAudio();
        systemAudioCaptureActive = nativePublished;
        if (!nativePublished) {
          streamAudioWarning =
            'Stream started without PC audio. Native system audio capture failed. ' +
            'Try stopping the stream and starting it again.';
          console.warn('[voice] Native system audio capture failed; stream is video-only.');
        }
      } else {
        const screenShareAudioPub = await waitForScreenShareAudioPublication();
        if (screenShareAudioPub?.track) {
          console.info('[voice] Screen share audio track published â€” viewers will hear stream audio');
        } else {
          streamAudioWarning =
            'Stream started without audio. Share an entire screen/tab and keep "Share audio" enabled.';
          console.warn(
            '[voice] No screen share audio track â€” audio not captured.',
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
        set({ voiceSuppressedForStream: true });
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
      set({
        selfStream: true,
        livekitToken: data.token,
        livekitUrl: normalizedUrl,
        roomName: data.room_name,
        streamAudioWarning,
        systemAudioCaptureActive,
      });
    } catch (error) {
      void stopNativeSystemAudio();
      suppressVoiceForStream(false);
      await room.localParticipant.setScreenShareEnabled(false).catch(() => { });
      // Notify server that stream failed
      if (channelId) {
        voiceApi.stopStream(channelId).catch((err) => {
          console.warn('[voice] Failed to stop stream after start failure rollback:', err);
        });
      }
      set({ selfStream: false, streamAudioWarning: null, systemAudioCaptureActive: false, voiceSuppressedForStream: false });
      throw error;
    }
  },

  stopStream: () => {
    const { channelId, room } = get();
    // Notify server to clear stream state
    if (channelId) {
      voiceApi.stopStream(channelId).catch((err) => {
        console.warn('[voice] Failed to stop stream on manual stop:', err);
      });
    }
    room?.localParticipant.setScreenShareEnabled(false).catch(() => {});
    void stopNativeSystemAudio();
    // Restore voice audio that was suppressed to prevent echo in stream capture.
    suppressVoiceForStream(false);
    // Revert voice audio elements to the user's selected output device
    const savedOutputId = getSavedOutputDeviceId() || '';
    const voiceEls = document.querySelectorAll<HTMLAudioElement>('[data-paracord-voice-audio]');
    for (const el of voiceEls) {
      el.setSinkId?.(savedOutputId).catch(() => {});
    }
    // Revert stream audio elements back to the default device
    const streamEls = document.querySelectorAll<HTMLAudioElement>('[data-paracord-stream-audio]');
    for (const el of streamEls) {
      el.setSinkId?.('default').catch(() => {});
    }
    // Also update the local user's voice-state entry so that
    // participants-derived flags reflect the stream ending immediately,
    // even before a gateway event arrives.
    const localUserId = useAuthStore.getState().user?.id;
    set((state) => {
      const participants = new Map(state.participants);
      if (localUserId) {
        const existing = participants.get(localUserId);
        if (existing) {
          participants.set(localUserId, { ...existing, self_stream: false });
        }
      }
      return {
        selfStream: false,
        participants,
        streamAudioWarning: null,
        systemAudioCaptureActive: false,
        voiceSuppressedForStream: false,
      };
    });
  },

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
    let normalizedDeviceId = normalizeDeviceId(deviceId);
    if (normalizedDeviceId && invalidAudioInputDeviceIds.has(normalizedDeviceId)) {
      normalizedDeviceId = undefined;
    }
    try {
      try {
        await room.switchActiveDevice('audioinput', normalizedDeviceId ?? 'default');
      } catch (err) {
        // Device constraints can fail for stale IDs and occasionally even for
        // "default" when browser/device state changes. Recover by forcing a
        // fresh mic publish path with default capture selection.
        if (isDeviceConstraintError(err)) {
          console.warn(
            '[voice] Input device constraints failed; resetting to default microphone:',
            err
          );
          if (normalizedDeviceId) {
            invalidAudioInputDeviceIds.add(normalizedDeviceId);
          }
          normalizedDeviceId = undefined;
        } else {
          throw err;
        }
      }
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
  acknowledgeSystemAudioPrivacyWarning: () => {
    persistSystemAudioPrivacyWarningAcknowledgement();
    set({ showSystemAudioPrivacyWarning: false });
  },

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

// Cleanly disconnect the LiveKit room before the page unloads so the
// browser doesn't tear down the WebSocket mid-flight, which causes
// unhandled promise rejections inside livekit-client.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    const room = useVoiceStore.getState().room;
    if (room) {
      room.disconnect().catch(() => {});
    }
  });
}
