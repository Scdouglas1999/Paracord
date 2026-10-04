import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router';

import { useStore } from 'zustand';

import { previewFromMessage, useChannelPreviews, type ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { useCurrentMessageStoreApi } from '../../../hooks/useMessageStore';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnreadCounts } from '../../../hooks/useUnreadCounts';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import type { BuildingLight, RoomLight } from '../../../lib/attention/light';
import { accountScopeKey, entityScopeKey } from '../../../lib/serverScope';
import { displayName } from '../../../lib/displayName';
import type { Channel, Message, VoiceState } from '../../../types';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useNotificationPreferenceStore } from '../../../stores/notificationPreferenceStore';
import { ENCRYPTED_DM_PLACEHOLDER } from '../../../stores/messageStore';
import { EMPTY_READ_STATES, useReadStateStore } from '../../../stores/readStateStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useUpcomingEvents, type HomeEvent } from '../../rooms/lobby/useUpcomingEvents';
import type { FaceModel, PreviewContext } from './model';
import { isPlaceChannel, isVoiceChannel, orderChannels } from './model';
import {
  attentionOf,
  buildChannelRows,
  buildSidebarGroups,
  buildSidebarRooms,
  type ChannelRowModel,
  type RoomOccupant,
  type SidebarGroup,
  type SidebarRoom,
} from './rows';
import type { ServerCircle } from './ServerRow';
import { unreadKey, useUnreadMessageCounts, type UnreadTarget } from './useUnreadMessageCounts';

/**
 * What the places panel reads from the app's stores (docs/glass-spec.md §3.1).
 * Read-only: every store here is used as data, and every rule about what a row
 * says lives in `model.ts` and `rows.ts`, where it is tested without React.
 */

/** Where the route puts you: inside a server, or in Home (Home, Messages, Friends). */
export function usePlacesRoute() {
  const { guildId, channelId } = useParams();
  const { pathname } = useLocation();
  return { guildId: guildId ?? null, channelId: channelId ?? null, pathname, mode: guildId ? ('server' as const) : ('home' as const) };
}

/** `Date.now()`, refreshed once a minute: enough for "LIVE 42 MIN" and a row's time. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/* ---- The server row ---------------------------------------------------------- */

export function useServerCircles(currentGuildId: string | null, buildings: readonly BuildingLight[]) {
  const scope = useCurrentAccountScope();
  const guilds = useAvailableGuilds();
  const { mutedGuildKeys } = useMutedGuilds();
  const { guildUnreads } = useUnreadCounts(mutedGuildKeys);

  return useMemo<ServerCircle[]>(() => {
    const lights = new Map(buildings.map((building) => [building.key, building]));
    const scopeKey = scope ? accountScopeKey(scope) : null;
    return guilds.map((guild) => {
      const light = lights.get(guild.key);
      const unread = guildUnreads.get(guild.key);
      return {
        key: guild.key,
        scope: guild.scope,
        guildId: guild.id,
        name: guild.name,
        icon: guild.icon_hash ?? guild.icon ?? null,
        current: Boolean(currentGuildId) && guild.id === currentGuildId && scopeKey === accountScopeKey(guild.scope),
        live: Boolean(light?.rooms.some((room) => room.kind === 'voice' && room.lit)),
        mentions: unread?.mentionCount ?? 0,
        unreadChannels: unread?.unreadCount ?? 0,
      };
    });
  }, [guilds, buildings, guildUnreads, currentGuildId, scope]);
}

/* ---- Shared by the Glass panel and the Index sidebar ---------------------------- */

const NO_MUTED = new Set<string>();

/** Read positions, muted channels and whether the whole server is muted, for one account's server. */
function useChannelAttention(scopeKey: string | null, guildKey: string | null) {
  const readStates = useReadStateStore((state) => (scopeKey ? state.byAccount[scopeKey] : undefined)) ?? EMPTY_READ_STATES;
  const roomSettings = useNotificationPreferenceStore((state) => (scopeKey ? state.channelsByAccount[scopeKey] : undefined));
  const { mutedGuildKeys } = useMutedGuilds();
  const guildMuted = Boolean(guildKey) && mutedGuildKeys.includes(guildKey as string);
  const mutedChannelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [channelId, setting] of Object.entries(roomSettings ?? {})) {
      if (setting.muted_now || setting.level === 2) ids.add(channelId);
    }
    return ids.size === 0 ? NO_MUTED : ids;
  }, [roomSettings]);
  return { readStates, mutedChannelIds, guildMuted };
}

/** The server's people by id: a face for each, and the name a mention of them reads as. */
function useServerPeople(guildKey: string | null) {
  const members = useMemberStore((state) => (guildKey ? state.members.get(guildKey) : undefined));
  return useMemo(() => {
    const faces = new Map<string, FaceModel>();
    const names = new Map<string, string>();
    for (const member of members ?? []) {
      const name = displayName(member.user, member.nick);
      faces.set(member.user.id, { userId: member.user.id, name, avatar: member.user.avatar_hash ?? null });
      names.set(member.user.id, name);
    }
    return { people: faces, memberNames: names, members };
  }, [members]);
}

/* ---- One server ---------------------------------------------------------------- */

const NO_CHANNELS: Channel[] = [];

/** The unread state that decides whether a channel needs counting. */
function countTargets(
  channels: readonly Channel[],
  readStates: Record<string, { last_message_id: string; mention_count: number } | undefined>,
  muted: (channelId: string) => boolean,
  scope: ReturnType<typeof useCurrentAccountScope>,
  openChannelId: string | null,
): UnreadTarget[] {
  if (!scope) return [];
  const targets: UnreadTarget[] = [];
  for (const channel of channels) {
    const readState = readStates[channel.id] as Parameters<typeof attentionOf>[1];
    const { unread, mentions } = attentionOf(channel, readState);
    // A mention has its own badge, a muted channel has none, and the channel you
    // are reading is about to be read: none of them is worth a request.
    if (!unread || mentions > 0 || muted(channel.id) || channel.id === openChannelId || !channel.last_message_id) continue;
    targets.push({ channelId: channel.id, scope, cursor: readState?.last_message_id || null, tail: channel.last_message_id });
  }
  return targets;
}

/** Whether the server's channel list is in: rows, still coming, could not be read, or none. */
export type ChannelListStatus = 'ready' | 'loading' | 'error' | 'empty';

export interface ServerPlaces {
  rows: ChannelRowModel[];
  listStatus: ChannelListStatus;
  listError: string | null;
  channels: readonly Channel[];
  rooms: ReadonlyMap<string, RoomLight>;
  events: HomeEvent[];
  eventRoomName: (event: HomeEvent) => string | null;
  nowMs: number;
  selfUserId: string | null;
}

export function useServerPlaces(guildId: string, building: BuildingLight | null, selectedChannelId: string | null): ServerPlaces {
  const scope = useCurrentAccountScope();
  const scopeKey = scope ? accountScopeKey(scope) : null;
  const guildKey = scope ? entityScopeKey(scope, guildId) : null;
  const nowMs = useMinuteClock();

  const stored = useChannelStore((state) => (guildKey ? state.channelsByGuild[guildKey] : undefined)) ?? NO_CHANNELS;
  const listLoaded = useChannelStore((state) => Boolean(guildKey && state.guildChannelsLoaded[guildKey]));
  const listError = useChannelStore((state) => (guildKey ? state.errors[guildKey] ?? null : null));
  const channels = useMemo(() => orderChannels(stored), [stored]);
  const channelNames = useMemo(() => new Map(stored.map((channel) => [channel.id, channel.name ?? ''])), [stored]);

  const previews = useChannelPreviews(guildId, scope, channels);

  const { readStates, mutedChannelIds, guildMuted } = useChannelAttention(scopeKey, guildKey);
  const { people, memberNames } = useServerPeople(guildKey);

  const targets = useMemo(
    () => countTargets(channels, readStates, (id) => guildMuted || mutedChannelIds.has(id), scope, selectedChannelId),
    [channels, readStates, guildMuted, mutedChannelIds, scope, selectedChannelId],
  );
  const countsByKey = useUnreadMessageCounts(targets);
  // Rows are one server's channels, so they are looked up by channel id alone.
  const counts = useMemo(
    () => new Map(targets.map((target) => [target.channelId, countsByKey.get(unreadKey(target.scope, target.channelId)) ?? null])),
    [targets, countsByKey],
  );

  const channelParticipants = useVoiceStore((state) => state.channelParticipants);
  const rooms = useMemo(
    () => new Map((building?.rooms ?? []).map((room) => [room.channelId, room])),
    [building],
  );

  // The server's calendar, for "Coming up" and for the name a shared event has in a
  // preview (`<event:id>` reads as "Movie night" when the calendar has it).
  const { events } = useUpcomingEvents(guildId);
  const eventNames = useMemo(() => new Map(events.map((event) => [event.id, event.name])), [events]);

  const selfUserId = scope?.userId ?? null;
  const context = useMemo<PreviewContext>(
    () => ({ selfUserId, memberNames, channelNames, eventNames }),
    [selfUserId, memberNames, channelNames, eventNames],
  );

  const rows = useMemo(
    () =>
      buildChannelRows({
        guildId,
        channels,
        rooms,
        previews: previews.previews,
        previewError: previews.status === 'error' ? previews.error : null,
        recentAuthors: previews.recentAuthors,
        readStates,
        mutedChannelIds,
        guildMuted,
        people,
        counts,
        context,
        selectedChannelId,
        nowMs,
        // The wire will carry when a stream began (`self_stream_started_at`,
        // glass-plan §3). Until it does there is no start time, and the kicker
        // says "LIVE" and nothing it cannot back.
        streamStartedAt: (channelId, userId) => {
          const state = channelParticipants.get(channelId)?.find((entry) => entry.user_id === userId);
          const started = (state as { self_stream_started_at?: string | null } | undefined)?.self_stream_started_at;
          return typeof started === 'string' ? started : null;
        },
      }),
    [guildId, channels, rooms, previews, readStates, mutedChannelIds, guildMuted, people, counts, context, selectedChannelId, nowMs, channelParticipants],
  );

  const eventRoomName = useMemo(
    () => (event: HomeEvent) => (event.channelId ? channelNames.get(event.channelId) || null : null),
    [channelNames],
  );

  const listStatus: ChannelListStatus =
    channels.length > 0 ? 'ready' : listError ? 'error' : listLoaded ? 'empty' : 'loading';

  return { rows, listStatus, listError, channels, rooms, events, eventRoomName, nowMs, selfUserId };
}

/* ---- The Index sidebar's server ------------------------------------------------- */

/**
 * A preview whose message is end-to-end encrypted, replaced by what this client
 * already read of it (`message.e2ee` with its decrypted content in the message
 * store), when it has (index-spec §4.5). Nothing is decrypted here: the store
 * only holds text it decrypted for a conversation that was open. An unread one
 * stays encrypted and the row says "Encrypted".
 */
export function withLocalDecryption(
  previews: ReadonlyMap<string, ChannelPreviewEntry>,
  messages: Readonly<Record<string, readonly Message[] | undefined>>,
): ReadonlyMap<string, ChannelPreviewEntry> {
  let result: Map<string, ChannelPreviewEntry> | null = null;
  for (const [channelId, entry] of previews) {
    if (!entry.encrypted) continue;
    const message = messages[channelId]?.find((candidate) => candidate.id === entry.messageId);
    const text = message?.content;
    if (message?.e2ee && typeof text === 'string' && text.trim() && text !== ENCRYPTED_DM_PLACEHOLDER) {
      result ??= new Map(previews);
      result.set(channelId, { ...previewFromMessage(message), encrypted: false, content: text });
    }
  }
  return result ?? previews;
}

export interface ServerSidebar {
  listStatus: ChannelListStatus;
  listError: string | null;
  /** The text-like channels in groups (uncategorized first), with their lines. */
  groups: SidebarGroup[];
  /** Every voice and stage channel (the pane leaves out the one the live card shows). */
  rooms: SidebarRoom[];
  /**
   * Who is in the server, for the header's line: how many members the roster
   * holds, how many of them are online ("here now": online, not idle or
   * away), and whether the roster has arrived at all (before it has, the
   * line claims no one is here).
   */
  roster: { known: boolean; size: number; here: number };
  /** Every channel the store holds for the server (categories and threads too). */
  channels: readonly Channel[];
  events: HomeEvent[];
  eventRoomName: (event: HomeEvent) => string | null;
  nowMs: number;
  selfUserId: string | null;
}

/**
 * Who is in each voice room of one server, from the voice store: the people who
 * joined (a listener is not in the room), the streamer first, then in the order
 * they came in. Keyed by channel id; a room nobody is in has no entry.
 */
export function roomOccupancy(
  channels: readonly Channel[],
  channelParticipants: ReadonlyMap<string, readonly VoiceState[]>,
  guildId: string,
  nameOf: (userId: string) => string | undefined,
): Map<string, RoomOccupant[]> {
  const byRoom = new Map<string, RoomOccupant[]>();
  for (const channel of channels) {
    if (!isVoiceChannel(channel.type)) continue;
    // One map holds every connected server's rooms, keyed by the bare channel id.
    const states = (channelParticipants.get(channel.id) ?? []).filter(
      (state) => state.guild_id === guildId && state.mode !== 'listen',
    );
    if (states.length === 0) continue;
    const ordered = [...states].sort(
      (a, b) =>
        Number(b.self_stream) - Number(a.self_stream)
        || (a.joined_at ?? '').localeCompare(b.joined_at ?? '')
        || a.user_id.localeCompare(b.user_id, undefined, { numeric: true }),
    );
    byRoom.set(
      channel.id,
      ordered.map((state) => ({
        userId: state.user_id,
        // The member list can lag a join by a beat; the voice state always carries enough to name them.
        name: nameOf(state.user_id) ?? displayName({ username: state.username ?? '', display_name: state.display_name }),
        avatar: state.avatar_hash ?? null,
        sharingScreen: Boolean(state.self_stream),
      })),
    );
  }
  return byRoom;
}

/**
 * Everything the Index sidebar shows for one server (docs/index-spec.md §4.1,
 * §4.5-4.7), from the stores. `guildId` is the pane's own place, never the
 * route's, and `selectedChannelId` is the channel to mark as open (null for a
 * pane that is sliding out, which keeps what it showed).
 *
 * Unlike the Glass panel it asks nothing about exact unread counts: an unread
 * channel is a dot and a mention is the read state's own count.
 */
export function useServerSidebar(guildId: string, selectedChannelId: string | null): ServerSidebar {
  const scope = useCurrentAccountScope();
  const scopeKey = scope ? accountScopeKey(scope) : null;
  const guildKey = scope ? entityScopeKey(scope, guildId) : null;
  const nowMs = useMinuteClock();

  const stored = useChannelStore((state) => (guildKey ? state.channelsByGuild[guildKey] : undefined)) ?? NO_CHANNELS;
  const listLoaded = useChannelStore((state) => Boolean(guildKey && state.guildChannelsLoaded[guildKey]));
  const listError = useChannelStore((state) => (guildKey ? state.errors[guildKey] ?? null : null));
  const membersLoaded = useMemberStore((state) => Boolean(guildKey && state.membersLoaded[guildKey]));
  const channelNames = useMemo(() => new Map(stored.map((channel) => [channel.id, channel.name ?? ''])), [stored]);
  // Previews are asked for the text-like channels only; Rooms show who is in them.
  const textLike = useMemo(
    () => stored.filter((channel) => isPlaceChannel(channel.type) && !isVoiceChannel(channel.type)),
    [stored],
  );
  const previews = useChannelPreviews(guildId, scope, textLike);
  const messageStore = useCurrentMessageStoreApi();
  const messages = useStore(messageStore, (state) => state.messages);
  const shownPreviews = useMemo(() => withLocalDecryption(previews.previews, messages), [previews.previews, messages]);

  const { readStates, mutedChannelIds, guildMuted } = useChannelAttention(scopeKey, guildKey);
  const { memberNames, members } = useServerPeople(guildKey);

  // Who is in which room, and who is here now: read from the voice and presence stores directly.
  // (The Glass light hooks tick once a second while anybody is in a call and follow every typing
  // event; a sidebar that shows a count and three faces needs neither.)
  const channelParticipants = useVoiceStore((state) => state.channelParticipants);
  const presences = usePresenceStore((state) => state.presences);
  const occupancy = useMemo(
    () => roomOccupancy(stored, channelParticipants, guildId, (userId) => memberNames.get(userId)),
    [stored, channelParticipants, guildId, memberNames],
  );
  const hereNow = useMemo(() => {
    void presences;
    if (!scope) return 0;
    const getPresence = usePresenceStore.getState().getPresence;
    let count = 0;
    for (const member of members ?? []) {
      const status = getPresence(member.user.id, scope.serverId)?.status;
      if (status === 'online') count += 1;
    }
    return count;
  }, [members, presences, scope]);

  const { events } = useUpcomingEvents(guildId);
  const eventNames = useMemo(() => new Map(events.map((event) => [event.id, event.name])), [events]);
  const eventTimes = useMemo(
    () => new Map(events.map((event) => [event.id, { name: event.name, startsAt: event.startsAt }])),
    [events],
  );

  const selfUserId = scope?.userId ?? null;
  const context = useMemo<PreviewContext>(
    () => ({ selfUserId, memberNames, channelNames, eventNames, events: eventTimes, nowMs }),
    [selfUserId, memberNames, channelNames, eventNames, eventTimes, nowMs],
  );

  const groups = useMemo(
    () =>
      buildSidebarGroups({
        channels: stored,
        previews: shownPreviews,
        previewStatus: previews.status,
        readStates,
        mutedChannelIds,
        guildMuted,
        context,
        selectedChannelId,
        nowMs,
      }),
    [stored, shownPreviews, previews.status, readStates, mutedChannelIds, guildMuted, context, selectedChannelId, nowMs],
  );

  const rooms = useMemo(() => buildSidebarRooms(stored, occupancy), [stored, occupancy]);

  const eventRoomName = useMemo(
    () => (event: HomeEvent) => (event.channelId ? channelNames.get(event.channelId) || null : null),
    [channelNames],
  );

  const hasRows = groups.length > 0 || stored.some((channel) => isVoiceChannel(channel.type));
  const listStatus: ChannelListStatus = hasRows ? 'ready' : listError ? 'error' : listLoaded ? 'empty' : 'loading';

  return {
    listStatus,
    listError,
    groups,
    rooms,
    roster: { known: listLoaded && membersLoaded, size: members?.length ?? 0, here: hereNow },
    channels: stored,
    events,
    eventRoomName,
    nowMs,
    selfUserId,
  };
}

/* ---- Home ---------------------------------------------------------------------- */

export function useHomeConversations() {
  const { mutedGuildKeys } = useMutedGuilds();
  return useUnifiedConversations(mutedGuildKeys);
}
