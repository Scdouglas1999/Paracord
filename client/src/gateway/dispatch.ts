import { useGuildStore } from '../stores/guildStore';
import { refreshGuildChannelVisibility, useChannelStore } from '../stores/channelStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useTypingStore } from '../stores/typingStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useUIStore } from '../stores/uiStore';
import { useMessageStore } from '../stores/messageStore';
import { usePollStore } from '../stores/pollStore';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useInteractionStore } from '../stores/interactionStore';
import { hasUnlockedPrivateKey } from '../lib/accountSession';
import { ensurePrekeysUploaded } from '../lib/signalPrekeys';
import { GatewayEvents } from './events';
import { sendNotification, isEnabled as notificationsEnabled } from '../lib/features/notifications';
import type { Channel, Guild, Member, Message, Poll, Presence, User, VoiceState } from '../types';
import type { Component } from '../types/components';
import { InteractionCallbackType } from '../types/interactions';

interface ReadyChannelPayload extends Partial<Channel> {
  id: string;
}

interface ReadyGuildPayload extends Partial<Guild> {
  id: string;
  channels?: ReadyChannelPayload[];
  voice_states?: VoiceState[];
  presences?: Presence[];
}

type EmojiRef = string | { name?: string | null; id?: string | null };

type InteractionCallbackPayload = {
  interaction_id?: string;
  application_id?: string;
  /** Callback type (8 = autocomplete result, 9 = modal). Distinct from Channel.type. */
  callback_type?: number;
  channel_id?: string;
  guild_id?: string;
  data?: {
    title?: string;
    custom_id?: string;
    components?: Component[];
    choices?: { name: string; value: unknown }[];
    content?: string;
    flags?: number;
  };
};

// Omit Channel/Message `type` — INTERACTION_CREATE reuses `type` for callback
// kind (8/9), which is not assignable to ChannelType.
type GatewayDispatchData = Omit<
  Partial<Message> & Partial<Guild> & Partial<Channel> & Partial<VoiceState>,
  'type'
> &
  InteractionCallbackPayload & {
    user?: User;
    guilds?: ReadyGuildPayload[];
    ids?: string[];
    message_id?: string;
    emoji?: EmojiRef;
    poll?: unknown;
    /** Channel.type, Message.type, or INTERACTION_CREATE callback type. */
    type?: number;
  };

/**
 * Resolve a reaction emoji to its stable reaction key. Unicode emoji arrive as
 * a bare string; custom emoji arrive as `{ id, name }`. Custom emoji are keyed
 * by id (names are not unique per guild); unicode emoji are keyed by name.
 * Returns `undefined` when neither is present so callers can skip the event.
 */
export function resolveEmojiKey(emoji: EmojiRef | undefined): string | undefined {
  if (emoji == null) return undefined;
  if (typeof emoji === 'string') return emoji || undefined;
  if (emoji.id) return emoji.id;
  if (emoji.name) return emoji.name;
  return undefined;
}

function warnDispatchParseFailure(event: string, reason: string): void {
  // Redacted: never log payload contents, only the event name and cause.
  console.warn(`[gateway] dropping malformed ${event} payload: ${reason}`);
}

export function dispatchGatewayEvent(serverId: string, event: string, data: GatewayDispatchData): void {
  switch (event) {
    case GatewayEvents.READY: {
      useUIStore.getState().setServerRestarting(false);

      // Pull an authoritative read-state snapshot on every (re)connect so unread
      // and mention badges reconcile after any events missed while offline.
      void useReadStateStore.getState().refresh();

      // READY carries the *public* projection of the account (id, username,
      // avatar, display name) — not private fields like `flags` or `email`.
      // Replacing the store's user therefore used to wipe `flags`, which is how
      // a real server admin lost the admin panel the moment the gateway
      // connected. Merge so the authoritative REST profile survives.
      if (data.user) {
        const current = useAuthStore.getState().user;
        useAuthStore.setState({
          user: current ? { ...current, ...data.user } : data.user,
        });
      }

      const readyGuildIds: string[] = [];
      data.guilds?.forEach((g) => {
        // id and owner_id are required. Fabricating them (e.g. owner_id: '')
        // briefly flips owner-only UI to the wrong state, so skip the guild and
        // let the REST fetch supply an authoritative copy instead of guessing.
        if (!g?.id) {
          warnDispatchParseFailure('READY', 'guild missing id');
          return;
        }
        if (!g.owner_id) {
          warnDispatchParseFailure('READY', 'guild missing owner_id');
          return;
        }
        readyGuildIds.push(g.id);
        const normalizedGuild: Guild = {
          ...(g as Guild),
          id: g.id,
          owner_id: g.owner_id,
          // Tag the TRUE originating server so the cross-server merge reads the
          // right per-server unread/mention bucket (§9 flag 3). server_url alone
          // mis-attributes background-server guilds to the active server.
          originServerId: serverId,
          name: g.name ?? 'Unnamed Server',
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
            if (!c.id) {
              warnDispatchParseFailure('READY', 'channel missing id');
              return;
            }
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
      // Slash / component responses arrive as MESSAGE_CREATE with an interaction
      // payload. Clear the invoking client's pending/thinking state.
      {
        const interactionId = data.interaction?.id;
        if (interactionId) {
          const store = useInteractionStore.getState();
          const isEmptyDeferred =
            !(data.content && String(data.content).trim()) &&
            !(data.components && data.components.length > 0);
          if (isEmptyDeferred) {
            store.handleInteractionResponse(interactionId, {
              type: InteractionCallbackType.DeferredChannelMessageWithSource,
            });
          } else {
            store.handleInteractionResponse(interactionId, {
              type: InteractionCallbackType.ChannelMessageWithSource,
            });
          }
        }
      }
      // Keep the read-state cache live for mention badges between authoritative
      // refreshes: a message the user didn't author that mentions them — either
      // directly (<@id> / <@!id> in the content) or via @everyone — bumps the
      // channel's unread mention count. Reconciled on the next READY/refresh.
      {
        const mentionAuthorId = data.author?.id ?? data.user_id;
        const selfUserId =
          useServerListStore.getState().getServer(serverId)?.userId ||
          useAuthStore.getState().user?.id ||
          '';
        if (selfUserId && mentionAuthorId && mentionAuthorId !== selfUserId) {
          const content = typeof data.content === 'string' ? data.content : '';
          const mentionsSelf =
            data.mention_everyone === true ||
            new RegExp(`<@!?${selfUserId}>`).test(content);
          if (mentionsSelf) {
            useReadStateStore.getState().incrementMention(serverId, data.channel_id);
          }
        }
      }
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
    case GatewayEvents.MESSAGE_UPDATE: {
      if (!data.channel_id || !data.id) break;
      useMessageStore.getState().updateMessage(data.channel_id, { ...data, id: data.id });
      {
        const store = useInteractionStore.getState();
        const interactionId = data.interaction?.id;
        if (interactionId) {
          store.handleInteractionResponse(interactionId, {
            type: InteractionCallbackType.UpdateMessage,
          });
        } else {
          // Deferred slash responses are edited without an interaction payload on
          // MESSAGE_UPDATE — clear pending/thinking for this channel.
          for (const [id, interaction] of store.pendingInteractions) {
            if (interaction.channel_id === data.channel_id) {
              store.handleInteractionResponse(id, {
                type: InteractionCallbackType.UpdateMessage,
              });
            }
          }
        }
      }
      break;
    }
    case GatewayEvents.INTERACTION_CREATE: {
      // Bot callbacks for Modal (9) and Autocomplete (8) are dispatched only to
      // the invoking user. Wire them into the interaction store.
      // Prefer `callback_type` (client-normalized); fall back to numeric `type`
      // when the payload is the raw server echo (which uses `type` for the
      // callback kind — distinct from Channel.type on other events).
      const interactionId = data.interaction_id;
      if (!interactionId) break;
      const rawType = data.callback_type ?? data.type;
      const callbackType =
        typeof rawType === 'number' ? (rawType as InteractionCallbackType) : undefined;
      if (callbackType === InteractionCallbackType.Modal && data.data?.title && data.data.custom_id) {
        const store = useInteractionStore.getState();
        const pending = store.pendingInteractions.get(interactionId);
        // Prefer gateway stamp (from interaction token), then pending invoke.
        const channelId = data.channel_id ?? pending?.channel_id;
        const guildId = data.guild_id ?? pending?.guild_id;
        const applicationId = data.application_id ?? pending?.application_id;
        store.handleInteractionResponse(interactionId, {
          type: InteractionCallbackType.Modal,
          data: {
            title: data.data.title,
            custom_id: data.data.custom_id,
            components: data.data.components,
          },
        });
        // Stamp channel/guild/application so ModalSubmit can POST /interactions.
        const modal = useInteractionStore.getState().activeModal;
        if (modal) {
          store.openModal({
            ...modal,
            channelId: modal.channelId ?? channelId,
            guildId: modal.guildId ?? guildId,
            applicationId: modal.applicationId ?? applicationId,
          });
        }
      } else if (callbackType === InteractionCallbackType.ApplicationCommandAutocompleteResult) {
        useInteractionStore.getState().handleInteractionResponse(interactionId, {
          type: InteractionCallbackType.ApplicationCommandAutocompleteResult,
          data: {
            choices: data.data?.choices,
          },
        });
      }
      break;
    }
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
      // Tag the originating server so cross-server unread attribution is correct.
      useGuildStore.getState().addGuild({ ...(data as Guild), originServerId: serverId });
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
      const emojiKey = resolveEmojiKey(data.emoji);
      if (!emojiKey) {
        warnDispatchParseFailure('MESSAGE_REACTION_ADD', 'missing emoji');
        break;
      }
      const currentUserId =
        useServerListStore.getState().getServer(serverId)?.userId ||
        useAuthStore.getState().user?.id ||
        '';
      useMessageStore.getState().handleReactionAdd(
        data.channel_id,
        data.message_id,
        emojiKey,
        data.user_id,
        currentUserId
      );
      break;
    }
    case GatewayEvents.MESSAGE_REACTION_REMOVE: {
      if (!data.channel_id || !data.message_id || !data.user_id) break;
      const emojiKey = resolveEmojiKey(data.emoji);
      if (!emojiKey) {
        warnDispatchParseFailure('MESSAGE_REACTION_REMOVE', 'missing emoji');
        break;
      }
      const currentUserId2 =
        useServerListStore.getState().getServer(serverId)?.userId ||
        useAuthStore.getState().user?.id ||
        '';
      useMessageStore.getState().handleReactionRemove(
        data.channel_id,
        data.message_id,
        emojiKey,
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

    case GatewayEvents.USER_UPDATE: {
      // Profile identity is projected into member lists, cached messages,
      // relationships, and DM titles. Keep all of them live from one event.
      if (!data.user?.id) break;
      const currentUserId = useAuthStore.getState().user?.id;
      if (currentUserId === data.user.id) {
        const current = useAuthStore.getState().user;
        useAuthStore.setState({ user: current ? { ...current, ...data.user } : data.user });
      }
      useMemberStore.getState().updateUserIdentity(data.user);
      useMessageStore.getState().updateUserIdentity(data.user);
      void useRelationshipStore.getState().fetchRelationships();
      void useChannelStore.getState().loadAllDmChannels();
      break;
    }

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

    case GatewayEvents.GUILD_ROLE_CREATE:
    case GatewayEvents.GUILD_ROLE_UPDATE:
    case GatewayEvents.GUILD_ROLE_DELETE:
      window.dispatchEvent(new CustomEvent('paracord:roles-changed', {
        detail: { guild_id: data.guild_id },
      }));
      break;

    case GatewayEvents.GUILD_BAN_ADD:
    case GatewayEvents.GUILD_BAN_REMOVE:
      window.dispatchEvent(new CustomEvent('paracord:bans-changed', {
        detail: { guild_id: data.guild_id },
      }));
      break;

    case GatewayEvents.INVITE_CREATE:
    case GatewayEvents.INVITE_DELETE:
      window.dispatchEvent(new CustomEvent('paracord:invites-changed', {
        detail: { guild_id: data.guild_id },
      }));
      break;

    case GatewayEvents.GUILD_STICKERS_UPDATE:
      window.dispatchEvent(new CustomEvent('paracord:stickers-changed', {
        detail: { guild_id: data.guild_id },
      }));
      break;

    case GatewayEvents.STAGE_INSTANCE_CREATE:
    case GatewayEvents.STAGE_INSTANCE_UPDATE:
    case GatewayEvents.STAGE_INSTANCE_DELETE:
      window.dispatchEvent(new CustomEvent('paracord:stage-instance-changed', {
        detail: {
          guild_id: data.guild_id,
          channel_id: data.channel_id,
        },
      }));
      break;

    case GatewayEvents.GUILD_MEMBER_XP_UPDATE:
      if (!data.guild_id) break;
      window.dispatchEvent(
        new CustomEvent('paracord:guild-member-xp-update', {
          detail: {
            guild_id: data.guild_id,
            user_id: data.user_id,
            xp: (data as { xp?: number }).xp,
            level: (data as { level?: number }).level,
          },
        }),
      );
      {
        // Level/XP activity can unlock progressive channels for the local user.
        const selfUserId =
          useServerListStore.getState().getServer(serverId)?.userId ||
          useAuthStore.getState().user?.id ||
          '';
        const eventUserId = (data as { user_id?: string }).user_id;
        if (selfUserId && eventUserId && eventUserId === selfUserId) {
          refreshGuildChannelVisibility(data.guild_id);
        }
      }
      break;

    case GatewayEvents.SERVER_RESTART:
      useUIStore.getState().setServerRestarting(true);
      break;
  }
}
