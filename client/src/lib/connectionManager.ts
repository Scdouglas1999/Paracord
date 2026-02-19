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
import { setAccessToken } from './authToken';
import { getCurrentOriginServerUrl, getStoredServerUrl } from './apiBaseUrl';
import type { Activity, GatewayPayload } from '../types';
import { GatewayEvents } from '../gateway/events';
import { dispatchGatewayEvent } from '../gateway/dispatch';

export const LOCAL_SERVER_ID = '__local__';

export interface ServerConnection {
  serverId: string;
  serverUrl: string;
  apiClient: AxiosInstance;
  ws: WebSocket | null;
  eventSource: EventSource | null;
  streamUrl: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatInterval: number | null;
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
  private readonly useRealtimeV2 =
    import.meta.env.VITE_RT_V2 !== '0' && import.meta.env.VITE_RT_V2 !== 'false';
  private offline = typeof navigator !== 'undefined' && navigator.onLine === false;

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
    if (all.length === 0) {
      useUIStore.getState().setConnectionStatus('disconnected');
      return;
    }
    if (this.offline) {
      useUIStore.getState().setConnectionStatus('disconnected');
      return;
    }

    if (all.some((conn) => conn.connected)) {
      useUIStore.getState().setConnectionStatus('connected');
      return;
    }

    if (
      all.some(
        (conn) =>
          conn.ws?.readyState === WebSocket.CONNECTING ||
          conn.connecting ||
          conn.eventSource !== null
      )
    ) {
      useUIStore.getState().setConnectionStatus('connecting');
      return;
    }

    if (all.some((conn) => conn.reconnectTimer !== null)) {
      useUIStore.getState().setConnectionStatus('reconnecting');
      return;
    }

    useUIStore.getState().setConnectionStatus('disconnected');
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
    if (!token) return;

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
      (nextToken) => {
        setAccessToken(nextToken);
        useAuthStore.setState({ token: nextToken });
      },
      () => {
        setAccessToken(null);
        useAuthStore.setState({ token: null, user: null });
        this.disconnectServer(LOCAL_SERVER_ID);
      },
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
      (token) => useServerListStore.getState().updateToken(serverId, token),
      () => {
        // Auth failed; clear token and disconnect.
        useServerListStore.getState().updateToken(serverId, '');
        useServerListStore.getState().setApiReachable(serverId, false);
        this.disconnectServer(serverId);
      },
      (reachable) => useServerListStore.getState().setApiReachable(serverId, reachable),
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
      user: { id: string; username: string; flags: number; public_key: string };
    }>('/auth/verify', {
      public_key: publicKey,
      nonce: challenge.nonce,
      timestamp: challenge.timestamp,
      signature,
      username,
      display_name: displayName || undefined,
    });

    // Store the user's server-local ID
    useServerListStore.getState().updateServerInfo(server.id, {
      userId: authResponse.user.id,
    });

    // Also update the legacy authStore for backward compat during migration
    // so that existing components that read useAuthStore.user still work
    useAuthStore.setState({
      token: authResponse.token,
      user: {
        ...authResponse.user,
        discriminator: 0,
        bot: false,
        system: false,
        created_at: new Date().toISOString(),
      },
    });
    setAccessToken(authResponse.token);

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
    if (!this.isCurrentConnection(conn)) return;
    if (conn.connecting || conn.eventSource) return;
    const token = this.tokenForConnection(conn);
    if (!token) return;

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
        const sessionResp = await conn.apiClient.post<{
          session_id?: string;
          cursor?: number;
        }>(`${conn.serverUrl.replace(/\/+$/, '')}/api/v2/rt/session`, undefined, {
          timeout: 10_000,
        });
        if (!this.isCurrentConnection(conn) || !conn.allowReconnect) return;
        if (sessionResp.data?.session_id) {
          conn.sessionId = sessionResp.data.session_id;
        }
        if (typeof sessionResp.data?.cursor === 'number' && conn.realtimeCursor == null) {
          conn.realtimeCursor = sessionResp.data.cursor;
        }

        const base = conn.serverUrl.replace(/\/+$/, '');
        const params = new URLSearchParams();
        params.set('token', token);
        if (conn.sessionId) params.set('session_id', conn.sessionId);
        if (conn.realtimeCursor != null) params.set('cursor', String(conn.realtimeCursor));
        const streamUrl = `${base}/api/v2/rt/events?${params.toString()}`;
        conn.streamUrl = streamUrl;

        const es = new EventSource(streamUrl, { withCredentials: true });
        conn.eventSource = es;

        es.onopen = () => {
          if (!this.isCurrentConnection(conn) || conn.eventSource !== es) {
            es.close();
            return;
          }
          conn.connecting = false;
          conn.connected = true;
          conn.reconnectAttempts = 0;
          if (conn.serverId !== LOCAL_SERVER_ID) {
            useServerListStore.getState().setConnected(conn.serverId, true);
          }
          this.syncUiConnectionStatus();
        };

        const handleRealtimeEvent = (rawData: string) => {
          if (!this.isCurrentConnection(conn) || conn.eventSource !== es) return;
          try {
            const payload: GatewayPayload & { event_id?: number } = JSON.parse(rawData);
            if (typeof payload.event_id === 'number') {
              conn.realtimeCursor = payload.event_id;
            }
            this.handlePayload(conn, payload);
          } catch {
            // ignore malformed payloads
          }
        };
        es.onmessage = (evt) => {
          handleRealtimeEvent(evt.data);
        };
        es.addEventListener('gateway', (evt) => {
          const msg = evt as MessageEvent<string>;
          handleRealtimeEvent(msg.data);
        });

        es.onerror = () => {
          if (!this.isCurrentConnection(conn) || conn.eventSource !== es) return;
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
      } catch {
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
    const wsUrl = `${wsBase}/gateway`;

    conn.connecting = true;
    conn.ws = new WebSocket(wsUrl);
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
      try {
        const payload: GatewayPayload = JSON.parse(event.data);
        this.handlePayload(conn, payload);
      } catch {
        /* ignore malformed payloads */
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
      if (conn.missedAcks >= 3) {
        conn.ws?.close();
        return;
      }
      conn.lastHeartbeatSent = Date.now();
      conn.missedAcks++;
      this.send(conn, { op: 1, d: conn.sequence });
    }, conn.heartbeatInterval!);
  }

  private handleDispatch(conn: ServerConnection, event: string, data: unknown): void {
    if (event === GatewayEvents.READY) {
      const ready = data as { session_id?: string };
      conn.sessionId = ready.session_id ?? null;
      conn.reconnectAttempts = 0;
      this.flushPendingMessages(conn);
      this.syncUiConnectionStatus();
    }
    dispatchGatewayEvent(conn.serverId, event, data);
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
      }).catch(() => {});
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
  ): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    if (this.useRealtimeV2) {
      void this.postRealtimeCommand(conn, 'voice_state_update', {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: selfMute,
        self_deaf: selfDeaf,
      }).catch(() => {});
      return;
    }
    this.send(conn, {
      op: 4,
      d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf },
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
  ): void {
    for (const conn of this.getAllConnections()) {
      this.updateVoiceState(conn.serverId, guildId, channelId, selfMute, selfDeaf);
    }
  }

  private reconnectGateway(conn: ServerConnection): void {
    if (!conn.allowReconnect || conn.reconnectTimer) return;
    if (!this.isCurrentConnection(conn)) return;
    if (this.offline) {
      this.syncUiConnectionStatus();
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, Math.min(conn.reconnectAttempts, 5)), 30000);
    conn.reconnectAttempts++;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      if (!conn.allowReconnect) return;
      if (!this.isCurrentConnection(conn)) return;
      this.connectRealtime(conn);
    }, delay);
    this.syncUiConnectionStatus();
  }

  private cleanupConnection(conn: ServerConnection): void {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
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

  /** Connect to all saved servers */
  async connectAll(): Promise<void> {
    if (this.offline) {
      this.syncUiConnectionStatus();
      return;
    }
    const servers = useServerListStore.getState().servers;
    const keepIds = new Set<string>();
    if (servers.length === 0) {
      keepIds.add(LOCAL_SERVER_ID);
      await this.connectLocal();
    } else {
      await Promise.allSettled(servers.map((s) => this.connectServer(s.id)));
      for (const server of servers) {
        keepIds.add(server.id);
      }
      if (this.connections.has(LOCAL_SERVER_ID)) {
        this.disconnectServer(LOCAL_SERVER_ID);
      }
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

