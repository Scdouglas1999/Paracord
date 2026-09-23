import { getAccountChannelView } from '../lib/channelView';
import { isReadyGuildCore } from '../api/contractValidators';
import { entityScopeKey } from '../lib/serverScope';
import { useGuildStore } from '../stores/guildStore';
import { refreshGuildChannelVisibility, useChannelStore } from '../stores/channelStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useTypingStore } from '../stores/typingStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useUIStore } from '../stores/uiStore';
import { getMessageStore, normalizeIncomingMessage } from '../stores/messageStore';
import { usePollStore } from '../stores/pollStore';
import { getServerUser, getServerAccountScope, mergeServerUserProjection } from '../lib/serverIdentity';
import { useReadStateStore } from '../stores/readStateStore';
import { useInteractionStore } from '../stores/interactionStore';
import { getAccountMessagingRuntime } from '../lib/messages/accountMessagingRuntime';
import { GatewayEvents } from './events';
import { toast } from '../stores/toastStore';
import { sendNotification, isEnabled as notificationsEnabled } from '../lib/features/notifications';
import { messagePreviewText } from '../lib/markdown';
import { fetchGuildRoles } from '../lib/permissionDataCache';
import { extractApiError } from '../api/client';
import {
  effectiveNotificationLevel,
  messageAddressesReader,
  shouldNotifyForMessage,
} from '../lib/features/messageNotifications';
import { useNotificationPreferenceStore } from '../stores/notificationPreferenceStore';
import { accountScopeKey } from '../lib/serverScope';
import { isScoreEvent, scoreAlertText, shouldAlert, sportsLineOnce } from '../components/sports/scoreAlerts';
import { readHideScores } from '../components/sports/model';
import { isSportsScoreAuthor } from '../components/sports/scoreUpdate';
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
    channel_activity?: unknown;
    recovery_required?: boolean;
    message_revisions?: Record<string, string>;
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

function isCompleteMember(data: unknown): data is Member {
  if (!data || typeof data !== 'object') return false;
  const member = data as Partial<Member>;
  return typeof member.user?.id === 'string'
    && typeof member.user.username === 'string'
    && Array.isArray(member.roles) && member.roles.every(role => typeof role === 'string')
    && typeof member.joined_at === 'string'
    && typeof member.deaf === 'boolean' && typeof member.mute === 'boolean';
}

export function dispatchGatewayEvent(serverId: string, event: string, data: GatewayDispatchData, recovered = false): void | Promise<void> {
  const memberScope = getServerAccountScope(serverId);
  const channels = getAccountChannelView(memberScope);
  if (!recovered && memberScope && data.channel_id) {
    if ([GatewayEvents.MESSAGE_CREATE, GatewayEvents.MESSAGE_UPDATE, GatewayEvents.MESSAGE_DELETE].includes(event as never) && data.id) {
      const kind = event === GatewayEvents.MESSAGE_CREATE ? 'create' : event === GatewayEvents.MESSAGE_UPDATE ? 'update' : 'delete';
      const current = getMessageStore(memberScope).getState().messages[data.channel_id]?.find(message => message.id === data.id);
      const message = kind === 'delete' ? undefined : normalizeIncomingMessage({ ...current, ...data }) ?? undefined;
      const runtime = getAccountMessagingRuntime(memberScope); const ownership = runtime.captureGatewayLease();
      return runtime.acceptGatewayMutation({ kind, channelId: data.channel_id, messageId: data.id,
        revision: data.message_revision, message, recoveryRequired: data.recovery_required }).then(authoritative => {
        ownership.assertCurrent();
        if (kind !== 'delete' && !authoritative) return;
        return dispatchGatewayEvent(serverId, event, { ...data, ...authoritative }, true);
      });
    }
    if (event === GatewayEvents.MESSAGE_DELETE_BULK && data.ids?.length) {
      const runtime = getAccountMessagingRuntime(memberScope);
      const ownership = runtime.captureGatewayLease();
      const ids = [...data.ids].sort((a, b) => {
        const left = data.message_revisions?.[a]; const right = data.message_revisions?.[b];
        return left && right ? (BigInt(left) < BigInt(right) ? -1 : 1) : 0;
      });
      return ids.reduce((prior, messageId) => prior.then(async () => { ownership.assertCurrent(); await runtime.acceptGatewayMutation({ kind: 'delete', channelId: data.channel_id!, messageId,
        revision: data.message_revisions?.[messageId], recoveryRequired: data.recovery_required }); }), Promise.resolve())
        .then(() => { ownership.assertCurrent(); return dispatchGatewayEvent(serverId, event, data, true); });
    }
  }
  if (memberScope && ['READY', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE', 'GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE', 'USER_UPDATE'].includes(event)) {
    window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail: memberScope }));
  }
  switch (event) {
    case GatewayEvents.READY: {
      useUIStore.getState().setServerRestarting(false);

      // Pull an authoritative read-state snapshot on every (re)connect so unread
      // and mention badges reconcile after any events missed while offline.
      if (memberScope) void useReadStateStore.getState().refresh(memberScope).catch(() => { /* Per-account refresh errors remain available in the read-state store. */ });

      // READY carries the *public* projection of the account (id, username,
      // avatar, display name) — not private fields like `flags` or `email`.
      // Replacing the store's user therefore used to wipe `flags`, which is how
      // a real server admin lost the admin panel the moment the gateway
      // connected. Merge so the authoritative REST profile survives.
      if (data.user) {
        mergeServerUserProjection(serverId, data.user);
      }

      const readyGuildIds: string[] = [];
      if (data.guilds !== undefined && !Array.isArray(data.guilds)) warnDispatchParseFailure('READY', 'guild list is not an array');
      (Array.isArray(data.guilds) ? data.guilds : []).forEach((g) => {
        // Invalid metadata cannot overwrite a confirmed REST projection. The
        // generated guard shares the six-field core used by both transports.
        const core: unknown = g;
        if (!isReadyGuildCore(core)) { warnDispatchParseFailure('READY', 'guild core contract mismatch'); return; }
        if (!Number.isFinite(Date.parse(core.created_at))) { warnDispatchParseFailure('READY', 'guild invalid created_at'); return; }
        readyGuildIds.push(core.id);
        const normalizedGuild: Guild = {
          id: core.id,
          owner_id: core.owner_id,
          // Tag the TRUE originating server so the cross-server merge reads the
          // right per-server unread/mention bucket (§9 flag 3). server_url alone
          // mis-attributes background-server guilds to the active server.
          originServerId: serverId,
          name: core.name,
          icon_hash: core.icon_hash,
          created_at: core.created_at,
          member_count: core.member_count,
        };
        if (memberScope) useGuildStore.getState().addGuild(normalizedGuild, memberScope);

        const guildChannels = Array.isArray(g.channels) ? g.channels : [];
        if (guildChannels.length > 0) {
          guildChannels.forEach((c) => {
            if (!c.id) {
              warnDispatchParseFailure('READY', 'channel missing id');
              return;
            }
            if (memberScope) channels.addChannel({
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

        }
        if (memberScope) useVoiceStore.getState().loadVoiceStates(g.id, g.voice_states ?? [], memberScope);
        if (g.presences?.length) {
          for (const p of g.presences) {
            usePresenceStore.getState().updatePresence(p, serverId);
          }
        }
      });

      const selected = useGuildStore.getState().selectedGuild;
      const selectedGuildId = memberScope && selected && selected.scope.serverId === serverId && selected.scope.userId === memberScope.userId ? selected.id : null;
      const activeGuildId = selectedGuildId && readyGuildIds.includes(selectedGuildId)
        ? selectedGuildId
        : readyGuildIds[0];
      if (activeGuildId) {
        const channelState = getAccountChannelView(memberScope);
        if (memberScope && !channelState.guildChannelsLoaded[activeGuildId]) {
          void channelState.fetchChannels(activeGuildId);
        }
        const memberState = useMemberStore.getState();
        if (memberScope && !memberState.membersLoaded[entityScopeKey(memberScope, activeGuildId)]) {
          void memberState.fetchMembers(activeGuildId, memberScope);
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

      if (memberScope) return getAccountMessagingRuntime(memberScope).acceptHandshake();
      break;
    }
    case GatewayEvents.RESUMED:
      if (memberScope) return getAccountMessagingRuntime(memberScope).acceptHandshake();
      break;

    case GatewayEvents.MESSAGE_CREATE:
      if (!data.channel_id || !data.id) break;
      // Pass the raw payload: the interaction paths emit `author_id` instead of
      // an `author` object, so asserting `as Message` here was a lie that put an
      // authorless record in the store and crashed the whole feed on render.
      // `addMessage` normalizes and drops anything it cannot make safe.
      if (memberScope) getMessageStore(memberScope).getState().addMessage(data.channel_id, data);
      if (memberScope) useChannelStore.getState().applyMessageActivity(data.channel_id, data.channel_activity, memberScope);
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
      // Desktop notification for messages not from self and not in focused channel
      if (notificationsEnabled()) {
        const currentUserId = getServerUser(serverId)?.id;
        const authorId = data.author?.id ?? data.user_id;
        const focusedChannelId = channels.selectedChannelId;
        const isDocumentFocused = typeof document !== 'undefined' && document.hasFocus();
        // A building you muted, and a room you told to say nothing, must be
        // quiet on the desktop too — this used to consult nothing but the
        // global switch, so the sidebar went silent and the notifications
        // kept coming.
        const preferenceKey = memberScope ? accountScopeKey(memberScope) : null;
        const preferences = useNotificationPreferenceStore.getState();
        const roomSetting = preferenceKey
          ? preferences.channelsByAccount[preferenceKey]?.[data.channel_id]
          : undefined;
        const guildId = channels.channelsById[data.channel_id]?.guild_id;
        const buildingSetting = preferenceKey && guildId
          ? preferences.byAccount[preferenceKey]?.[guildId]
          : undefined;
        const level = effectiveNotificationLevel(roomSetting, buildingSetting);
        const addressesReader = messageAddressesReader(
          data,
          currentUserId,
          Boolean(roomSetting?.suppress_everyone ?? buildingSetting?.suppress_everyone),
        );
        // A Sports post is a score: it keeps quiet for someone hiding scores,
        // and it is said once when a score alert carries the same sentence.
        const sportsPost = Boolean(data.author && isSportsScoreAuthor(data.author));
        if (
          authorId !== currentUserId &&
          !(isDocumentFocused && focusedChannelId === data.channel_id) &&
          shouldNotifyForMessage(level, addressesReader) &&
          !(sportsPost && (readHideScores() || !sportsLineOnce(data.content || '')))
        ) {
          const channelName = channels.channelsById[data.channel_id]?.name;
          const authorName = data.author?.username ?? 'Someone';
          const title = channelName ? `#${channelName}` : `DM from ${authorName}`;
          const names = currentUserId ? new Map([[currentUserId, 'you']]) : undefined;
          const raw = data.content || '';
          if (!data.e2ee && guildId && /<@&\d+>/.test(raw)) {
            void fetchGuildRoles(guildId, memberScope ?? undefined)
              .then((roles) => {
                const body = messagePreviewText(raw, names, new Map(roles.map((role) => [role.id, role.name]))).slice(0, 200) || '(attachment)';
                void sendNotification(title, body);
              })
              .catch((err) => {
                void sendNotification(title, extractApiError(err));
              });
          } else {
            const body = data.e2ee
              ? '[Encrypted message]'
              : messagePreviewText(raw, names).slice(0, 200) || '(attachment)';
            void sendNotification(title, body);
          }
        }
      }
      if (!recovered && memberScope && data.e2ee) {
        const message = normalizeIncomingMessage(data);
        if (!message) return Promise.reject(new Error('The encrypted message envelope has no verifiable author.'));
        return getAccountMessagingRuntime(memberScope).ingestEncryptedMessage(message);
      }
      break;
    case GatewayEvents.SPORTS_SCORE: {
      // A score in a favorite team's game, sent by a server with alerts on.
      if (!isScoreEvent(data)) break;
      const preferenceKey = memberScope ? accountScopeKey(memberScope) : null;
      const serverSetting = preferenceKey
        ? useNotificationPreferenceStore.getState().byAccount[preferenceKey]?.[data.guild_id]
        : undefined;
      const serverMuted = effectiveNotificationLevel(undefined, serverSetting) === 2;
      if (shouldAlert(data, { serverMuted }) && sportsLineOnce(data.content)) {
        const { title, body } = scoreAlertText(data);
        void sendNotification(title, body);
      }
      break;
    }
    case GatewayEvents.MESSAGE_MENTION:
      // The server targets actual recipients. Replayed events only refresh an
      // authoritative count; message text never grants mention permission.
      if (memberScope) useReadStateStore.getState().refreshAfterEvent(memberScope);
      break;
    case GatewayEvents.MESSAGE_UPDATE: {
      if (!data.channel_id || !data.id) break;
      if (memberScope) {
        getMessageStore(memberScope).getState().updateMessage(data.channel_id, { ...data, id: data.id });
        useReadStateStore.getState().invalidateAttention(memberScope, data.channel_id);
      }
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
      if (!recovered && memberScope && data.e2ee) {
        const current = getMessageStore(memberScope).getState().messages[data.channel_id]?.find(message => message.id === data.id);
        const message = normalizeIncomingMessage({ ...current, ...data });
        if (!message) return Promise.reject(new Error('The encrypted message envelope has no verifiable author.'));
        return getAccountMessagingRuntime(memberScope).ingestEncryptedMessage(message);
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
      if (memberScope) {
        getMessageStore(memberScope).getState().removeMessage(data.channel_id, data.id);
        useChannelStore.getState().applyMessageActivity(data.channel_id, data.channel_activity, memberScope);
        useReadStateStore.getState().invalidateAttention(memberScope, data.channel_id);
        useReadStateStore.getState().refreshAfterEvent(memberScope);
        if (!recovered) return getAccountMessagingRuntime(memberScope).observeDeleted(data.channel_id, data.id);
      }
      break;
    case GatewayEvents.MESSAGE_DELETE_BULK:
      if (data.channel_id && data.ids?.length) {
        if (memberScope) {
          getMessageStore(memberScope).getState().removeMessages(data.channel_id, data.ids);
          useChannelStore.getState().applyMessageActivity(data.channel_id, data.channel_activity, memberScope);
          useReadStateStore.getState().invalidateAttention(memberScope, data.channel_id);
          useReadStateStore.getState().refreshAfterEvent(memberScope);
          if (!recovered) {
            const runtime = getAccountMessagingRuntime(memberScope);
            return data.ids.reduce((previous, id) => previous.then(() => runtime.observeDeleted(data.channel_id!, id)), Promise.resolve());
          }
        }
      }
      break;

    case GatewayEvents.GUILD_CREATE:
      // Tag the originating server so cross-server unread attribution is correct.
      if (memberScope) useGuildStore.getState().addGuild(data as Guild, memberScope);
      break;
    case GatewayEvents.GUILD_UPDATE:
      if (!data.id) break;
      if (memberScope) useGuildStore.getState().updateGuildData(data.id, data as Partial<Guild>, memberScope);
      break;
    case GatewayEvents.GUILD_DELETE:
      if (!data.id) break;
      if (memberScope) useGuildStore.getState().removeGuild(data.id, memberScope);
      break;

    case GatewayEvents.CHANNEL_CREATE:
      if (memberScope) channels.addChannel(data as Channel);
      break;
    case GatewayEvents.CHANNEL_UPDATE:
      if (memberScope) {
        channels.updateChannel(data as Channel);
        // A permission overwrite moving sends CHANNEL_UPDATE carrying only the
        // channel's id — it is the server saying "what you can do in this room
        // changed", and it is the only notice somebody who just lost
        // VIEW_CHANNEL gets. Re-ask for the rooms this account can see (the
        // refresh is debounced, so a burst of overwrite edits costs one
        // request); a room that comes back missing leaves the screen instead of
        // sitting there with a working-looking composer.
        const guildId =
          data.guild_id ?? channels.channelsById[String(data.id ?? '')]?.guild_id ?? null;
        refreshGuildChannelVisibility(guildId, memberScope);
      }
      break;
    case GatewayEvents.CHANNEL_DELETE:
      if (!data.id) break;
      if (memberScope) channels.removeChannel(data.guild_id ?? '', data.id);
      break;

    case GatewayEvents.THREAD_CREATE:
      if (!data.id) break;
      if (memberScope) channels.addChannel({
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
      if (memberScope) channels.updateChannel({
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
      const guildId = data.guild_id ?? channels.channelsById[data.id]?.guild_id;
      if (memberScope && guildId) channels.removeChannel(guildId, data.id);
      break;
    }

    case GatewayEvents.GUILD_MEMBER_ADD:
      if (!data.guild_id) break;
      if (isCompleteMember(data)) {
        if (memberScope) useMemberStore.getState().addMember(data.guild_id, data, memberScope);
      } else {
        if (memberScope) void useMemberStore.getState().fetchMembers(data.guild_id, memberScope);
      }
      break;
    case GatewayEvents.GUILD_MEMBER_REMOVE:
      if (!data.guild_id) break;
      {
        const targetUserId = data.user?.id ?? data.user_id;
        if (targetUserId) {
          if (memberScope) useMemberStore.getState().removeMember(data.guild_id, targetUserId, memberScope);
        } else {
          if (memberScope) void useMemberStore.getState().fetchMembers(data.guild_id, memberScope);
        }
      }
      break;
    case GatewayEvents.GUILD_MEMBER_UPDATE:
      if (!data.guild_id) break;
      if (data.user?.id) {
        if (memberScope) useMemberStore.getState().updateMember(
          data.guild_id,
          data as Partial<Member> & { user: { id: string } },
          memberScope,
        );
      } else {
        if (memberScope) void useMemberStore.getState().fetchMembers(data.guild_id, memberScope);
      }
      break;

    case GatewayEvents.PRESENCE_UPDATE:
      usePresenceStore.getState().updatePresence(data as Presence, serverId);
      break;

    case GatewayEvents.VOICE_STATE_UPDATE:
      if (memberScope) useVoiceStore.getState().handleVoiceStateUpdate(data as VoiceState, memberScope);
      break;

    case GatewayEvents.MESSAGE_REACTION_ADD: {
      if (!data.channel_id || !data.message_id || !data.user_id) break;
      const emojiKey = resolveEmojiKey(data.emoji);
      if (!emojiKey) {
        warnDispatchParseFailure('MESSAGE_REACTION_ADD', 'missing emoji');
        break;
      }
      const currentUserId =
        getServerUser(serverId)?.id ?? '';
      if (memberScope) getMessageStore(memberScope).getState().handleReactionAdd(
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
        getServerUser(serverId)?.id ?? '';
      if (memberScope) getMessageStore(memberScope).getState().handleReactionRemove(
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
        if (memberScope) getMessageStore(memberScope).getState().fetchPins(data.channel_id);
      }
      break;

    case GatewayEvents.TYPING_START:
      if (data.channel_id && data.user_id) {
        useTypingStore.getState().addTyping(data.channel_id, data.user_id);
      }
      break;

    // The author stopped composing. Without this the indicator could only be
    // waited out, so it survived the message it was announcing.
    case GatewayEvents.TYPING_STOP:
      if (data.channel_id && data.user_id) {
        useTypingStore.getState().removeTyping(data.channel_id, data.user_id);
      }
      break;

    case GatewayEvents.USER_UPDATE: {
      // Profile identity is projected into member lists, cached messages,
      // relationships, and DM titles. Keep all of them live from one event.
      if (!data.user?.id) break;
      const updatedUserId = data.user.id;
      const currentUserId = getServerUser(serverId)?.id;
      const isSelf = currentUserId === updatedUserId;
      if (isSelf) {
        mergeServerUserProjection(serverId, data.user);
      }
      // These two are cheap and self-limiting — they bail internally when the
      // user owns nothing cached.
      if (memberScope) useMemberStore.getState().updateUserIdentity(data.user, memberScope);
      if (memberScope) getMessageStore(memberScope).getState().updateUserIdentity(data.user);

      // The refetches below are not cheap: `loadAllDmChannels` hits every
      // connected server. Firing both on every profile edit by anyone visible
      // meant a busy guild produced a steady stream of full DM + relationship
      // reloads. Only refetch when this user can actually appear in that data.
      const isKnownRelationship = useRelationshipStore
        .getState()
        .relationships.some((relationship) => relationship.user?.id === updatedUserId);
      const isDmRecipient = [channels.channelsByGuild[''] ?? []].some(
        (channels) =>
          channels.some(
            (channel) =>
              channel.recipient?.id === updatedUserId ||
              channel.recipients?.some((recipient) => recipient.id === updatedUserId),
          ),
      );
      if (isSelf || isKnownRelationship) {
        void useRelationshipStore.getState().fetchRelationships();
      }
      if (isSelf || isDmRecipient) {
        if (memberScope) void useChannelStore.getState().fetchDmChannels(memberScope);
      }
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
          getServerUser(serverId)?.id ?? '';
        const eventUserId = (data as { user_id?: string }).user_id;
        if (selfUserId && eventUserId && eventUserId === selfUserId) {
          if (memberScope) refreshGuildChannelVisibility(data.guild_id, memberScope);
        }
      }
      break;

    case GatewayEvents.REMINDER_FIRED:
      void import('../lib/reminderNotify')
        .then(({ presentReminderFired }) => presentReminderFired(memberScope, data))
        .catch((err: unknown) => {
          toast.error(`A reminder arrived but could not be shown: ${err instanceof Error ? err.message : String(err)}`);
        });
      break;

    case GatewayEvents.SERVER_RESTART:
      useUIStore.getState().setServerRestarting(true);
      break;
  }
}
