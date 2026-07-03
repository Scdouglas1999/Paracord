import { type AxiosInstance } from 'axios';
import { createApiClient } from '../api/client';
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
import { inflateSync } from 'fflate';
import type { Activity, GatewayPayload } from '../types';
import { GatewayEvents } from '../gateway/events';
import { dispatchGatewayEvent } from '../gateway/dispatch';
import { logVoiceDiagnostic } from './desktopDiagnostics';

export const LOCAL_SERVER_ID = '__local__';

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

export interface ServerConnection {
  serverId: string;
  serverUrl: string;
  apiClient: AxiosInstance;
  ws: WebSocket | null;
  eventSource: EventSource | null;
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
  lastHeartbeatSent: number;
  missedAcks: number;
  connectionLatency: number;
  pendingMessages: unknown[];
}

class ConnectionManager {
  private connections = new Map<string, ServerConnection>();
  private connecting = new Map<string, Promise<void>>();
  private static readonly MAX_PENDING_MESSAGES = 200;
  /** Consecutive missed liveness checks (heartbeat acks / SSE frames) before a
   *  connection is considered stale and torn down. Shared by WS and SSE. */
  private static readonly MAX_MISSED_ACKS = 3;
  /** SSE watchdog tick: mirrors the WS heartbeat cadence. Each tick with no
   *  intervening frame counts as a miss, matching the WS missed-ack logic. */
  private static readonly SSE_WATCHDOG_INTERVAL_MS = 30_000;
  private readonly useRealtimeV2 =
    import.meta.env.VITE_RT_V2 !== '0' && import.meta.env.VITE_RT_V2 !== 'false';
  private offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  /** Timer for automatic recovery when the gateway lands in 'disconnected'. */
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempts = 0;

  constructor() {
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
          void this.connectAll();
        }
      });
    }
  }

  private isCurrentConnection(conn: ServerConnection): boolean {
    return this.connections.get(conn.serverId) === conn;
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
      this.connectRealtime(existing);
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
      lastHeartbeatSent: 0,
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
      this.connectRealtime(existing);
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
    const apiBaseUrl = `${effectiveUrl.replace(/\/+$/, '')}/api/v1`;
    const client = createApiClient(
      apiBaseUrl,
      () => useServerListStore.getState().getServer(serverId)?.token || null,
      (token, refreshToken) => {
        useServerListStore.getState().updateToken(serverId, token);
        if (refreshToken) {
          useServerListStore.getState().updateRefreshToken(serverId, refreshToken);
        }
      },
      () => {
        // Auth failed; clear token and disconnect.
        useServerListStore.getState().updateToken(serverId, '');
        useServerListStore.getState().updateRefreshToken(serverId, null);
        useServerListStore.getState().setApiReachable(serverId, false);
        this.disconnectServer(serverId);
      },
      (reachable) => useServerListStore.getState().setApiReachable(serverId, reachable),
      () => useServerListStore.getState().getServer(serverId)?.refreshToken || null,
    );

    // If we don't have a valid token, do challenge-response auth.
    // Do not require local key unlock when a token already exists.
    if (!server.token) {
      if (!canUseChallengeAuth) {
        throw new Error('No server token and local account is not unlocked');
      }
      const token = await this.authenticate(client, server, account.publicKey!, account.username!);
      useServerListStore.getState().updateToken(serverId, token);
    }

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
      lastHeartbeatSent: 0,
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

    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.eventSource) {
      return;
    }
    conn.connecting = true;
    conn.allowReconnect = true;
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
        if (!this.isCurrentConnection(conn) || !conn.allowReconnect) return;
        logVoiceDiagnostic('[gateway] SSE session POST ok', { session_id: sessionResp.data?.session_id });
        if (sessionResp.data?.session_id) {
          conn.sessionId = sessionResp.data.session_id;
        }
        if (typeof sessionResp.data?.cursor === 'number' && conn.realtimeCursor == null) {
          conn.realtimeCursor = sessionResp.data.cursor;
        }

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
        if (!this.isCurrentConnection(conn) || !conn.allowReconnect) return;
        const ticket = ticketResp.data?.ticket;
        if (!ticket) throw new Error('stream ticket missing');

        const params = new URLSearchParams();
        params.set('ticket', ticket);
        if (conn.sessionId) params.set('session_id', conn.sessionId);
        if (conn.realtimeCursor != null) params.set('cursor', String(conn.realtimeCursor));
        const streamUrl = `${base}/api/v2/rt/events?${params.toString()}`;
        conn.streamUrl = streamUrl;

        // Redact the single-use ticket from logs.
        const logUrl = streamUrl.replace(/ticket=[^&]+/, 'ticket=***');
        logVoiceDiagnostic('[gateway] SSE EventSource opening', { url: logUrl });

        const es = new EventSource(streamUrl, { withCredentials: true });
        conn.eventSource = es;

        es.onopen = () => {
          if (!this.isCurrentConnection(conn) || conn.eventSource !== es) {
            logVoiceDiagnostic('[gateway] SSE onopen but stale connection, closing');
            es.close();
            return;
          }
          logVoiceDiagnostic('[gateway] SSE connected', { server: conn.serverId });
          conn.connecting = false;
          conn.connected = true;
          conn.reconnectAttempts = 0;
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
          if (!this.isCurrentConnection(conn) || conn.eventSource !== es) return;
          // Any frame (even one we can't parse) proves the stream is alive, so
          // reset the watchdog before attempting to decode it.
          conn.lastFrameTs = Date.now();
          conn.missedAcks = 0;
          try {
            const payload: GatewayPayload & { event_id?: number } = JSON.parse(rawData);
            if (typeof payload.event_id === 'number') {
              conn.realtimeCursor = payload.event_id;
            }
            this.handlePayload(conn, payload);
          } catch {
            warnMalformedFrame('sse', rawData);
          }
        };
        es.onmessage = (evt) => {
          handleRealtimeEvent(evt.data);
        };
        es.addEventListener('gateway', (evt) => {
          const msg = evt as MessageEvent<string>;
          handleRealtimeEvent(msg.data);
        });

        es.onerror = (errEvt) => {
          if (!this.isCurrentConnection(conn) || conn.eventSource !== es) return;
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
      } catch (err) {
        logVoiceDiagnostic('[gateway] SSE setup failed', { server: conn.serverId, error: err });
        if (!this.isCurrentConnection(conn)) return;
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
    conn.ws = new WebSocket(wsUrl);
    conn.ws.binaryType = 'arraybuffer';
    this.syncUiConnectionStatus();
    conn.allowReconnect = true;
    const activeWs = conn.ws;

    activeWs.onopen = () => {
      if (!this.isCurrentConnection(conn) || conn.ws !== activeWs) {
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
      if (!this.isCurrentConnection(conn) || conn.ws !== activeWs) return;
      let text: string | null = null;
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
        const payload: GatewayPayload = JSON.parse(text);
        this.handlePayload(conn, payload);
      } catch {
        warnMalformedFrame('ws', text ?? '<binary frame>');
      }
    };

    activeWs.onclose = () => {
      if (!this.isCurrentConnection(conn) || conn.ws !== activeWs) return;
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
      if (!this.isCurrentConnection(conn) || conn.ws !== activeWs) return;
      conn.connecting = false;
      activeWs.close();
    };
  }

  private handlePayload(conn: ServerConnection, payload: GatewayPayload): void {
    if (payload.s !== undefined && payload.s !== null) conn.sequence = payload.s;

    switch (payload.op) {
      case 10: { // HELLO
        conn.heartbeatInterval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(conn);
        this.identify(conn);
        break;
      }
      case 11: // HEARTBEAT_ACK
        if (conn.lastHeartbeatSent > 0) {
          conn.connectionLatency = Date.now() - conn.lastHeartbeatSent;
          useUIStore.getState().setConnectionLatency(conn.connectionLatency);
        }
        conn.missedAcks = 0;
        break;
      case 0: // DISPATCH
        this.handleDispatch(conn, payload.t!, payload.d);
        break;
      case 7: // RECONNECT
        if (this.useRealtimeV2) {
          this.clearSseWatchdog(conn);
          conn.eventSource?.close();
          conn.eventSource = null;
          conn.connected = false;
          conn.connecting = false;
          this.reconnectGateway(conn);
        } else {
          conn.ws?.close();
        }
        break;
      case 9: // INVALID_SESSION
        conn.sessionId = null;
        if (this.useRealtimeV2) {
          this.clearSseWatchdog(conn);
          conn.eventSource?.close();
          conn.eventSource = null;
          conn.connected = false;
          conn.connecting = false;
          this.reconnectGateway(conn);
        } else {
          setTimeout(() => this.identify(conn), 1000 + Math.random() * 4000);
        }
        break;
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
      conn.lastHeartbeatSent = Date.now();
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
  private startSseWatchdog(conn: ServerConnection, es: EventSource): void {
    this.clearSseWatchdog(conn);
    conn.lastFrameTs = Date.now();
    conn.missedAcks = 0;
    conn.sseWatchdogTimer = setInterval(() => {
      if (!this.isCurrentConnection(conn) || conn.eventSource !== es) {
        this.clearSseWatchdog(conn);
        return;
      }
      conn.missedAcks++;
      if (conn.missedAcks < ConnectionManager.MAX_MISSED_ACKS) return;

      // Stream is stale — record latency like the WS ack path and tear it down.
      conn.connectionLatency = Date.now() - conn.lastFrameTs;
      useUIStore.getState().setConnectionLatency(conn.connectionLatency);
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

  private handleDispatch(conn: ServerConnection, event: string, data: unknown): void {
    if (event === GatewayEvents.READY || event === GatewayEvents.RESUMED) {
      const lifecycle = data as { session_id?: string };
      if (event === GatewayEvents.READY) {
        conn.sessionId = lifecycle.session_id ?? null;
      } else if (lifecycle.session_id) {
        conn.sessionId = lifecycle.session_id;
      }
      conn.reconnectAttempts = 0;
      this.flushPendingMessages(conn);
      this.syncUiConnectionStatus();
    }
    dispatchGatewayEvent(conn.serverId, event, (data ?? {}) as Record<string, unknown>);
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
  ): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    if (this.useRealtimeV2) {
      void this.postRealtimeCommand(conn, 'voice_state_update', {
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
      d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf, self_video: selfVideo },
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
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
    this.clearSseWatchdog(conn);
  }

  /** Disconnect a specific server */
  disconnectServer(serverId: string): void {
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
  private async syncTrustedHosts(serverUrls: string[]): Promise<void> {
    try {
      if (typeof window !== 'undefined' && '__TAURI__' in window) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('update_trusted_server_hosts', { serverUrls });
      }
    } catch {
      // Not running in Tauri or command not available — ignore.
    }
  }

  /** Connect to all saved servers */
  async connectAll(): Promise<void> {
    if (this.offline) {
      logVoiceDiagnostic('[gateway] connectAll: offline, skipping');
      this.syncUiConnectionStatus();
      return;
    }
    const servers = useServerListStore.getState().servers;
    const localToken = useAuthStore.getState().token;
    logVoiceDiagnostic('[gateway] connectAll', { serverCount: servers.length, useRealtimeV2: this.useRealtimeV2, hasAuthToken: !!localToken, serverIds: servers.map(s => s.id) });

    // Ask the Tauri backend to verify and sync trusted server hosts so that TLS
    // certificate errors for user-configured self-hosted servers are allowed through.
    // Include the local server URL alongside remote servers.
    const allServerUrls = servers.map((s) => s.url);
    const localServerUrl = this.resolveLocalServerUrl();
    if (localServerUrl && !allServerUrls.includes(localServerUrl)) {
      allServerUrls.push(localServerUrl);
    }
    void this.syncTrustedHosts(allServerUrls);
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
    const localAlreadyCovered = servers.some(
      (s) => s.url.replace(/\/+$/, '') === localUrl,
    );
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

