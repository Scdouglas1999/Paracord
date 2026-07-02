import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useTypingStore } from '../stores/typingStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useUIStore } from '../stores/uiStore';
import { useMessageStore } from '../stores/messageStore';
import { usePollStore } from '../stores/pollStore';
import { useAuthStore } from '../stores/authStore';
import { hasUnlockedPrivateKey } from '../lib/accountSession';
import { ensurePrekeysUploaded } from '../lib/signalPrekeys';
import { GatewayEvents } from './events';
import { sendNotification, isEnabled as notificationsEnabled } from '../lib/notifications';
import type { Channel, Guild, Member, Message, Poll, Presence, User, VoiceState } from '../types';

interface ReadyChannelPayload extends Partial<Channel> {
  id: string;
}

interface ReadyGuildPayload extends Partial<Guild> {
  id: string;
  channels?: ReadyChannelPayload[];
  voice_states?: VoiceState[];
  presences?: Presence[];
}

type GatewayDispatchData = Partial<Message> &
  Partial<Guild> &
  Partial<Channel> &
  Partial<VoiceState> & {
    user?: User;
    guilds?: ReadyGuildPayload[];
    ids?: string[];
    message_id?: string;
    emoji?: string | { name?: string };
    poll?: unknown;
  };

export function dispatchGatewayEvent(serverId: string, event: string, data: GatewayDispatchData): void {
  switch (event) {
    case GatewayEvents.READY: {
      useUIStore.getState().setServerRestarting(false);

      // Update auth store for backward compat
      if (data.user) {
        useAuthStore.setState({ user: data.user });
      }

      const readyGuildIds: string[] = [];
      data.guilds?.forEach((g) => {
        readyGuildIds.push(g.id);
        const normalizedGuild: Guild = {
          ...(g as Guild),
          id: g.id,
          name: g.name ?? 'Unnamed Server',
          owner_id: g.owner_id ?? '',
          created_at: g.created_at ?? new Date().toISOString(),
          member_count: g.member_count ?? 0,
          features: g.features ?? [],
          default_channel_id:
            g.default_channel_id
            ?? g.channels?.find((c) => (c.channel_type ?? c.type) === 0)?.id
            ?? null,
        };
        useGuildStore.getState().addGuild(normalizedGuild);

        const guildChannels = g.channels ?? [];
        if (guildChannels.length > 0) {
          guildChannels.forEach((c) => {
            if (!c.id) return;
            useChannelStore.getState().addChannel({
              ...c,
              id: c.id,
              guild_id: c.guild_id ?? g.id,
              type: c.channel_type ?? c.type ?? 0,
              channel_type: c.channel_type ?? c.type ?? 0,
              nsfw: c.nsfw ?? false,
              position: c.position ?? 0,
              created_at: c.created_at ?? new Date().toISOString(),
            });
          });
          // Mark channels as loaded from READY so the UI doesn't show
          // empty state while the REST fetch is still in-flight.
          const channelState = useChannelStore.getState();
          if (!channelState.guildChannelsLoaded[g.id]) {
            useChannelStore.setState((state) => ({
              guildChannelsLoaded: { ...state.guildChannelsLoaded, [g.id]: true },
            }));
          }
        }
        useVoiceStore.getState().loadVoiceStates(g.id, g.voice_states ?? []);
        if (g.presences?.length) {
          for (const p of g.presences) {
            usePresenceStore.getState().updatePresence(p, serverId);
          }
        }
      });

      const selectedGuildId = useGuildStore.getState().selectedGuildId;
      const activeGuildId = selectedGuildId && readyGuildIds.includes(selectedGuildId)
        ? selectedGuildId
        : readyGuildIds[0];
      if (activeGuildId) {
        const channelState = useChannelStore.getState();
        if (!channelState.guildChannelsLoaded[activeGuildId]) {
          void channelState.fetchChannels(activeGuildId);
        }
        const memberState = useMemberStore.getState();
        if (!memberState.membersLoaded[activeGuildId]) {
          void memberState.fetchMembers(activeGuildId);
        }
      }

      // Set our own presence to online. The server dispatches PRESENCE_UPDATE
      // before our session starts listening, so we never receive our own
      // online event — set it locally from the READY user data.
      if (data.user?.id) {
        usePresenceStore.getState().updatePresence({
          user_id: data.user.id,
          status: 'online',
          activities: [],
        }, serverId);
      }

      // Ensure Signal prekeys are uploaded for E2EE DMs
      if (hasUnlockedPrivateKey()) {
        void ensurePrekeysUploaded().catch((err) => {
          console.warn('Failed to upload/replenish prekeys:', err);
        });
      }
      break;
    }

    case GatewayEvents.MESSAGE_CREATE:
      if (!data.channel_id || !data.id) break;
      useMessageStore.getState().addMessage(data.channel_id, data as Message);
      useChannelStore.getState().updateLastMessageId(data.channel_id, data.id);
      // Desktop notification for messages not from self and not in focused channel
      if (notificationsEnabled()) {
        const currentUserId = useAuthStore.getState().user?.id;
        const authorId = data.author?.id ?? data.user_id;
        const focusedChannelId = useChannelStore.getState().selectedChannelId;
        const isDocumentFocused = typeof document !== 'undefined' && document.hasFocus();
        if (
          authorId !== currentUserId &&
          !(isDocumentFocused && focusedChannelId === data.channel_id)
        ) {
          const channelName = useChannelStore.getState().channels.find(
            (c) => c.id === data.channel_id,
          )?.name;
          const authorName = data.author?.username ?? 'Someone';
          const title = channelName ? `#${channelName}` : `DM from ${authorName}`;
          const body = data.e2ee
            ? '[Encrypted message]'
            : (data.content || '').slice(0, 200) || '(attachment)';
          void sendNotification(title, body);
        }
      }
      break;
    case GatewayEvents.MESSAGE_UPDATE:
      if (!data.channel_id) break;
      useMessageStore.getState().updateMessage(data.channel_id, data as Message);
      break;
    case GatewayEvents.MESSAGE_DELETE:
      if (!data.channel_id || !data.id) break;
      useMessageStore.getState().removeMessage(data.channel_id, data.id);
      break;
    case GatewayEvents.MESSAGE_DELETE_BULK:
      if (data.channel_id && data.ids?.length) {
        useMessageStore.getState().removeMessages(data.channel_id, data.ids);
      }
      break;

    case GatewayEvents.GUILD_CREATE:
      useGuildStore.getState().addGuild(data as Guild);
      break;
    case GatewayEvents.GUILD_UPDATE:
      if (!data.id) break;
      useGuildStore.getState().updateGuildData(data.id, data as Partial<Guild>);
      break;
    case GatewayEvents.GUILD_DELETE:
      if (!data.id) break;
      useGuildStore.getState().removeGuild(data.id);
      break;

    case GatewayEvents.CHANNEL_CREATE:
      useChannelStore.getState().addChannel(data as Channel);
      break;
    case GatewayEvents.CHANNEL_UPDATE:
      useChannelStore.getState().updateChannel(data as Channel);
      break;
    case GatewayEvents.CHANNEL_DELETE:
      if (!data.guild_id || !data.id) break;
      useChannelStore.getState().removeChannel(data.guild_id, data.id);
      break;

    case GatewayEvents.THREAD_CREATE:
      if (!data.id) break;
      useChannelStore.getState().addChannel({
        ...data,
        id: data.id,
        type: data.channel_type ?? data.type ?? 6,
        channel_type: data.channel_type ?? data.type ?? 6,
        nsfw: data.nsfw ?? false,
        position: data.position ?? 0,
        created_at: data.created_at ?? new Date().toISOString(),
      });
      break;
    case GatewayEvents.THREAD_UPDATE:
      if (!data.id) break;
      useChannelStore.getState().updateChannel({
        ...data,
        id: data.id,
        type: data.channel_type ?? data.type ?? 6,
        channel_type: data.channel_type ?? data.type ?? 6,
        nsfw: data.nsfw ?? false,
        position: data.position ?? 0,
        created_at: data.created_at ?? new Date().toISOString(),
      });
      break;
    case GatewayEvents.THREAD_DELETE: {
      if (!data.id) break;
      const channelsByGuild = useChannelStore.getState().channelsByGuild;
      let fallbackGuildId = '';
      for (const [gid, list] of Object.entries(channelsByGuild)) {
        if (list.some((ch) => ch.id === data.id)) {
          fallbackGuildId = gid;
          break;
        }
      }
      useChannelStore
        .getState()
        .removeChannel(data.guild_id || fallbackGuildId, data.id);
      break;
    }

    case GatewayEvents.GUILD_MEMBER_ADD:
      if (!data.guild_id) break;
      if (data.user) {
        useMemberStore.getState().addMember(data.guild_id, data as unknown as Member);
      } else {
        void useMemberStore.getState().fetchMembers(data.guild_id);
      }
      break;
    case GatewayEvents.GUILD_MEMBER_REMOVE:
      if (!data.guild_id) break;
      {
        const targetUserId = data.user?.id ?? data.user_id;
        if (targetUserId) {
          useMemberStore.getState().removeMember(data.guild_id, targetUserId);
        } else {
          void useMemberStore.getState().fetchMembers(data.guild_id);
        }
      }
      break;
    case GatewayEvents.GUILD_MEMBER_UPDATE:
      if (!data.guild_id) break;
      if (data.user?.id) {
        useMemberStore.getState().updateMember(
          data.guild_id,
          data as Partial<Member> & { user: { id: string } },
        );
      } else {
        void useMemberStore.getState().fetchMembers(data.guild_id);
      }
      break;

    case GatewayEvents.PRESENCE_UPDATE:
      usePresenceStore.getState().updatePresence(data as Presence, serverId);
      break;

    case GatewayEvents.VOICE_STATE_UPDATE:
      useVoiceStore.getState().handleVoiceStateUpdate(data as VoiceState);
      break;

    case GatewayEvents.MESSAGE_REACTION_ADD: {
      if (!data.channel_id || !data.message_id || !data.user_id) break;
      const currentUserId = useAuthStore.getState().user?.id || '';
      useMessageStore.getState().handleReactionAdd(
        data.channel_id,
        data.message_id,
        (typeof data.emoji === 'object' && data.emoji ? data.emoji.name : data.emoji) as string,
        data.user_id,
        currentUserId
      );
      break;
    }
    case GatewayEvents.MESSAGE_REACTION_REMOVE: {
      if (!data.channel_id || !data.message_id || !data.user_id) break;
      const currentUserId2 = useAuthStore.getState().user?.id || '';
      useMessageStore.getState().handleReactionRemove(
        data.channel_id,
        data.message_id,
        (typeof data.emoji === 'object' && data.emoji ? data.emoji.name : data.emoji) as string,
        data.user_id,
        currentUserId2
      );
      break;
    }
    case GatewayEvents.POLL_VOTE_ADD:
    case GatewayEvents.POLL_VOTE_REMOVE:
      if (data.poll) {
        usePollStore.getState().upsertPoll(data.poll as Poll);
      }
      break;

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

    case GatewayEvents.GUILD_SCHEDULED_EVENT_CREATE:
    case GatewayEvents.GUILD_SCHEDULED_EVENT_UPDATE:
    case GatewayEvents.GUILD_SCHEDULED_EVENT_DELETE:
    case GatewayEvents.GUILD_SCHEDULED_EVENT_USER_ADD:
    case GatewayEvents.GUILD_SCHEDULED_EVENT_USER_REMOVE:
      window.dispatchEvent(new CustomEvent('paracord:scheduled-events-changed', {
        detail: { guild_id: data.guild_id },
      }));
      break;

    case GatewayEvents.GUILD_EMOJIS_UPDATE:
      window.dispatchEvent(new CustomEvent('paracord:emojis-changed', {
        detail: { guild_id: data.guild_id },
      }));
      break;

    case GatewayEvents.SERVER_RESTART:
      useUIStore.getState().setServerRestarting(true);
      break;
  }
}

