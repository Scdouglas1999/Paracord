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

/* eslint-disable @typescript-eslint/no-explicit-any */
export function dispatchGatewayEvent(serverId: string, event: string, data: any): void {
  switch (event) {
    case GatewayEvents.READY: {
      useUIStore.getState().setServerRestarting(false);

      // Update auth store for backward compat
      if (data.user) {
        useAuthStore.setState({ user: data.user });
      }

      const readyGuildIds: string[] = [];
      data.guilds?.forEach((g: any) => {
        readyGuildIds.push(g.id);
        useGuildStore.getState().addGuild({
          ...g,
          created_at: g.created_at ?? new Date().toISOString(),
          member_count: g.member_count ?? 0,
          features: g.features ?? [],
          default_channel_id:
            g.default_channel_id
            ?? g.channels?.find((c: any) => (c.channel_type ?? c.type) === 0)?.id
            ?? null,
        });
        const hasChannels = Array.isArray(g.channels) && g.channels.length > 0;
        if (hasChannels) {
          g.channels.forEach((c: any) => {
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
      useMessageStore.getState().addMessage(data.channel_id, data);
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
      useMessageStore.getState().updateMessage(data.channel_id, data);
      break;
    case GatewayEvents.MESSAGE_DELETE:
      useMessageStore.getState().removeMessage(data.channel_id, data.id);
      break;
    case GatewayEvents.MESSAGE_DELETE_BULK:
      if (data.ids?.length) {
        useMessageStore.getState().removeMessages(data.channel_id, data.ids);
      }
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

    case GatewayEvents.THREAD_CREATE:
      useChannelStore.getState().addChannel({
        ...data,
        type: data.channel_type ?? data.type ?? 6,
        channel_type: data.channel_type ?? data.type ?? 6,
        nsfw: data.nsfw ?? false,
        position: data.position ?? 0,
        created_at: data.created_at ?? new Date().toISOString(),
      });
      break;
    case GatewayEvents.THREAD_UPDATE:
      useChannelStore.getState().updateChannel({
        ...data,
        type: data.channel_type ?? data.type ?? 6,
        channel_type: data.channel_type ?? data.type ?? 6,
        nsfw: data.nsfw ?? false,
        position: data.position ?? 0,
        created_at: data.created_at ?? new Date().toISOString(),
      });
      break;
    case GatewayEvents.THREAD_DELETE: {
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
      if (data.user) {
        useMemberStore.getState().addMember(data.guild_id, data);
      } else {
        void useMemberStore.getState().fetchMembers(data.guild_id);
      }
      break;
    case GatewayEvents.GUILD_MEMBER_REMOVE:
      if (data.user?.id || data.user_id) {
        useMemberStore.getState().removeMember(data.guild_id, data.user?.id ?? data.user_id);
      } else {
        void useMemberStore.getState().fetchMembers(data.guild_id);
      }
      break;
    case GatewayEvents.GUILD_MEMBER_UPDATE:
      if (data.user?.id) {
        useMemberStore.getState().updateMember(data.guild_id, data);
      } else {
        void useMemberStore.getState().fetchMembers(data.guild_id);
      }
      break;

    case GatewayEvents.PRESENCE_UPDATE:
      usePresenceStore.getState().updatePresence(data, serverId);
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
    case GatewayEvents.POLL_VOTE_ADD:
    case GatewayEvents.POLL_VOTE_REMOVE:
      if (data.poll) {
        usePollStore.getState().upsertPoll(data.poll);
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
/* eslint-enable @typescript-eslint/no-explicit-any */

