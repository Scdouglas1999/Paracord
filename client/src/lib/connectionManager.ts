import { type AxiosInstance } from 'axios';
import { createApiClient } from '../api/client';
import { responseContract } from '../api/responseContracts';
import { isCurrentUser } from '../api/generated/validators';
import { useServerListStore, type ServerEntry } from '../stores/serverListStore';
import { useAccountStore } from '../stores/accountStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import {
  hasUnlockedPrivateKey,
  signServerChallengeWithUnlockedKey,
} from './accountSession';
import { getRefreshToken, setAccessToken, setRefreshToken } from './authToken';
import { getCurrentOriginServerUrl, getStoredServerUrl } from './config/apiBaseUrl';
import { isTauri } from './tauriEnv';
import { syncTrustedHosts } from './trustedHosts';
import { inflateSync } from 'fflate';
import type { Activity, GatewayPayload } from '../types';
import { GatewayEvents } from '../gateway/events';
import { dispatchGatewayEvent } from '../gateway/dispatch';
import { logVoiceDiagnostic } from './desktopDiagnostics';
import { LOCAL_SERVER_ID } from './serverScope';
import { getServerAccountScope } from './serverIdentity';
import { acceptDatabaseHistoryEpoch, getDatabaseHistoryEpoch, registerHistoryReconciler } from './databaseHistory';
import { toast } from '../stores/toastStore';
import { notifyServerDisconnected } from './serverDisconnect';
import { pauseAccountMessagingForRecovery } from './messages/accountMessagingRuntime';

export { LOCAL_SERVER_ID } from './serverScope';

/**
 * Rate-limited diagnostic for frames we couldn't parse. We deliberately log
 * only the transport and a short, truncated prefix of the payload — never the
 * full frame, which may contain message content or tokens — and at most once
 * per interval so a burst of malformed frames can't flood the console.
 */
const MALFORMED_FRAME_WARN_INTERVAL_MS = 10_000;
const MALFORMED_FRAME_PREFIX_LEN = 48;
let lastMalformedFrameWarnTs = 0;
export function warnMalformedFrame(transport: 'sse' | 'ws', rawPreview: string): void {
  const now = Date.now();
  if (now - lastMalformedFrameWarnTs < MALFORMED_FRAME_WARN_INTERVAL_MS) return;
  lastMalformedFrameWarnTs = now;
  const prefix = rawPreview.slice(0, MALFORMED_FRAME_PREFIX_LEN);
  console.warn(
    `[gateway] dropping malformed ${transport} frame (prefix: ${JSON.stringify(prefix)})`,
  );
}

function monotonicNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

type RealtimeEventSource = {
  readyState: number;
  onopen: ((evt: Event) => void) | null;
  onmessage: ((evt: MessageEvent<string>) => void) | null;
  onerror: ((evt: Event) => void) | null;
  addEventListener: (type: string, listener: (evt: MessageEvent<string>) => void) => void;
  close: () => void;
};

type NativeSsePayload = {
  streamId?: string;
  kind?: 'open' | 'message' | 'error';
  event?: string | null;
  data?: string | null;
  error?: string | null;
};

class NativeSseConnection implements RealtimeEventSource {
  private static nextId = 1;

  readonly streamId = `native-sse-${Date.now().toString(36)}-${NativeSseConnection.nextId++}`;
  readyState = 0;
  onopen: ((evt: Event) => void) | null = null;
  onmessage: ((evt: MessageEvent<string>) => void) | null = null;
  onerror: ((evt: Event) => void) | null = null;

  private closed = false;
  private unlisten: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(evt: MessageEvent<string>) => void>>();

  constructor(private readonly url: string) {}

  addEventListener(type: string, listener: (evt: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 2;
    this.unlisten?.();
    this.unlisten = null;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('stop_native_sse_stream', { streamId: this.streamId }))
      .catch(() => undefined);
  }

  async start(): Promise<void> {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]);

    if (this.closed) return;
    const unlisten = await listen<NativeSsePayload>('native_sse_event', (evt) => {
      if (this.closed || evt.payload?.streamId !== this.streamId) return;
      if (evt.payload.kind === 'open') {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        return;
      }

      if (evt.payload.kind === 'message') {
        const data = evt.payload.data ?? '';
        const eventType = evt.payload.event || 'message';
        const message = new MessageEvent<string>(eventType, { data });
        if (eventType === 'message') {
          this.onmessage?.(message);
        }
        this.listeners.get(eventType)?.forEach((listener) => listener(message));
        return;
      }

      if (evt.payload.kind === 'error') {
        this.readyState = 2;
        this.onerror?.(new Event('error'));
      }
    });

    if (this.closed) { unlisten(); return; }
    this.unlisten = unlisten;
    try {
      await invoke('start_native_sse_stream', { streamId: this.streamId, url: this.url });
      // A close may race native startup. Stop again after startup completes so
      // a stream created after the earlier stop cannot outlive its generation.
      if (this.closed) await invoke('stop_native_sse_stream', { streamId: this.streamId });
    } catch {
      if (this.closed) return;
      this.readyState = 2;
      this.onerror?.(new Event('error'));
    }
  }
}

async function openRealtimeEventSource(url: string): Promise<RealtimeEventSource> {
  if (isTauri()) {
    return new NativeSseConnection(url);
  }
  return new EventSource(url, { withCredentials: true });
}

export interface ServerConnection {
  serverId: string;
  /** Bound after an authenticated handshake, before any events are applied. */
  accountId?: string;
  /** The access token this transport was established with. A replacement
   *  session (identity attach, password change) revokes the old one, so a
   *  stream opened with it can never deliver this account's events again. */
  sessionToken?: string | null;
  historyEpoch?: string;
  serverUrl: string;
  apiClient: AxiosInstance;
  ws: WebSocket | null;
  eventSource: RealtimeEventSource | null;
  streamUrl: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatInterval: number | null;
  /** SSE liveness watchdog timer (WS uses the heartbeat instead). */
  sseWatchdogTimer: ReturnType<typeof setInterval> | null;
  /** Timestamp of the last SSE frame (event or open) for the watchdog. */
  lastFrameTs: number;
  sequence: number | null;
  sessionId: string | null;
  realtimeCursor: number | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  allowReconnect: boolean;
  connected: boolean;
  connecting: boolean;
  lastHeartbeatSentAtMs: number;
  missedAcks: number;
  connectionLatency: number;
  pendingMessages: unknown[];
}

type DispatchPayload = GatewayPayload & { event_id?: number };
type DispatchResult = void | false | Promise<void | false>;
type DispatchEntry = { payload: DispatchPayload; bytes: number };
type DispatchLane = {
  accountId: string | undefined;
  queue: DispatchEntry[];
  bytes: number;
  draining: boolean;
};

class ConnectionManager {
  private connections = new Map<string, ServerConnection>();
  /** The in-flight `connectAll()`, if any. See `connectAll`. */
  private connectAllInFlight: Promise<void> | null = null;
  /** A `connectAll()` asked for while one was running; collapses to one re-run. */
  private connectAllQueued = false;
  private connecting = new Map<string, Promise<void>>();
  private static readonly MAX_PENDING_MESSAGES = 200;
  private static readonly MAX_DISPATCH_EVENTS = 1000;
  private static readonly MAX_DISPATCH_BYTES = 8 * 1024 * 1024;
  /** A new lane also fences asynchronous transport setup and old completions. */
  private readonly dispatchLanes = new WeakMap<ServerConnection, DispatchLane>();
  private readonly durableFailures = new WeakMap<ServerConnection, number>();
  private readonly accountHydrationWaits = new WeakMap<ServerConnection, () => void>();
  /** Consecutive missed liveness checks (heartbeat acks / SSE frames) before a
   *  connection is considered stale and torn down. Shared by WS and SSE. */
  private static readonly MAX_MISSED_ACKS = 3;
  /** How often the SSE watchdog looks at the stream. It is a sampling rate, not
   *  a budget: the decision below is made from the elapsed time since the last
   *  frame, so a slow tick can never shorten the tolerated silence. */
  private static readonly SSE_WATCHDOG_INTERVAL_MS = 15_000;
  /** How long a v2 SSE stream may stay silent before it is declared dead.
   *
   *  The server heartbeats an idle stream every 15 s (`SSE_KEEPALIVE_INTERVAL`
   *  in crates/paracord-api/src/routes/realtime.rs), so this tolerates four
   *  missed heartbeats. It must stay a multiple of that interval: the previous
   *  watchdog counted ticks instead of measuring silence and, because the
   *  server's keepalive was an SSE comment that no client can observe, it tore
   *  down every healthy idle stream on a fixed 90 s cycle. */
  private static readonly SSE_SILENCE_LIMIT_MS = 60_000;
  /** How long a stream must stay up before its reconnect backoff is forgiven.
   *  Long enough that a connect/drop loop cannot keep resetting itself. */
  private static readonly SSE_SETTLED_MS = 30_000;
  private readonly useRealtimeV2 =
    import.meta.env.VITE_RT_V2 !== '0' && import.meta.env.VITE_RT_V2 !== 'false';
  private offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  /** Timer for automatic recovery when the gateway lands in 'disconnected'. */
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempts = 0;

  constructor() {
    registerHistoryReconciler(scope => {
      const conn = this.connections.get(scope.serverId);
      if (conn && getServerAccountScope(scope.serverId)?.userId === scope.userId) this.reconcileHistory(conn);
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.offline = false;
        void this.connectAll();
      });
      window.addEventListener('offline', () => {
        this.offline = true;
        this.syncUiConnectionStatus();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          // Avoid tearing down healthy sockets on every tab focus; only
          // reconcile when something is missing or unhealthy.
          if (this.allExpectedConnectionsHealthy()) return;
          void this.connectAll();
        }
      });
    }
  }

  private isCurrentConnection(conn: ServerConnection): boolean {
    return this.connections.get(conn.serverId) === conn;
  }

  /** A reload can restore its token before /users/@me establishes its owner. */
  private waitForVerifiedAccount(conn: ServerConnection, resume: () => void): boolean {
    if (getServerAccountScope(conn.serverId)) return false;
    if (this.accountHydrationWaits.has(conn)) return true;
    const token = this.tokenForConnection(conn);
    if (!token) return true;
    conn.connecting = false;
    conn.connected = false;
    let unsubscribe = () => {};
    const stop = () => {
      unsubscribe();
      if (this.accountHydrationWaits.get(conn) === stop) this.accountHydrationWaits.delete(conn);
    };
    const hydrated = () => {
      if (!this.isCurrentConnection(conn) || !conn.allowReconnect
        || this.tokenForConnection(conn) !== token) { stop(); return; }
      if (!getServerAccountScope(conn.serverId)) return;
      stop();
      resume();
    };
    this.accountHydrationWaits.set(conn, stop);
    unsubscribe = conn.serverId === LOCAL_SERVER_ID
      ? useAuthStore.subscribe(hydrated) : useServerListStore.subscribe(hydrated);
    this.syncUiConnectionStatus();
    return true;
  }

  private beginTransport(conn: ServerConnection): DispatchLane {
    this.invalidateDispatchLane(conn);
    const lane: DispatchLane = {
      accountId: getServerAccountScope(conn.serverId)?.userId,
      queue: [], bytes: 0, draining: false,
    };
    this.dispatchLanes.set(conn, lane);
    this.pauseMessagingRecovery(conn);
    return lane;
  }

  private pauseMessagingRecovery(conn: ServerConnection): void {
    if (!this.isCurrentConnection(conn)) return;
    const scope = getServerAccountScope(conn.serverId);
    const owner = this.dispatchLanes.get(conn)?.accountId ?? conn.accountId;
    if (scope && scope.userId === owner && (!conn.accountId || conn.accountId === owner)) {
      pauseAccountMessagingForRecovery(scope);
    }
  }

  private ownsTransport(conn: ServerConnection, lane: DispatchLane): boolean {
    return this.isCurrentConnection(conn) && conn.allowReconnect
      && this.dispatchLanes.get(conn) === lane
      && getServerAccountScope(conn.serverId)?.userId === lane.accountId
      && (!conn.accountId || conn.accountId === lane.accountId);
  }

  /**
   * A realtime setup step found that its lane no longer owns the connection.
   *
   * Two different things land here. If a *newer* transport has taken over, this
   * one simply stops: the newer attempt owns `conn.connecting` and will report
   * its own result. If no newer transport exists — the lane lost ownership
   * because the account scope moved under it — then nothing else is coming, and
   * returning quietly used to leave `conn.connecting` true forever: a realtime
   * session created on the server whose stream was never opened, and a client
   * that `isConnectionHealthy()` still called healthy. Say so, and retry.
   */
  private abandonTransport(conn: ServerConnection, lane: DispatchLane, stage: string): void {
    const superseded = this.dispatchLanes.get(conn) !== lane;
    logVoiceDiagnostic('[gateway] SSE setup abandoned', {
      server: conn.serverId,
      stage,
      reason: superseded ? 'newer transport' : 'account scope changed',
    });
    if (superseded || !this.isCurrentConnection(conn) || !conn.allowReconnect) return;
    conn.connecting = false;
    conn.connected = false;
    this.cleanupConnection(conn);
    this.reconnectGateway(conn);
  }

  private invalidateDispatchLane(conn: ServerConnection): void {
    const lane = this.dispatchLanes.get(conn);
    if (lane) { lane.queue.length = 0; lane.bytes = 0; }
    this.dispatchLanes.delete(conn);
  }

  /** Conservative retained JSON heap estimate, bounded even for deeply nested frames. */
  private dispatchBytes(payload: DispatchPayload): number {
    const pending: unknown[] = [payload];
    let bytes = 0;
    while (pending.length && bytes <= ConnectionManager.MAX_DISPATCH_BYTES) {
      const value = pending.pop();
      if (typeof value === 'string') bytes += 32 + value.length * 2;
      else if (value && typeof value === 'object') {
        bytes += 64;
        if (Array.isArray(value)) {
          bytes += value.length * 16;
          if (bytes > ConnectionManager.MAX_DISPATCH_BYTES) break;
          for (const item of value) pending.push(item);
        } else {
          for (const key of Object.keys(value)) {
            bytes += 32 + key.length * 2;
            if (bytes > ConnectionManager.MAX_DISPATCH_BYTES) break;
            pending.push((value as Record<string, unknown>)[key]);
          }
        }
      } else bytes += 16;
    }
    return bytes;
  }

  private enqueueDispatch(conn: ServerConnection, lane: DispatchLane, payload: DispatchPayload): void {
    if (!this.ownsTransport(conn, lane)) return;
    if (typeof payload.t !== 'string'
      || [payload.s, payload.event_id].some(value => value != null && (!Number.isSafeInteger(value) || value < 0))) {
      this.failDispatch(conn, lane, 'invalid dispatch checkpoint', payload.t);
      return;
    }
    const bytes = this.dispatchBytes(payload);
    if (lane.queue.length >= ConnectionManager.MAX_DISPATCH_EVENTS
      || lane.bytes + bytes > ConnectionManager.MAX_DISPATCH_BYTES) {
      this.failDispatch(conn, lane, 'queue capacity exceeded', payload.t);
      return;
    }
    lane.queue.push({ payload, bytes });
    lane.bytes += bytes;
    if (!lane.draining) this.drainDispatch(conn, lane);
  }

  /** Keep the synchronous path synchronous; only a durable promise creates a barrier. */
  private drainDispatch(conn: ServerConnection, lane: DispatchLane): void {
    lane.draining = true;
    while (this.ownsTransport(conn, lane) && lane.queue.length) {
      const entry = lane.queue[0];
      let result: DispatchResult;
      try { result = this.handleDispatch(conn, entry.payload.t!, entry.payload.d, lane); }
      catch { this.failDispatch(conn, lane, 'durable event storage failed', entry.payload.t); return; }
      if (result !== undefined && result !== false) {
        void result.then(accepted => {
          if (!this.completeDispatch(conn, lane, entry, accepted)) return;
          // READY alone cannot erase backoff for a repeatedly failing replay.
          if (entry.payload.t !== GatewayEvents.READY && entry.payload.t !== GatewayEvents.RESUMED) {
            this.durableFailures.delete(conn);
            conn.reconnectAttempts = 0;
          }
          this.drainDispatch(conn, lane);
        }, () => this.failDispatch(conn, lane, 'durable event storage failed', entry.payload.t));
        return;
      }
      if (!this.completeDispatch(conn, lane, entry, result)) return;
    }
    lane.draining = false;
  }

  private completeDispatch(conn: ServerConnection, lane: DispatchLane, entry: DispatchEntry, accepted: void | false): boolean {
    if (!this.ownsTransport(conn, lane)) return false;
    if (accepted === false) {
      this.failDispatch(conn, lane, 'event rejected by account or history boundary', entry.payload.t);
      return false;
    }
    try {
      const scope = getServerAccountScope(conn.serverId);
      if (!scope || getDatabaseHistoryEpoch(scope) !== (conn.historyEpoch ?? null)) {
        this.failDispatch(conn, lane, 'database history changed during event storage', entry.payload.t);
        return false;
      }
    } catch {
      this.failDispatch(conn, lane, 'database history metadata unavailable', entry.payload.t);
      return false;
    }
    // Older WS servers advertise the replay head in RESUMED, before replaying
    // it. A handshake cannot acknowledge those still-undelivered events.
    if (entry.payload.t !== GatewayEvents.RESUMED && entry.payload.s != null) conn.sequence = entry.payload.s;
    if (typeof entry.payload.event_id === 'number') conn.realtimeCursor = entry.payload.event_id;
    lane.queue.shift();
    lane.bytes -= entry.bytes;
    return true;
  }

  private failDispatch(conn: ServerConnection, lane: DispatchLane, reason: string, event?: string): void {
    if (!this.ownsTransport(conn, lane)) return;
    // Attaching a device identity mints a new bearer token and revokes the old
    // session, which disposes the account runtime under whatever dispatch is in
    // flight. The reconnect is legitimate — the session really was replaced —
    // but it is not a storage failure and it is not this connection's fault, so
    // it is neither reported as one nor counted against reconnect backoff.
    const replaced = this.tokenChanged(conn);
    if (!replaced) {
      const failures = (this.durableFailures.get(conn) ?? 0) + 1;
      this.durableFailures.set(conn, failures);
      conn.reconnectAttempts = Math.max(conn.reconnectAttempts, failures);
    }
    // Payloads, storage exception messages, tokens, and URLs must never enter diagnostics.
    const diagnostic = {
      reason: replaced ? 'session replaced' : reason,
      event: event && /^[A-Z_]{1,64}$/.test(event) ? event : 'unknown',
    };
    if (replaced) console.info('[gateway] Reconnecting: this account session was replaced.', diagnostic);
    else console.error('[gateway] Cannot complete gateway delivery; reconnecting from the last completed checkpoint.', diagnostic);
    // The desktop diagnostics file is the only record of a client that will not
    // stay connected, and this is one of the two paths that drops the stream.
    // Reported to the console alone, it left a log that showed a session being
    // created every thirty seconds and nothing whatsoever about why.
    logVoiceDiagnostic('[gateway] dispatch failed, reconnecting', {
      server: conn.serverId,
      ...diagnostic,
      attempt: conn.reconnectAttempts,
    });
    const ws = conn.ws; const es = conn.eventSource;
    conn.ws = null; conn.eventSource = null;
    conn.connected = false; conn.connecting = false;
    this.cleanupConnection(conn);
    ws?.close(); es?.close();
    if (conn.serverId !== LOCAL_SERVER_ID) useServerListStore.getState().setConnected(conn.serverId, false);
    this.reconnectGateway(conn);
  }

  /** True when a connection already has a live transport (or is mid-connect). */
  /**
   * A replacement session cannot inherit the revoked session's stream. Its
   * resume checkpoint belongs to the old session too, so a fresh authenticated
   * READY must re-establish the account's state.
   */
  /** Pure form of {@link sessionReplaced}: does this session's token still stand? */
  private tokenChanged(conn: ServerConnection): boolean {
    if (conn.sessionToken === undefined) return false;
    const token = this.tokenForConnection(conn);
    return Boolean(token) && token !== conn.sessionToken;
  }

  private sessionReplaced(conn: ServerConnection): boolean {
    if (conn.sessionToken === undefined) return false;
    const token = this.tokenForConnection(conn);
    if (!token || token === conn.sessionToken) return false;
    conn.sessionId = null; conn.sequence = null; conn.realtimeCursor = null; conn.pendingMessages = [];
    return true;
  }

  private isConnectionHealthy(conn: ServerConnection): boolean {
    if (conn.connecting || conn.reconnectTimer !== null) return true;
    if (!conn.connected) return false;
    if (this.useRealtimeV2) {
      if (conn.eventSource !== null) return true;
      // Duplicate-URL cover: another connection owns the live SSE stream.
      const normalizedUrl = conn.serverUrl.replace(/\/+$/, '');
      for (const other of this.connections.values()) {
        if (
          other !== conn &&
          other.connected &&
          other.eventSource !== null &&
          other.serverUrl.replace(/\/+$/, '') === normalizedUrl
        ) {
          return true;
        }
      }
      return false;
    }
    return (
      conn.ws !== null &&
      (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)
    );
  }

  /**
   * Visibility-focus fast path: skip connectAll when every expected server
   * already has a healthy connection. Still reconnects when the store is
   * unhydrated, offline, or any expected connection is missing/stale.
   */
  private allExpectedConnectionsHealthy(): boolean {
    if (this.offline) return false;
    const serverState = useServerListStore.getState();
    if (!serverState.hydrated || !serverState.tokensHydrated) return false;

    const servers = serverState.servers;
    const localToken = useAuthStore.getState().token;
    if (servers.length === 0 && !localToken) return false;

    for (const server of servers) {
      const conn = this.connections.get(server.id);
      if (!conn || !this.isConnectionHealthy(conn)) return false;
    }

    if (localToken) {
      const localUrl = this.resolveLocalServerUrl().replace(/\/+$/, '');
      const localAlreadyCovered = servers.some((s) => {
        const latest = useServerListStore.getState().getServer(s.id);
        return (
          this.sameServerUrl(s.url, localUrl) ||
          (!!localToken && latest?.token === localToken)
        );
      });
      if (!localAlreadyCovered) {
        const local = this.connections.get(LOCAL_SERVER_ID);
        if (!local || !this.isConnectionHealthy(local)) return false;
      }
    }

    return true;
  }

  /** Keep the global status bar aligned with aggregate per-server socket state. */
  private syncUiConnectionStatus(): void {
    const all = Array.from(this.connections.values());

    type Status = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
    let status: Status = 'disconnected';

    if (all.length === 0 || this.offline) {
      status = 'disconnected';
    } else if (all.some((conn) => conn.connected)) {
      status = 'connected';
    } else if (
      all.some(
        (conn) =>
          conn.ws?.readyState === WebSocket.CONNECTING ||
          conn.connecting ||
          conn.eventSource !== null
      )
    ) {
      status = 'connecting';
    } else if (all.some((conn) => conn.reconnectTimer !== null)) {
      status = 'reconnecting';
    }

    useUIStore.getState().setConnectionStatus(status);

    // Auto-recovery: when we land on 'disconnected' but servers should be
    // connected, schedule a `connectAll()` with exponential back-off so the
    // gateway doesn't stay permanently dead after e.g. a token refresh failure.
    if (status === 'connected') {
      this.recoveryAttempts = 0;
      if (this.recoveryTimer) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
      }
    } else if (status === 'disconnected' && !this.offline && !this.recoveryTimer) {
      const servers = useServerListStore.getState().servers;
      const localToken = useAuthStore.getState().token;
      if (servers.length > 0 || localToken) {
        const delay = Math.min(5000 * Math.pow(2, this.recoveryAttempts), 60_000);
        this.recoveryAttempts++;
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          void this.connectAll();
        }, delay);
      }
    }
  }

  /** Get or create a connection for a server */
  getConnection(serverId: string): ServerConnection | undefined {
    return this.connections.get(serverId);
  }

  /** Get the API client for a specific server */
  getApiClient(serverId: string): AxiosInstance | undefined {
    return this.connections.get(serverId)?.apiClient;
  }

  /** Get the API client for the currently active server */
  getActiveApiClient(): AxiosInstance | undefined {
    const activeId = useServerListStore.getState().activeServerId;
    if (activeId) {
      return this.connections.get(activeId)?.apiClient;
    }
    return this.connections.get(LOCAL_SERVER_ID)?.apiClient;
  }

  /** Authenticate with a server using challenge-response, then connect gateway */
  async connectServer(serverId: string): Promise<void> {
    const inFlight = this.connecting.get(serverId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const connectTask = this.connectServerInternal(serverId);
    this.connecting.set(serverId, connectTask);
    try {
      await connectTask;
    } finally {
      const current = this.connecting.get(serverId);
      if (current === connectTask) {
        this.connecting.delete(serverId);
      }
    }
  }

  async connectLocal(): Promise<void> {
    const inFlight = this.connecting.get(LOCAL_SERVER_ID);
    if (inFlight) {
      await inFlight;
      return;
    }

    const connectTask = this.connectLocalInternal();
    this.connecting.set(LOCAL_SERVER_ID, connectTask);
    try {
      await connectTask;
    } finally {
      const current = this.connecting.get(LOCAL_SERVER_ID);
      if (current === connectTask) {
        this.connecting.delete(LOCAL_SERVER_ID);
      }
    }
  }

  /**
   * The local server URL only when one is genuinely configured.
   *
   * `resolveLocalServerUrl()` always answers — it falls back to a hardcoded
   * default so a connect attempt has somewhere to go. That default is a guess,
   * and a guess must never be presented to the user as a server to trust.
   */
  private configuredLocalServerUrl(): string | null {
    const stored = getStoredServerUrl();
    if (stored) return stored;
    const currentOrigin = getCurrentOriginServerUrl();
    if (currentOrigin) return currentOrigin;
    if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol) && window.location.host) {
      return `${window.location.protocol}//${window.location.host}`;
    }
    return null;
  }

  private resolveLocalServerUrl(): string {
    const stored = getStoredServerUrl();
    if (stored) return stored;

    const currentOrigin = getCurrentOriginServerUrl();
    if (currentOrigin) return currentOrigin;

    if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol) && window.location.host) {
      return `${window.location.protocol}//${window.location.host}`;
    }

    return 'http://localhost:8080';
  }

  private canonicalServerUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase() === 'localhost'
        ? '127.0.0.1'
        : parsed.hostname.toLowerCase();
      const port = parsed.port ? `:${parsed.port}` : '';
      const pathname = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.protocol}//${hostname}${port}${pathname}`;
    } catch {
      return url.trim().replace(/\/+$/, '').toLowerCase();
    }
  }

  private sameServerUrl(left: string, right: string): boolean {
    return this.canonicalServerUrl(left) === this.canonicalServerUrl(right);
  }

  private isConfiguredLocalServerUrl(url: string): boolean {
    const candidates = [
      getStoredServerUrl(),
      getCurrentOriginServerUrl(),
      this.resolveLocalServerUrl(),
    ].filter((candidate): candidate is string => !!candidate);
    return candidates.some((candidate) => this.sameServerUrl(url, candidate));
  }

  private isLoopbackServerUrl(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      const normalized = hostname.toLowerCase();
      return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
    } catch {
      return false;
    }
  }

  private promoteLocalAuthSession(token: string, refreshToken?: string | null): void {
    setAccessToken(token);
    useAuthStore.setState({ token });
    if (refreshToken) {
      setRefreshToken(refreshToken);
    }
  }

  private async refreshServerSession(
    serverId: string,
    client: AxiosInstance,
    refreshToken: string | null,
    promoteToLocalAuth: boolean,
  ): Promise<string | null> {
    if (!refreshToken) return null;

    try {
      const { data } = await client.post<{ token?: string; refresh_token?: string }>(
        '/auth/refresh',
        { refresh_token: refreshToken },
        { timeout: 10_000 },
      );
      const nextToken = data.token;
      if (!nextToken) return null;
      useServerListStore.getState().updateToken(serverId, nextToken);
      if (data.refresh_token) {
        useServerListStore.getState().updateRefreshToken(serverId, data.refresh_token);
      }
      if (promoteToLocalAuth) {
        this.promoteLocalAuthSession(nextToken, data.refresh_token);
      }
      logVoiceDiagnostic('[gateway] refreshed saved server session', { server: serverId });
      return nextToken;
    } catch (err) {
      logVoiceDiagnostic('[gateway] saved server refresh failed', {
        server: serverId,
        error: String(err),
      });
      return null;
    }
  }

  private async verifyLocalSessionForServer(
    serverId: string,
    apiBaseUrl: string,
    candidateToken: string,
    candidateRefreshToken: string | null,
  ): Promise<string | null> {
    let verifiedToken = candidateToken;
    let verifiedRefreshToken = candidateRefreshToken;
    const probeClient = createApiClient(
      apiBaseUrl,
      () => verifiedToken,
      (nextToken, nextRefreshToken) => {
        verifiedToken = nextToken;
        if (nextRefreshToken) {
          verifiedRefreshToken = nextRefreshToken;
        }
        this.promoteLocalAuthSession(nextToken, nextRefreshToken);
      },
      undefined,
      (reachable) => useServerListStore.getState().setApiReachable(serverId, reachable),
      () => verifiedRefreshToken,
    );

    try {
      const { data } = await responseContract(
        probeClient.get('/users/@me', { timeout: 10_000 }),
        isCurrentUser,
        'CurrentUser',
      );
      useServerListStore.getState().updateToken(serverId, verifiedToken);
      if (verifiedRefreshToken) {
        useServerListStore.getState().updateRefreshToken(serverId, verifiedRefreshToken);
      }
      if (data?.id) {
        useServerListStore.getState().setAuthenticatedUser(serverId, data);
      }
      this.promoteLocalAuthSession(verifiedToken, verifiedRefreshToken);
      logVoiceDiagnostic('[gateway] verified local auth token for saved server', { server: serverId });
      return verifiedToken;
    } catch (err) {
      logVoiceDiagnostic('[gateway] local auth token not valid for saved server', {
        server: serverId,
        error: String(err),
      });
      return null;
    }
  }

  private async connectLocalInternal(): Promise<void> {
    const token = useAuthStore.getState().token;
    if (!token) {
      logVoiceDiagnostic('[gateway] connectLocalInternal: no authStore token, skipping');
      return;
    }
    logVoiceDiagnostic('[gateway] connectLocalInternal: have token, proceeding');

    const existing = this.connections.get(LOCAL_SERVER_ID);
    if (existing) {
      existing.allowReconnect = true;
      // Do not tear down a healthy SSE/WS on redundant connectAll() calls
      // (e.g. tab focus). Only reconnect when the transport is missing/stale,
      // or when this account's session was replaced under it.
      // Evaluate the credential first: a replaced session must forget its
      // resume point even when the transport was already unhealthy.
      const replaced = this.sessionReplaced(existing);
      if (!this.isConnectionHealthy(existing) || replaced) {
        this.connectRealtime(existing);
      }
      return;
    }

    const serverUrl = this.resolveLocalServerUrl();
    const apiBaseUrl = `${serverUrl.replace(/\/+$/, '')}/api/v1`;
    const client = createApiClient(
      apiBaseUrl,
      () => useAuthStore.getState().token,
      (nextToken, nextRefreshToken) => {
        setAccessToken(nextToken);
        useAuthStore.setState({ token: nextToken });
        if (nextRefreshToken) setRefreshToken(nextRefreshToken);
        // An ordinary refresh keeps the same realtime session; only an external
        // replacement must drop the transport.
        const current = this.connections.get(LOCAL_SERVER_ID);
        if (current && current.sessionToken !== undefined) current.sessionToken = nextToken;
      },
      () => {
        setAccessToken(null);
        useAuthStore.setState({ token: null, user: null });
        this.disconnectServer(LOCAL_SERVER_ID);
      },
      undefined,
      () => getRefreshToken(),
    );

    const conn: ServerConnection = {
      serverId: LOCAL_SERVER_ID,
      serverUrl,
      apiClient: client,
      ws: null,
      eventSource: null,
      streamUrl: null,
      heartbeatTimer: null,
      heartbeatInterval: null,
      sseWatchdogTimer: null,
      lastFrameTs: 0,
      sequence: null,
      sessionId: null,
      realtimeCursor: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      allowReconnect: true,
      connected: false,
      connecting: false,
      lastHeartbeatSentAtMs: 0,
      missedAcks: 0,
      connectionLatency: 0,
      pendingMessages: [],
    };
    this.connections.set(LOCAL_SERVER_ID, conn);
    this.connectRealtime(conn);
  }

  private async connectServerInternal(serverId: string): Promise<void> {
    const existing = this.connections.get(serverId);
    if (existing) {
      existing.allowReconnect = true;
      // Do not tear down a healthy SSE/WS on redundant connectAll() calls
      // (e.g. tab focus). Only reconnect when the transport is missing/stale,
      // or when this account's session was replaced under it.
      // Evaluate the credential first: a replaced session must forget its
      // resume point even when the transport was already unhealthy.
      const replaced = this.sessionReplaced(existing);
      if (!this.isConnectionHealthy(existing) || replaced) {
        this.connectRealtime(existing);
      }
      return;
    }

    const server = useServerListStore.getState().getServer(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);

    const account = useAccountStore.getState();
    const canUseChallengeAuth =
      account.isUnlocked &&
      !!account.publicKey &&
      !!account.username &&
      hasUnlockedPrivateKey();

    // Create API client for this server
    const effectiveUrl = server.url;
    let isLocalServerEntry = this.isConfiguredLocalServerUrl(effectiveUrl);
    let localSessionToken = isLocalServerEntry ? useAuthStore.getState().token : null;
    const candidateLocalToken = useAuthStore.getState().token;
    const candidateLocalRefreshToken = getRefreshToken();
    const localSessionRefreshToken = isLocalServerEntry ? candidateLocalRefreshToken : null;
    let serverToken = server.token;
    if (localSessionToken) {
      useServerListStore.getState().updateToken(serverId, localSessionToken);
      serverToken = localSessionToken;
    }
    if (localSessionRefreshToken) {
      useServerListStore.getState().updateRefreshToken(serverId, localSessionRefreshToken);
    }
    const apiBaseUrl = `${effectiveUrl.replace(/\/+$/, '')}/api/v1`;
    const client = createApiClient(
      apiBaseUrl,
      () => {
        const current = useServerListStore.getState().getServer(serverId);
        if (isLocalServerEntry) {
          return useAuthStore.getState().token || current?.token || null;
        }
        return current?.token || null;
      },
      (token, refreshToken) => {
        useServerListStore.getState().updateToken(serverId, token);
        if (refreshToken) {
          useServerListStore.getState().updateRefreshToken(serverId, refreshToken);
        }
        if (isLocalServerEntry) {
          setAccessToken(token);
          useAuthStore.setState({ token });
          if (refreshToken) setRefreshToken(refreshToken);
        }
        const current = this.connections.get(serverId);
        if (current && current.sessionToken !== undefined) current.sessionToken = token;
      },
      () => {
        // Auth failed; clear token and disconnect.
        useServerListStore.getState().updateToken(serverId, '');
        useServerListStore.getState().updateRefreshToken(serverId, null);
        useServerListStore.getState().setApiReachable(serverId, false);
        this.disconnectServer(serverId);
      },
      (reachable) => useServerListStore.getState().setApiReachable(serverId, reachable),
      () => {
        const current = useServerListStore.getState().getServer(serverId);
        if (isLocalServerEntry) {
          return current?.refreshToken || getRefreshToken();
        }
        return current?.refreshToken || null;
      },
    );

    // If we don't have a valid token, do challenge-response auth.
    // Do not require local key unlock when a token already exists.
    // The home session's access/refresh tokens must never be probed against a
    // remote/federated host — only a loopback (same-machine) address may receive them.
    if (!serverToken && !localSessionToken && candidateLocalToken && this.isLoopbackServerUrl(effectiveUrl)) {
      const verifiedToken = await this.verifyLocalSessionForServer(
        serverId,
        apiBaseUrl,
        candidateLocalToken,
        candidateLocalRefreshToken,
      );
      if (verifiedToken) {
        isLocalServerEntry = true;
        localSessionToken = verifiedToken;
        serverToken = verifiedToken;
      }
    }

    if (!serverToken && !localSessionToken) {
      const refreshedToken = await this.refreshServerSession(
        serverId,
        client,
        useServerListStore.getState().getServer(serverId)?.refreshToken ?? null,
        // Promote to the global/home session only for the configured local server.
        // A different loopback server (e.g. a second self-hosted instance on another
        // port) is a distinct session and must not overwrite the home auth token.
        isLocalServerEntry,
      );
      if (refreshedToken) {
        if (isLocalServerEntry) {
          localSessionToken = refreshedToken;
        }
        serverToken = refreshedToken;
      }
    }

    if (!serverToken && !localSessionToken) {
      if (!canUseChallengeAuth) {
        throw new Error('No server token and local account is not unlocked');
      }
      const token = await this.authenticate(client, server, account.publicKey!, account.username!);
      useServerListStore.getState().updateToken(serverId, token);
      serverToken = token;
    }

    // Always verify the current account and fetch its full private profile.
    // READY contains only public fields and must never inherit another account's
    // flags, email or encryption identity from the home server.
    const { data: authenticatedUser } = await responseContract(
      client.get('/users/@me', { timeout: 10_000 }),
      isCurrentUser,
      'CurrentUser',
    );
    useServerListStore.getState().setAuthenticatedUser(serverId, authenticatedUser);

    const conn: ServerConnection = {
      serverId,
      serverUrl: effectiveUrl,
      apiClient: client,
      ws: null,
      eventSource: null,
      streamUrl: null,
      heartbeatTimer: null,
      heartbeatInterval: null,
      sseWatchdogTimer: null,
      lastFrameTs: 0,
      sequence: null,
      sessionId: null,
      realtimeCursor: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      allowReconnect: true,
      connected: false,
      connecting: false,
      lastHeartbeatSentAtMs: 0,
      missedAcks: 0,
      connectionLatency: 0,
      pendingMessages: [],
    };
    this.connections.set(serverId, conn);

    // Connect WebSocket gateway
    this.connectRealtime(conn);
  }

  /** Perform Ed25519 challenge-response authentication */
  private async authenticate(
    client: AxiosInstance,
    server: ServerEntry,
    publicKey: string,
    username: string,
  ): Promise<string> {
    // Step 1: Get challenge
    const { data: challenge } = await client.post<{
      nonce: string;
      timestamp: number;
      server_origin: string;
    }>('/auth/challenge');

    const nowMs = Date.now();
    const challengeMs = challenge.timestamp * 1000;
    if (!Number.isFinite(challengeMs) || Math.abs(nowMs - challengeMs) > 120_000) {
      throw new Error('Server challenge timestamp is invalid or stale');
    }
    try {
      const expectedOrigin = new URL(server.url).origin;
      if (new URL(challenge.server_origin).origin !== expectedOrigin) {
        throw new Error('Server challenge origin mismatch');
      }
    } catch {
      throw new Error('Server challenge origin mismatch');
    }

    // Step 2: Sign the challenge
    const signature = await signServerChallengeWithUnlockedKey(
      challenge.nonce,
      challenge.timestamp,
      challenge.server_origin,
    );

    // Step 3: Verify (this also auto-registers if needed)
    const displayName = useAccountStore.getState().displayName;
    const { data: authResponse } = await client.post<{
      token: string;
      refresh_token?: string;
      user: { id: string; username: string; flags: number; public_key: string };
    }>('/auth/verify', {
      public_key: publicKey,
      nonce: challenge.nonce,
      timestamp: challenge.timestamp,
      signature,
      username,
      display_name: displayName || undefined,
    });

    // Store the user's server-local ID. The remote identity lives on the
    // per-server entry (consumed via `activeServer?.userId`); the global
    // authStore stays LOCAL-only so a remote connection never clobbers the
    // local session token/user or the LOCAL-only `apiClient` singleton.
    useServerListStore.getState().updateServerInfo(server.id, {
      userId: authResponse.user.id,
    });

    // Persist the per-server refresh token so a later 401 can refresh
    // cross-origin (the HttpOnly cookie is unavailable to remote origins).
    if (authResponse.refresh_token) {
      useServerListStore.getState().updateRefreshToken(server.id, authResponse.refresh_token);
    }

    return authResponse.token;
  }

  private tokenForConnection(conn: ServerConnection): string | null {
    if (conn.serverId === LOCAL_SERVER_ID) {
      return useAuthStore.getState().token;
    }
    return useServerListStore.getState().getServer(conn.serverId)?.token || null;
  }

  private connectRealtime(conn: ServerConnection): void {
    conn.sessionToken = this.tokenForConnection(conn);
    if (this.useRealtimeV2) {
      if (conn.ws) {
        conn.ws.close();
        conn.ws = null;
      }
      // Close stale EventSource before opening a new one to avoid
      // overlapping SSE connections (which can cause ERR_CONNECTION_RESET).
      if (conn.eventSource) {
        this.clearSseWatchdog(conn);
        conn.eventSource.close();
        conn.eventSource = null;
      }
      this.connectRealtimeSse(conn);
      return;
    }
    if (conn.eventSource) {
      conn.eventSource.close();
      conn.eventSource = null;
    }
    this.connectGateway(conn);
  }

  private connectRealtimeSse(conn: ServerConnection): void {
    if (!this.isCurrentConnection(conn)) {
      logVoiceDiagnostic('[gateway] SSE skipped: not current connection', { server: conn.serverId });
      return;
    }
    if (conn.connecting || conn.eventSource) {
      logVoiceDiagnostic('[gateway] SSE skipped: already connecting or has eventSource', { connecting: conn.connecting, hasES: !!conn.eventSource, server: conn.serverId });
      return;
    }
    const token = this.tokenForConnection(conn);
    if (!token) {
      logVoiceDiagnostic('[gateway] SSE skipped: no token for server', { server: conn.serverId });
      return;
    }
    // Prevent duplicate SSE connections to the same server URL.
    // When the local server is also in the server list, two ServerConnection
    // objects point to the same URL.  Opening two EventSources with the same
    // session causes an infinite reconnect loop because the server evicts the
    // older stream when the newer one opens.
    const normalizedUrl = conn.serverUrl.replace(/\/+$/, '');
    for (const other of this.connections.values()) {
      if (
        other !== conn &&
        other.serverUrl.replace(/\/+$/, '') === normalizedUrl &&
        (other.eventSource || other.connecting)
      ) {
        logVoiceDiagnostic('[gateway] SSE skipped: another connection already has SSE to same URL', {
          server: conn.serverId,
          otherServer: other.serverId,
          url: normalizedUrl,
        });
        // Mark this connection as connected since the other one covers it
        conn.connected = true;
        conn.connecting = false;
        this.syncUiConnectionStatus();
        return;
      }
    }

    if (this.waitForVerifiedAccount(conn, () => this.connectRealtimeSse(conn))) return;

    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.eventSource) {
      return;
    }
    conn.connecting = true;
    conn.allowReconnect = true;
    const lane = this.beginTransport(conn);
    this.syncUiConnectionStatus();
    void (async () => {
      try {
        logVoiceDiagnostic('[gateway] SSE session POST starting', { server: conn.serverId, url: conn.serverUrl });
        const sessionResp = await conn.apiClient.post<{
          session_id?: string;
          cursor?: number;
        }>(`${conn.serverUrl.replace(/\/+$/, '')}/api/v2/rt/session`, undefined, {
          timeout: 10_000,
        });
        if (!this.ownsTransport(conn, lane)) return this.abandonTransport(conn, lane, 'session');
        logVoiceDiagnostic('[gateway] SSE session POST ok', { session_id: sessionResp.data?.session_id });
        // Bootstrap values select a stream; only its authenticated READY may
        // acknowledge them. A failed setup must retain the completed resume point.
        const sessionId = sessionResp.data?.session_id ?? conn.sessionId;
        const cursor = conn.realtimeCursor ?? sessionResp.data?.cursor;

        const base = conn.serverUrl.replace(/\/+$/, '');

        // Exchange the access token for a short-lived single-use stream ticket so
        // the raw token never appears in the SSE query string. The axios client's
        // auth interceptor supplies the Bearer header on this POST. A fresh ticket
        // is fetched on every (re)connect since tickets are consumed on use.
        const ticketResp = await conn.apiClient.post<{ ticket?: string }>(
          `${base}/api/v1/stream/ticket`,
          undefined,
          { timeout: 10_000 },
        );
        if (!this.ownsTransport(conn, lane)) return this.abandonTransport(conn, lane, 'ticket');
        const ticket = ticketResp.data?.ticket;
        if (!ticket) throw new Error('stream ticket missing');

        const params = new URLSearchParams();
        params.set('ticket', ticket);
        if (sessionId) params.set('session_id', sessionId);
        if (cursor != null) params.set('cursor', String(cursor));
        const streamUrl = `${base}/api/v2/rt/events?${params.toString()}`;
        conn.streamUrl = streamUrl;

        // Redact the single-use ticket from logs.
        const logUrl = streamUrl.replace(/ticket=[^&]+/, 'ticket=***');
        logVoiceDiagnostic('[gateway] SSE EventSource opening', { url: logUrl });

        const es = await openRealtimeEventSource(streamUrl);
        // `openRealtimeEventSource` awaits, so the connection may have been
        // superseded or torn down while it was in flight. Assigning
        // `conn.eventSource` unconditionally re-armed a dead connection with a
        // live stream that nothing would ever close.
        if (!this.ownsTransport(conn, lane)) {
          es.close();
          return this.abandonTransport(conn, lane, 'stream');
        }
        conn.eventSource = es;

        es.onopen = () => {
          if (!this.ownsTransport(conn, lane) || conn.eventSource !== es) {
            logVoiceDiagnostic('[gateway] SSE onopen but stale connection, closing');
            es.close();
            return;
          }
          logVoiceDiagnostic('[gateway] SSE connected', { server: conn.serverId });
          conn.connecting = false;
          conn.connected = true;
          conn.missedAcks = 0;
          if (conn.serverId !== LOCAL_SERVER_ID) {
            useServerListStore.getState().setConnected(conn.serverId, true);
          }
          // EventSource has no built-in heartbeat, so run a liveness watchdog
          // that reconnects if the stream goes silent (mirrors the WS path).
          this.startSseWatchdog(conn, es);
          this.syncUiConnectionStatus();
        };

        const handleRealtimeEvent = (rawData: string) => {
          if (!this.ownsTransport(conn, lane) || conn.eventSource !== es) return;
          // Any frame (even one we can't parse) proves the stream is alive, so
          // reset the watchdog before attempting to decode it.
          conn.lastFrameTs = Date.now();
          conn.missedAcks = 0;
          let payload: DispatchPayload;
          try { payload = JSON.parse(rawData); }
          catch { warnMalformedFrame('sse', rawData); return; }
          this.handlePayload(conn, payload, lane);
        };
        es.onmessage = (evt) => {
          handleRealtimeEvent(evt.data);
        };
        es.addEventListener('gateway', (evt) => {
          const msg = evt as MessageEvent<string>;
          handleRealtimeEvent(msg.data);
        });

        es.onerror = (errEvt) => {
          if (!this.ownsTransport(conn, lane) || conn.eventSource !== es) {
            logVoiceDiagnostic('[gateway] SSE error on a superseded stream', { server: conn.serverId });
            return;
          }
          logVoiceDiagnostic('[gateway] SSE error', {
            server: conn.serverId,
            readyState: es.readyState,
            wasConnected: conn.connected,
            type: (errEvt as Event)?.type,
          });
          conn.connecting = false;
          conn.connected = false;
          conn.eventSource = null;
          es.close();
          if (conn.serverId !== LOCAL_SERVER_ID) {
            useServerListStore.getState().setConnected(conn.serverId, false);
          }
          this.cleanupConnection(conn);
          if (conn.allowReconnect) {
            this.reconnectGateway(conn);
          } else {
            this.syncUiConnectionStatus();
          }
        };
        if (es instanceof NativeSseConnection) {
          await es.start();
          if (!this.ownsTransport(conn, lane) || conn.eventSource !== es) es.close();
        }
      } catch (err) {
        if (!this.ownsTransport(conn, lane)) return;
        logVoiceDiagnostic('[gateway] SSE setup failed', { server: conn.serverId, error: err instanceof Error ? err.name : 'unknown' });
        const events = conn.eventSource;
        conn.eventSource = null;
        this.cleanupConnection(conn);
        events?.close();
        conn.connecting = false;
        conn.connected = false;
        if (conn.allowReconnect) {
          this.reconnectGateway(conn);
        } else {
          this.syncUiConnectionStatus();
        }
      }
    })();
  }

  /** Connect WebSocket gateway for a server */
  private connectGateway(conn: ServerConnection): void {
    if (!this.isCurrentConnection(conn)) return;
    const token = this.tokenForConnection(conn);
    if (!token) return;
    if (this.waitForVerifiedAccount(conn, () => this.connectGateway(conn))) return;

    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (
      conn.ws &&
      (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const wsBase = conn.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/gateway?compress=zlib-stream`;

    conn.connecting = true;
    const lane = this.beginTransport(conn);
    conn.ws = new WebSocket(wsUrl);
    conn.ws.binaryType = 'arraybuffer';
    this.syncUiConnectionStatus();
    conn.allowReconnect = true;
    const activeWs = conn.ws;

    activeWs.onopen = () => {
      if (!this.ownsTransport(conn, lane) || conn.ws !== activeWs) {
        activeWs.close();
        return;
      }
      conn.connecting = false;
      conn.connected = true;
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      if (conn.serverId !== LOCAL_SERVER_ID) {
        useServerListStore.getState().setConnected(conn.serverId, true);
      }
      this.syncUiConnectionStatus();
    };

    activeWs.onmessage = (event) => {
      if (!this.ownsTransport(conn, lane) || conn.ws !== activeWs) return;
      let text: string | null = null;
      let payload: DispatchPayload;
      try {
        if (event.data instanceof ArrayBuffer) {
          // Compressed binary frame — strip Z_SYNC_FLUSH suffix and inflate
          const raw = new Uint8Array(event.data);
          // Strip trailing 0x00 0x00 0xFF 0xFF (Z_SYNC_FLUSH marker)
          const end = raw.length >= 4
            && raw[raw.length - 4] === 0x00
            && raw[raw.length - 3] === 0x00
            && raw[raw.length - 2] === 0xFF
            && raw[raw.length - 1] === 0xFF
            ? raw.length - 4
            : raw.length;
          const decompressed = inflateSync(raw.subarray(0, end));
          text = new TextDecoder().decode(decompressed);
        } else {
          // Uncompressed text frame (fallback)
          text = event.data as string;
        }
        payload = JSON.parse(text);
      } catch {
        warnMalformedFrame('ws', text ?? '<binary frame>');
        return;
      }
      this.handlePayload(conn, payload, lane);
    };

    activeWs.onclose = () => {
      if (!this.ownsTransport(conn, lane) || conn.ws !== activeWs) return;
      conn.ws = null;
      conn.connecting = false;
      conn.connected = false;
      if (conn.serverId !== LOCAL_SERVER_ID) {
        useServerListStore.getState().setConnected(conn.serverId, false);
      }
      this.cleanupConnection(conn);
      if (conn.allowReconnect) {
        this.reconnectGateway(conn);
      } else {
        this.syncUiConnectionStatus();
      }
    };

    activeWs.onerror = () => {
      if (!this.ownsTransport(conn, lane) || conn.ws !== activeWs) return;
      conn.connecting = false;
      activeWs.close();
    };
  }

  private handlePayload(conn: ServerConnection, payload: DispatchPayload, lane = this.dispatchLanes.get(conn) ?? this.beginTransport(conn)): void {
    if (!this.ownsTransport(conn, lane)) return;
    if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.op)) {
      this.failDispatch(conn, lane, 'invalid gateway frame');
      return;
    }

    switch (payload.op) {
      case 10: { // HELLO
        conn.heartbeatInterval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(conn);
        this.identify(conn);
        break;
      }
      case 11: // HEARTBEAT_ACK
        if (conn.lastHeartbeatSentAtMs > 0) {
          conn.connectionLatency = Math.max(
            0,
            Math.round(monotonicNowMs() - conn.lastHeartbeatSentAtMs),
          );
          conn.lastHeartbeatSentAtMs = 0;
          useUIStore.getState().setConnectionLatency(conn.connectionLatency);
        }
        conn.missedAcks = 0;
        break;
      case 0: // DISPATCH
        this.enqueueDispatch(conn, lane, payload);
        break;
      case 7: // RECONNECT
      case 9: { // INVALID_SESSION
        if (payload.op === 9) conn.sessionId = null;
        const ws = conn.ws; const es = conn.eventSource;
        conn.ws = null; conn.eventSource = null;
        // Controls bypass the queue, but cannot leave its pending promise
        // authorized to acknowledge the closing transport.
        this.cleanupConnection(conn);
        conn.connected = false; conn.connecting = false;
        ws?.close(); es?.close();
        this.reconnectGateway(conn);
        break;
      }
    }
  }

  private identify(conn: ServerConnection): void {
    const token = this.tokenForConnection(conn);
    if (!token) return;

    if (conn.sessionId) {
      this.send(conn, {
        op: 6,
        d: { token, session_id: conn.sessionId, seq: conn.sequence },
      });
    } else {
      this.send(conn, {
        op: 2,
        d: { token },
      });
    }
  }

  private startHeartbeat(conn: ServerConnection): void {
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = setInterval(() => {
      if (conn.missedAcks >= ConnectionManager.MAX_MISSED_ACKS) {
        conn.ws?.close();
        return;
      }
      conn.lastHeartbeatSentAtMs = monotonicNowMs();
      conn.missedAcks++;
      this.send(conn, { op: 1, d: conn.sequence });
    }, conn.heartbeatInterval!);
  }

  /**
   * SSE liveness watchdog. EventSource silently keeps a dead TCP connection
   * "open", so — mirroring the WS heartbeat/missed-ack path — each tick with no
   * intervening frame counts as a miss; once too many pile up the stream is
   * declared stale, its latency recorded, and a reconnect is triggered.
   */
  private startSseWatchdog(conn: ServerConnection, es: RealtimeEventSource): void {
    this.clearSseWatchdog(conn);
    const openedAt = Date.now();
    conn.lastFrameTs = openedAt;
    conn.missedAcks = 0;
    conn.sseWatchdogTimer = setInterval(() => {
      if (!this.isCurrentConnection(conn) || conn.eventSource !== es) {
        this.clearSseWatchdog(conn);
        return;
      }
      const silentFor = Date.now() - conn.lastFrameTs;
      if (silentFor < ConnectionManager.SSE_SILENCE_LIMIT_MS) {
        // The stream is provably alive. A connection that has carried traffic
        // this long is not the one the backoff was counting against, so stop
        // charging it for earlier failures — otherwise an account quiet enough
        // never to deliver a durable event stays at the 30 s backoff cap for
        // the rest of the session.
        if (Date.now() - openedAt >= ConnectionManager.SSE_SETTLED_MS
          && !this.durableFailures.has(conn)) {
          conn.reconnectAttempts = 0;
        }
        return;
      }

      // Stream is stale. Reconnect it, but do not publish "time since last
      // frame" as latency; that can be tens of seconds and is not an RTT.
      this.clearSseWatchdog(conn);
      conn.connected = false;
      conn.connecting = false;
      conn.eventSource = null;
      es.close();
      if (conn.serverId !== LOCAL_SERVER_ID) {
        useServerListStore.getState().setConnected(conn.serverId, false);
      }
      this.cleanupConnection(conn);
      if (conn.allowReconnect) {
        this.reconnectGateway(conn);
      } else {
        this.syncUiConnectionStatus();
      }
    }, ConnectionManager.SSE_WATCHDOG_INTERVAL_MS);
  }

  private clearSseWatchdog(conn: ServerConnection): void {
    if (conn.sseWatchdogTimer) {
      clearInterval(conn.sseWatchdogTimer);
      conn.sseWatchdogTimer = null;
    }
  }

  private handleDispatch(conn: ServerConnection, event: string, data: unknown, lane?: DispatchLane): DispatchResult {
    if (!this.isCurrentConnection(conn) || !conn.allowReconnect) return false;
    const scope = getServerAccountScope(conn.serverId);
    if (!scope || (conn.accountId && conn.accountId !== scope.userId)) return false;
    if (event === GatewayEvents.READY || event === GatewayEvents.RESUMED) {
      const lifecycle = data as { session_id?: string; database_history_epoch?: unknown; user?: { id?: string } };
      if (event === GatewayEvents.READY && lifecycle.user?.id !== scope.userId) return false;
      if (lifecycle.database_history_epoch !== undefined) {
        let changed: boolean;
        try { changed = acceptDatabaseHistoryEpoch(scope, lifecycle.database_history_epoch); }
        catch (error) {
          this.rejectHistory(conn, error);
          return false;
        }
        conn.accountId = scope.userId;
        conn.historyEpoch = lifecycle.database_history_epoch as string;
        if (changed) {
          conn.pendingMessages = [];
          conn.sessionId = null; conn.sequence = null; conn.realtimeCursor = null;
          // RESUMED has no authoritative guild/channel projection. Re-identify
          // after cancelling the old history before allowing replayed events.
          if (event === GatewayEvents.RESUMED) { this.reconcileHistory(conn); return false; }
        }
      } else {
        try {
          if (getDatabaseHistoryEpoch(scope)) {
            this.disconnectServer(conn.serverId);
            toast.error('This server did not confirm its database history. Reconnect after updating the server.');
            return false;
          }
        } catch (error) { this.rejectHistory(conn, error); return false; }
      }
    } else {
      try {
        if (getDatabaseHistoryEpoch(scope) !== (conn.historyEpoch ?? null)) return false;
      } catch (error) { this.rejectHistory(conn, error); return false; }
    }
    const historyEpoch = conn.historyEpoch;
    const complete = (): void | false => {
      if (!this.isCurrentConnection(conn) || !conn.allowReconnect
        || getServerAccountScope(conn.serverId)?.userId !== scope.userId
        || conn.historyEpoch !== historyEpoch
        || (lane && !this.ownsTransport(conn, lane))) return false;
      if (getDatabaseHistoryEpoch(scope) !== (historyEpoch ?? null)) return false;
      if (event === GatewayEvents.READY || event === GatewayEvents.RESUMED) {
        const lifecycle = data as { session_id?: string };
        if (event === GatewayEvents.READY) conn.sessionId = lifecycle.session_id ?? null;
        else if (lifecycle.session_id) conn.sessionId = lifecycle.session_id;
        if (!this.durableFailures.has(conn)) conn.reconnectAttempts = 0;
        this.flushPendingMessages(conn);
        this.syncUiConnectionStatus();
      }
    };
    const result = dispatchGatewayEvent(conn.serverId, event, (data ?? {}) as Record<string, unknown>);
    return result && typeof result.then === 'function' ? result.then(complete) : complete();
  }

  private rejectHistory(conn: ServerConnection, error: unknown): void {
    this.disconnectServer(conn.serverId);
    toast.error(`Cannot reconcile this server's history. ${error instanceof Error ? error.message : 'Reconnect to try again.'}`);
  }

  /** Drop the old transport and its queued commands before a fresh handshake. */
  private reconcileHistory(conn: ServerConnection): void {
    if (!this.isCurrentConnection(conn) || !conn.allowReconnect) return;
    // The other path that drops a live stream, and the one that did it on the
    // desktop: any response whose history-epoch header does not match the one
    // the operation captured asks for a reconciliation. It is the right answer
    // when the account's history really did change, and it was silent, so a
    // client dropping its stream on every single request looked from its own
    // diagnostics like a stream that kept dying of nothing.
    logVoiceDiagnostic('[gateway] history reconciliation, reconnecting', {
      server: conn.serverId,
      attempt: conn.reconnectAttempts,
    });
    const ws = conn.ws;
    const events = conn.eventSource;
    conn.ws = null; conn.eventSource = null;
    conn.sessionId = null; conn.sequence = null; conn.realtimeCursor = null;
    conn.historyEpoch = undefined; conn.pendingMessages = [];
    conn.connected = false; conn.connecting = false;
    this.cleanupConnection(conn);
    ws?.close(); events?.close();
    this.reconnectGateway(conn);
  }

  private send(conn: ServerConnection, data: unknown): void {
    if (conn.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(data));
    } else if (
      conn.allowReconnect &&
      conn.pendingMessages.length < ConnectionManager.MAX_PENDING_MESSAGES
    ) {
      conn.pendingMessages.push(data);
    } else if (conn.allowReconnect) {
      console.warn('[gateway] outbound queue full, dropping message');
    }
  }

  private flushPendingMessages(conn: ServerConnection): void {
    const messages = conn.pendingMessages.splice(0);
    for (const msg of messages) {
      this.send(conn, msg);
    }
  }

  private async postRealtimeCommand(
    conn: ServerConnection,
    commandType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const url = `${conn.serverUrl.replace(/\/+$/, '')}/api/v2/rt/commands`;
    const commandId = `${commandType}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await conn.apiClient.post(
      url,
      {
        command_id: commandId,
        type: commandType,
        payload,
      },
      { timeout: 10_000 },
    );
  }

  /** Send a presence update on a specific server */
  updatePresence(
    serverId: string,
    status: string,
    activities: Activity[] = [],
    customStatus: string | null = null,
  ): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    if (this.useRealtimeV2) {
      void this.postRealtimeCommand(conn, 'presence_update', {
        status,
        activities,
        custom_status: customStatus,
      }).catch(() => { });
      return;
    }
    this.send(conn, {
      op: 3,
      d: {
        status,
        afk: false,
        activities,
        custom_status: customStatus,
      },
    });
  }

  /** Send a voice state update on a specific server */
  updateVoiceState(
    serverId: string,
    guildId: string | null,
    channelId: string | null,
    selfMute: boolean,
    selfDeaf: boolean,
    selfVideo: boolean = false,
    sessionId?: string | null,
  ): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    // Older clients omit the receipt; the call owner always supplies its join receipt.
    const receipt = sessionId ? { session_id: sessionId } : {};
    if (this.useRealtimeV2) {
      void this.postRealtimeCommand(conn, 'voice_state_update', {
        ...receipt,
        guild_id: guildId,
        channel_id: channelId,
        self_mute: selfMute,
        self_deaf: selfDeaf,
        self_video: selfVideo,
      }).catch(() => { });
      return;
    }
    this.send(conn, {
      op: 4,
      d: { ...receipt, guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf, self_video: selfVideo },
    });
  }

  updatePresenceAll(
    status: string,
    activities: Activity[] = [],
    customStatus: string | null = null,
  ): void {
    for (const conn of this.getAllConnections()) {
      this.updatePresence(conn.serverId, status, activities, customStatus);
    }
  }

  updateVoiceStateAll(
    guildId: string | null,
    channelId: string | null,
    selfMute: boolean,
    selfDeaf: boolean,
    selfVideo: boolean = false,
  ): void {
    for (const conn of this.getAllConnections()) {
      this.updateVoiceState(conn.serverId, guildId, channelId, selfMute, selfDeaf, selfVideo);
    }
  }

  private reconnectGateway(conn: ServerConnection): void {
    if (!conn.allowReconnect || conn.reconnectTimer) return;
    if (!this.isCurrentConnection(conn)) return;
    if (this.offline) {
      this.syncUiConnectionStatus();
      return;
    }
    // First retry is immediate (0ms) so intermittent TLS/SSE resets
    // are invisible to the user.  Subsequent retries use exponential
    // backoff starting at 1s up to 30s.
    const attempt = conn.reconnectAttempts;
    conn.reconnectAttempts++;
    if (attempt === 0) {
      // Immediate retry — use setTimeout(0) so the call stack unwinds
      // but there is essentially no delay.
      conn.reconnectTimer = setTimeout(() => {
        conn.reconnectTimer = null;
        if (!conn.allowReconnect) return;
        if (!this.isCurrentConnection(conn)) return;
        this.connectRealtime(conn);
      }, 0);
    } else {
      const delay = Math.min(1000 * Math.pow(2, Math.min(attempt - 1, 5)), 30000);
      conn.reconnectTimer = setTimeout(() => {
        conn.reconnectTimer = null;
        if (!conn.allowReconnect) return;
        if (!this.isCurrentConnection(conn)) return;
        this.connectRealtime(conn);
      }, delay);
    }
    this.syncUiConnectionStatus();
  }

  private cleanupConnection(conn: ServerConnection): void {
    this.pauseMessagingRecovery(conn);
    this.accountHydrationWaits.get(conn)?.();
    this.invalidateDispatchLane(conn);
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
    conn.lastHeartbeatSentAtMs = 0;
    this.clearSseWatchdog(conn);
  }

  /** Disconnect a specific server */
  disconnectServer(serverId: string): void {
    notifyServerDisconnected(serverId);
    const conn = this.connections.get(serverId);
    if (!conn) return;
    conn.allowReconnect = false;
    conn.pendingMessages = [];
    conn.connecting = false;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.cleanupConnection(conn);
    conn.ws?.close();
    conn.eventSource?.close();
    conn.eventSource = null;
    conn.ws = null;
    conn.connected = false;
    if (serverId !== LOCAL_SERVER_ID) {
      useServerListStore.getState().setConnected(serverId, false);
    }
    this.connections.delete(serverId);
    this.syncUiConnectionStatus();
  }

  /** Ask the Tauri backend to verify and sync server URLs for TLS trust decisions. */
  /**
   * Have the desktop shell verify and record every server origin we are about
   * to talk to, and wait for it.
   *
   * This used to gate on `'__TAURI__' in window`, which is only defined when
   * the app is built with `withGlobalTauri` — it is not. So on the real desktop
   * client the gate was always false, this awaited nothing, and `connectAll()`
   * went straight on to connect. The only surviving trust sync was the
   * fire-and-forget one in main.tsx, which races it: the first realtime connect
   * after a cold boot lost that race and died with "Native fetch target is not
   * in the trusted server list", leaving the connection to find its way back
   * through reconnect backoff. Share the one implementation, which detects
   * Tauri properly, and actually wait for it.
   */
  private async syncTrustedHosts(serverUrls: string[]): Promise<void> {
    await syncTrustedHosts(serverUrls);
  }

  /** Connect to all saved servers */
  /**
   * Reconcile every connection with the current server list.
   *
   * Serialized. `useGateway` re-runs whenever a server's token changes, and a
   * first login changes it twice within the same millisecond (the entry is
   * created without a token, then the token lands). Two overlapping runs each
   * found no connection for the server, each created one, and the second
   * replaced the first in the map — two realtime sessions and two streams for
   * one server, one of them orphaned with nothing left to close it. One run at
   * a time, with at most one queued re-run, keeps the one-session invariant
   * where it belongs: at the layer that owns the connection map.
   */
  async connectAll(): Promise<void> {
    if (this.connectAllInFlight) {
      this.connectAllQueued = true;
      await this.connectAllInFlight.catch(() => {});
      return;
    }
    const run = this.connectAllOnce().finally(() => {
      this.connectAllInFlight = null;
    });
    this.connectAllInFlight = run;
    try {
      await run;
    } finally {
      if (this.connectAllQueued) {
        this.connectAllQueued = false;
        await this.connectAll();
      }
    }
  }

  private async connectAllOnce(): Promise<void> {
    if (this.offline) {
      logVoiceDiagnostic('[gateway] connectAll: offline, skipping');
      this.syncUiConnectionStatus();
      return;
    }
    const serverState = useServerListStore.getState();
    if (!serverState.hydrated || !serverState.tokensHydrated) {
      logVoiceDiagnostic('[gateway] connectAll: server store not hydrated, skipping', {
        hydrated: serverState.hydrated,
        tokensHydrated: serverState.tokensHydrated,
      });
      return;
    }
    const servers = serverState.servers;
    const localToken = useAuthStore.getState().token;
    logVoiceDiagnostic('[gateway] connectAll', { serverCount: servers.length, useRealtimeV2: this.useRealtimeV2, hasAuthToken: !!localToken, serverIds: servers.map(s => s.id) });

    // Ask the desktop shell to verify and record every origin we are about to
    // talk to, so a self-hosted server's certificate is accepted.
    //
    // Only origins that actually exist. `resolveLocalServerUrl()` ends in a
    // hardcoded `http://localhost:8080` when nothing is configured, which in
    // the desktop client is always: it has no stored URL and its own origin is
    // `tauri://`. Handing that to the shell asks the user to trust a server
    // they never added and that is not running — a modal "Trust new Paracord
    // server?" prompt at every cold boot, and sixty seconds of a client that
    // cannot connect while it waits for an answer nobody knows to give.
    const allServerUrls = servers.map((s) => s.url);
    const localServerUrl = this.configuredLocalServerUrl();
    if (localServerUrl && !allServerUrls.includes(localServerUrl)) {
      allServerUrls.push(localServerUrl);
    }
    await this.syncTrustedHosts(allServerUrls);
    const keepIds = new Set<string>();

    // Determine the local server URL so we can detect when a server entry
    // in the list points to the same host, avoiding duplicate SSE connections
    // that fight each other for the same session.
    const localUrl = this.resolveLocalServerUrl().replace(/\/+$/, '');

    if (servers.length > 0) {
      const results = await Promise.allSettled(servers.map((s) => this.connectServer(s.id)));
      results.forEach((r, i) => {
        if (r.status === 'rejected') logVoiceDiagnostic('[gateway] connectServer FAILED', { serverId: servers[i]?.id, reason: String(r.reason) });
      });
      for (const server of servers) {
        keepIds.add(server.id);
      }
    }

    // Only connect the __local__ server if no server entry already covers
    // the same URL.  When the user adds the local server to their server
    // list, that entry already establishes the SSE connection — opening a
    // second one causes an infinite reconnect loop.
    const refreshedLocalToken = useAuthStore.getState().token;
    const localAlreadyCovered = servers.some((s) => {
      const latest = useServerListStore.getState().getServer(s.id);
      return (
        this.sameServerUrl(s.url, localUrl) ||
        (!!refreshedLocalToken && latest?.token === refreshedLocalToken)
      );
    });
    if (localToken && !localAlreadyCovered) {
      keepIds.add(LOCAL_SERVER_ID);
      await this.connectLocal();
    }

    for (const serverId of Array.from(this.connections.keys())) {
      if (!keepIds.has(serverId)) {
        this.disconnectServer(serverId);
      }
    }
  }

  /** Reconcile current runtime connections with the latest server list state. */
  async syncServers(): Promise<void> {
    await this.connectAll();
  }

  /** Disconnect from all servers */
  disconnectAll(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.recoveryAttempts = 0;
    for (const serverId of Array.from(this.connections.keys())) {
      this.disconnectServer(serverId);
    }
  }

  /** Get all active connections */
  getAllConnections(): ServerConnection[] {
    return Array.from(this.connections.values());
  }
}

export const connectionManager = new ConnectionManager();
