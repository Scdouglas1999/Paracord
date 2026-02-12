import { type AxiosInstance } from 'axios';
import { createApiClient } from '../api/client';
import { useServerListStore, type ServerEntry } from '../stores/serverListStore';
import { useAccountStore } from '../stores/accountStore';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useTypingStore } from '../stores/typingStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useUIStore } from '../stores/uiStore';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { signChallenge } from './account';
import type { GatewayPayload } from '../types';
import { GatewayEvents } from '../gateway/events';

export interface ServerConnection {
  serverId: string;
  serverUrl: string;
  apiClient: AxiosInstance;
  ws: WebSocket | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatInterval: number | null;
  sequence: number | null;
  sessionId: string | null;
  reconnectAttempts: number;
  allowReconnect: boolean;
  connected: boolean;
}

class ConnectionManager {
  private connections = new Map<string, ServerConnection>();

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
    if (!activeId) return undefined;
    return this.connections.get(activeId)?.apiClient;
  }

  /** Authenticate with a server using challenge-response, then connect gateway */
  async connectServer(serverId: string): Promise<void> {
    const server = useServerListStore.getState().getServer(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);

    const account = useAccountStore.getState();
    if (!account.isUnlocked || !account.privateKey || !account.publicKey) {
      throw new Error('Account not unlocked');
    }

    // Create API client for this server
    const apiBaseUrl = `${server.url.replace(/\/+$/, '')}/api/v1`;
    const client = createApiClient(
      apiBaseUrl,
      () => useServerListStore.getState().getServer(serverId)?.token || null,
      (token) => useServerListStore.getState().updateToken(serverId, token),
      () => {
        // Auth failed — clear token, disconnect
        useServerListStore.getState().updateToken(serverId, '');
        this.disconnectServer(serverId);
      },
    );

    // If we don't have a valid token, do challenge-response auth
    if (!server.token) {
      const token = await this.authenticate(client, server, account.publicKey, account.privateKey, account.username!);
      useServerListStore.getState().updateToken(serverId, token);
    }

    const conn: ServerConnection = {
      serverId,
      serverUrl: server.url,
      apiClient: client,
      ws: null,
      heartbeatTimer: null,
      heartbeatInterval: null,
      sequence: null,
      sessionId: null,
      reconnectAttempts: 0,
      allowReconnect: true,
      connected: false,
    };
    this.connections.set(serverId, conn);

    // Connect WebSocket gateway
    this.connectGateway(conn);
  }

  /** Perform Ed25519 challenge-response authentication */
  private async authenticate(
    client: AxiosInstance,
    server: ServerEntry,
    publicKey: string,
    privateKey: Uint8Array,
    username: string,
  ): Promise<string> {
    // Step 1: Get challenge
    const { data: challenge } = await client.post<{
      nonce: string;
      timestamp: number;
      server_origin: string;
    }>('/auth/challenge');

    // Step 2: Sign the challenge
    const signature = await signChallenge(
      privateKey,
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
    localStorage.setItem('token', authResponse.token);

    return authResponse.token;
  }

  /** Connect WebSocket gateway for a server */
  private connectGateway(conn: ServerConnection): void {
    const token = useServerListStore.getState().getServer(conn.serverId)?.token;
    if (!token) return;

    const wsBase = conn.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/gateway`;

    conn.ws = new WebSocket(wsUrl);
    conn.allowReconnect = true;

    conn.ws.onopen = () => {
      conn.reconnectAttempts = 0;
      conn.connected = true;
      useServerListStore.getState().setConnected(conn.serverId, true);
    };

    conn.ws.onmessage = (event) => {
      try {
        const payload: GatewayPayload = JSON.parse(event.data);
        this.handlePayload(conn, payload);
      } catch {
        /* ignore malformed payloads */
      }
    };

    conn.ws.onclose = () => {
      conn.connected = false;
      useServerListStore.getState().setConnected(conn.serverId, false);
      this.cleanupConnection(conn);
      if (conn.allowReconnect) {
        this.reconnectGateway(conn);
      }
    };

    conn.ws.onerror = () => {
      conn.ws?.close();
    };
  }

  private handlePayload(conn: ServerConnection, payload: GatewayPayload): void {
    if (payload.s) conn.sequence = payload.s;

    switch (payload.op) {
      case 10: { // HELLO
        conn.heartbeatInterval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(conn);
        this.identify(conn);
        break;
      }
      case 11: // HEARTBEAT_ACK
        break;
      case 0: // DISPATCH
        this.handleDispatch(conn, payload.t!, payload.d);
        break;
      case 7: // RECONNECT
        conn.ws?.close();
        break;
      case 9: // INVALID_SESSION
        conn.sessionId = null;
        setTimeout(() => this.identify(conn), 1000 + Math.random() * 4000);
        break;
    }
  }

  private identify(conn: ServerConnection): void {
    const token = useServerListStore.getState().getServer(conn.serverId)?.token;
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
      this.send(conn, { op: 1, d: conn.sequence });
    }, conn.heartbeatInterval!);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private handleDispatch(conn: ServerConnection, event: string, data: any): void {
    // Dispatch events are the same as before, but now they can come from any server.
    // Since guild/channel/message IDs are unique snowflakes per server, the existing
    // stores handle this naturally — data from different servers has different IDs.
    switch (event) {
      case GatewayEvents.READY:
        conn.sessionId = data.session_id;
        useUIStore.getState().setServerRestarting(false);

        // Update server info with actual name
        if (data.guilds?.length > 0) {
          // Server name could come from guild or server info
        }

        // Update auth store for backward compat
        if (data.user) {
          useAuthStore.setState({ user: data.user });
        }

        data.guilds?.forEach((g: any) => {
          useGuildStore.getState().addGuild({
            ...g,
            created_at: g.created_at ?? new Date().toISOString(),
            member_count: g.member_count ?? 0,
            features: g.features ?? [],
            default_channel_id: g.channels?.find((c: any) => c.channel_type === 0)?.id ?? null,
          });
          g.channels?.forEach((c: any) => {
            useChannelStore.getState().addChannel({
              ...c,
              guild_id: c.guild_id ?? g.id,
              type: c.channel_type ?? c.type ?? 0,
              channel_type: c.channel_type ?? c.type ?? 0,
              nsfw: c.nsfw ?? false,
              position: c.position ?? 0,
              created_at: c.created_at ?? new Date().toISOString(),
            });
          });
          useVoiceStore.getState().loadVoiceStates(g.id, g.voice_states ?? []);
          if (g.presences?.length) {
            for (const p of g.presences) {
              usePresenceStore.getState().updatePresence(p);
            }
          }
          void useMemberStore.getState().fetchMembers(g.id);
        });
        break;

      case GatewayEvents.MESSAGE_CREATE:
        useMessageStore.getState().addMessage(data.channel_id, data);
        break;
      case GatewayEvents.MESSAGE_UPDATE:
        useMessageStore.getState().updateMessage(data.channel_id, data);
        break;
      case GatewayEvents.MESSAGE_DELETE:
        useMessageStore.getState().removeMessage(data.channel_id, data.id);
        break;
      case GatewayEvents.MESSAGE_DELETE_BULK:
        data.ids?.forEach((id: string) => {
          useMessageStore.getState().removeMessage(data.channel_id, id);
        });
        break;

      case GatewayEvents.GUILD_CREATE:
        useGuildStore.getState().addGuild(data);
        break;
      case GatewayEvents.GUILD_UPDATE:
        useGuildStore.getState().updateGuildData(data.id, data);
        break;
      case GatewayEvents.GUILD_DELETE:
        useGuildStore.getState().removeGuild(data.id);
        break;

      case GatewayEvents.CHANNEL_CREATE:
        useChannelStore.getState().addChannel(data);
        break;
      case GatewayEvents.CHANNEL_UPDATE:
        useChannelStore.getState().updateChannel(data);
        break;
      case GatewayEvents.CHANNEL_DELETE:
        useChannelStore.getState().removeChannel(data.guild_id, data.id);
        break;

      case GatewayEvents.GUILD_MEMBER_ADD:
        void useMemberStore.getState().fetchMembers(data.guild_id);
        break;
      case GatewayEvents.GUILD_MEMBER_REMOVE:
        if (data.user?.id || data.user_id) {
          useMemberStore.getState().removeMember(data.guild_id, data.user?.id ?? data.user_id);
        } else {
          void useMemberStore.getState().fetchMembers(data.guild_id);
        }
        break;
      case GatewayEvents.GUILD_MEMBER_UPDATE:
        void useMemberStore.getState().fetchMembers(data.guild_id);
        break;

      case GatewayEvents.PRESENCE_UPDATE:
        usePresenceStore.getState().updatePresence(data);
        break;

      case GatewayEvents.VOICE_STATE_UPDATE:
        useVoiceStore.getState().handleVoiceStateUpdate(data);
        break;

      case GatewayEvents.MESSAGE_REACTION_ADD: {
        const currentUserId = useAuthStore.getState().user?.id || '';
        useMessageStore.getState().handleReactionAdd(
          data.channel_id, data.message_id, data.emoji?.name || data.emoji, data.user_id, currentUserId
        );
        break;
      }
      case GatewayEvents.MESSAGE_REACTION_REMOVE: {
        const currentUserId2 = useAuthStore.getState().user?.id || '';
        useMessageStore.getState().handleReactionRemove(
          data.channel_id, data.message_id, data.emoji?.name || data.emoji, data.user_id, currentUserId2
        );
        break;
      }

      case GatewayEvents.CHANNEL_PINS_UPDATE:
        if (data.channel_id) {
          useMessageStore.getState().fetchPins(data.channel_id);
        }
        break;

      case GatewayEvents.TYPING_START:
        if (data.channel_id && data.user_id) {
          useTypingStore.getState().addTyping(data.channel_id, data.user_id);
        }
        break;

      case GatewayEvents.USER_UPDATE:
        useAuthStore.getState().fetchUser();
        break;

      case GatewayEvents.RELATIONSHIP_ADD:
      case GatewayEvents.RELATIONSHIP_REMOVE:
        void useRelationshipStore.getState().fetchRelationships();
        break;

      case GatewayEvents.SERVER_RESTART:
        useUIStore.getState().setServerRestarting(true);
        break;
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private send(conn: ServerConnection, data: unknown): void {
    if (conn.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(data));
    }
  }

  /** Send a presence update on a specific server */
  updatePresence(serverId: string, status: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    this.send(conn, { op: 3, d: { status, afk: false } });
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
    this.send(conn, {
      op: 4,
      d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf },
    });
  }

  private reconnectGateway(conn: ServerConnection): void {
    if (conn.reconnectAttempts >= 10) return;
    const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30000);
    conn.reconnectAttempts++;
    setTimeout(() => this.connectGateway(conn), delay);
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
    this.cleanupConnection(conn);
    conn.ws?.close();
    conn.ws = null;
    conn.connected = false;
    useServerListStore.getState().setConnected(serverId, false);
    this.connections.delete(serverId);
  }

  /** Connect to all saved servers */
  async connectAll(): Promise<void> {
    const servers = useServerListStore.getState().servers;
    await Promise.allSettled(
      servers.map((s) => this.connectServer(s.id))
    );
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
