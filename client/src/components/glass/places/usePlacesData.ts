import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router';

import { useChannelPreviews } from '../../../hooks/useChannelPreviews';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnreadCounts } from '../../../hooks/useUnreadCounts';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import type { BuildingLight, RoomLight } from '../../../lib/attention/light';
import { accountScopeKey, entityScopeKey } from '../../../lib/serverScope';
import { displayName } from '../../../lib/displayName';
import type { Channel } from '../../../types';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useNotificationPreferenceStore } from '../../../stores/notificationPreferenceStore';
import { EMPTY_READ_STATES, useReadStateStore } from '../../../stores/readStateStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useUpcomingEvents, type HomeEvent } from '../../rooms/lobby/useUpcomingEvents';
import type { FaceModel, PreviewContext } from './model';
import { orderChannels } from './model';
import { buildChannelRows, attentionOf, type ChannelRowModel } from './rows';
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

  const readStates = useReadStateStore((state) => (scopeKey ? state.byAccount[scopeKey] : undefined)) ?? EMPTY_READ_STATES;
  const roomSettings = useNotificationPreferenceStore((state) => (scopeKey ? state.channelsByAccount[scopeKey] : undefined));
  const { mutedGuildKeys } = useMutedGuilds();
  const guildMuted = Boolean(guildKey) && mutedGuildKeys.includes(guildKey as string);
  const mutedChannelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [channelId, setting] of Object.entries(roomSettings ?? {})) {
      if (setting.muted_now || setting.level === 2) ids.add(channelId);
    }
    return ids;
  }, [roomSettings]);

  const members = useMemberStore((state) => (guildKey ? state.members.get(guildKey) : undefined));
  const { people, memberNames } = useMemo(() => {
    const faces = new Map<string, FaceModel>();
    const names = new Map<string, string>();
    for (const member of members ?? []) {
      const name = displayName(member.user, member.nick);
      faces.set(member.user.id, { userId: member.user.id, name, avatar: member.user.avatar_hash ?? null });
      names.set(member.user.id, name);
    }
    return { people: faces, memberNames: names };
  }, [members]);

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

/* ---- Home ---------------------------------------------------------------------- */

export function useHomeConversations() {
  const { mutedGuildKeys } = useMutedGuilds();
  return useUnifiedConversations(mutedGuildKeys);
}
