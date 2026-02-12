import type { GatewayPayload } from '../types';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useMessageStore } from '../stores/messageStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useTypingStore } from '../stores/typingStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useUIStore } from '../stores/uiStore';
import { GatewayEvents } from './events';
import { getStoredServerUrl } from '../lib/apiBaseUrl';

function resolveWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;

  const serverUrl = getStoredServerUrl();
  if (serverUrl) {
    // Convert http(s) URL to ws(s) URL
    const base = serverUrl.replace(/\/+$/, '');
    return base.replace(/^http/, 'ws') + '/gateway';
  }

  // Default: derive from current window location (same-origin or Vite dev proxy)
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/gateway`;
}

class GatewayConnection {
  private ws: WebSocket | null = null;
  private heartbeatInterval: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private allowReconnect = true;
  private sessionId: string | null = null;
  private _connected = false;

  get connected() {
    return this._connected;
  }

  connect() {
    const token = useAuthStore.getState().token;
    if (!token) return;
    this.allowReconnect = true;

    this.ws = new WebSocket(resolveWsUrl());

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this._connected = true;
    };

    this.ws.onmessage = (event) => {
      try {
        const payload: GatewayPayload = JSON.parse(event.data);
        this.handlePayload(payload);
      } catch {
        /* ignore malformed payloads */
      }
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.cleanup();
      if (this.allowReconnect) {
        this.reconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private handlePayload(payload: GatewayPayload) {
    if (payload.s) this.sequence = payload.s;

    switch (payload.op) {
      case 10: // HELLO
        this.heartbeatInterval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat();
        this.identify();
        break;

      case 11: // HEARTBEAT_ACK
        break;

      case 0: // DISPATCH
        this.handleDispatch(payload.t!, payload.d);
        break;

      case 7: // RECONNECT
        this.ws?.close();
        break;

      case 9: // INVALID_SESSION
        this.sessionId = null;
        setTimeout(() => this.identify(), 1000 + Math.random() * 4000);
        break;
    }
  }

  private identify() {
    const token = useAuthStore.getState().token;
    if (this.sessionId) {
      // Resume
      this.send({
        op: 6,
        d: { token, session_id: this.sessionId, seq: this.sequence },
      });
    } else {
      // Identify
      this.send({
        op: 2,
        d: { token },
      });
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.sequence });
    }, this.heartbeatInterval!);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private handleDispatch(event: string, data: any) {
    switch (event) {
      case GatewayEvents.READY:
        this.sessionId = data.session_id;
        useUIStore.getState().setServerRestarting(false);
        useAuthStore.getState().fetchUser();
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
          // Load initial voice states for this guild. READY is authoritative,
          // even when empty, so we always refresh to clear stale entries.
          useVoiceStore.getState().loadVoiceStates(g.id, g.voice_states ?? []);

          // Load initial presences for this guild if the server provided them
          if (g.presences?.length) {
            for (const p of g.presences) {
              usePresenceStore.getState().updatePresence(p);
            }
          }

          // Pre-fetch member list for each guild so the member sidebar populates
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
          useMemberStore
            .getState()
            .removeMember(data.guild_id, data.user?.id ?? data.user_id);
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
          data.channel_id,
          data.message_id,
          data.emoji?.name || data.emoji,
          data.user_id,
          currentUserId,
        );
        break;
      }
      case GatewayEvents.MESSAGE_REACTION_REMOVE: {
        const currentUserId2 = useAuthStore.getState().user?.id || '';
        useMessageStore.getState().handleReactionRemove(
          data.channel_id,
          data.message_id,
          data.emoji?.name || data.emoji,
          data.user_id,
          currentUserId2,
        );
        break;
      }

      case GatewayEvents.CHANNEL_PINS_UPDATE:
        // Refresh pins for the channel
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

  send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  updatePresence(status: string) {
    this.send({
      op: 3,
      d: { status, afk: false },
    });
  }

  updateVoiceState(guildId: string | null, channelId: string | null, selfMute: boolean, selfDeaf: boolean) {
    this.send({
      op: 4,
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: selfMute,
        self_deaf: selfDeaf,
      },
    });
  }

  private reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  private cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect() {
    this.allowReconnect = false;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}

export const gateway = new GatewayConnection();
