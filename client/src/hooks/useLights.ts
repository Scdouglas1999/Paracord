/**
 * The light selectors (docs/lantern-stage-spec.md §1.2, §1.5, §7).
 *
 * This is the ONLY place the stores are read for light. The models and every
 * rule live as pure functions in `src/lib/attention/light.ts` and
 * `src/lib/attention/guildLight.ts`; these hooks just hand them store slices,
 * memoized and account-scoped.
 *
 * Three rules this file exists to keep:
 *
 *  1. **Account-scoped, always.** Every id here is a per-server snowflake, so
 *     every key is `entityScopeKey(scope, id)` and every presence lookup passes
 *     the owning `serverId` as the presence scope. Two servers minting the same
 *     channel id can never bleed light into each other.
 *  2. **Memoized on the narrowest slice.** A guild-scoped hook subscribes to
 *     that guild's slices only. `useBuildingLights` exists because §7.5 needs
 *     the cross-server sweep, and it is the one place that pays for it.
 *  3. **No store shape changes.** Everything is derived. The only new mutable
 *     state in WP1 is `roomLitHistory` — this client's own observation log of
 *     when a room lit up — which is a module record, not a store field.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { registerSessionReset } from '../stores/sessionReset';
import { useTypingStore } from '../stores/typingStore';
import { useVoiceStore } from '../stores/voiceStore';

import { getAccountChannelView } from '../lib/channelView';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../lib/serverScope';
import {
  aroundNowSentence,
  countLightsOn,
  hereNowCaption,
  orderBuildingsByBrightness,
  roomLitHistory,
  type BuildingLight,
  type PersonLight,
  type RoomLight,
} from '../lib/attention/light';
import { guildLight, type LightChannel, type LightMessage } from '../lib/attention/guildLight';
import type { Member } from '../types';
import { useAvailableGuilds } from './useGuilds';
import { useCurrentAccountScope } from './useCurrentUser';
import { useCurrentMessageStore } from './useMessageStore';

// The lit history is this client's own observation log, so it belongs to the
// session exactly like a store does.
registerSessionReset('roomLitHistory', () => roomLitHistory.clear());

const CLOCK_INTERVAL_MS = 1_000;
const NO_MEMBERS: Member[] = [];
const NO_CHANNELS: LightChannel[] = [];
const NO_ROOMS: RoomLight[] = [];
const NO_PEOPLE: PersonLight[] = [];
const NO_MESSAGES: Record<string, LightMessage[]> = {};

/**
 * A 1 Hz clock so a call duration counts up without every light selector
 * re-running on an animation frame. Idle when nothing on screen needs it.
 */
export function useLightClock(active: boolean, intervalMs = CLOCK_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * Is this window actually being looked at? The self-viewing term of the
 * "reading" definition (see `roomLight.ts`) — the one thing a client can know
 * about its own user that it can never know about anybody else.
 */
export function useWindowIsVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);
  return visible;
}

/** The store slices every light hook needs, subscribed once. */
function useLightSources() {
  const presences = usePresenceStore((state) => state.presences);
  const channelParticipants = useVoiceStore((state) => state.channelParticipants);
  const speakingUsers = useVoiceStore((state) => state.speakingUsers);
  const typingByChannel = useTypingStore((state) => state.typingByChannel);
  // Message stores are per account (`getMessageStore`), and hooks cannot be
  // looped over scopes — so the "authored" reading term reads the CURRENT
  // account's loaded timelines only. Background accounts fall back to the
  // typing term, which is exactly what `roomLight.ts` promises: an unloaded
  // channel contributes nothing rather than a guess.
  const messages = useCurrentMessageStore((state) => state.messages) as Record<
    string,
    LightMessage[]
  >;
  const messagesScope = useCurrentAccountScope();
  const messagesScopeKey = messagesScope ? accountScopeKey(messagesScope) : null;
  const selectedChannel = useChannelStore((state) => state.selectedChannel);
  const selfUserId = useAuthStore((state) => state.user?.id ?? null);
  const windowVisible = useWindowIsVisible();
  const nowMs = useLightClock(channelParticipants.size > 0);
  // One stable object, so a light memo keyed on `sources` only re-runs when a
  // slice actually changed rather than on every render of its owner.
  return useMemo(
    () => ({
      presences,
      channelParticipants,
      speakingUsers,
      typingByChannel,
      messages,
      messagesScopeKey,
      selectedChannel,
      selfUserId,
      windowVisible,
      nowMs,
    }),
    [
      presences,
      channelParticipants,
      speakingUsers,
      typingByChannel,
      messages,
      messagesScopeKey,
      selectedChannel,
      selfUserId,
      windowVisible,
      nowMs,
    ],
  );
}

/**
 * `presences` is subscribed for invalidation but read through the store's own
 * per-user index — scanning the whole map per member is what made the old
 * member list O(members × presences).
 */
function statusLookup(serverId: string) {
  const getPresence = usePresenceStore.getState().getPresence;
  return (userId: string) => getPresence(userId, serverId)?.status ?? 'offline';
}

/** One building's light: window map, counts, rooms, caption. */
export function useBuildingLight(guildId: string | null | undefined): BuildingLight | null {
  const scope = useCurrentAccountScope();
  const guild = useGuildStore((state) =>
    scope && guildId
      ? state.guilds.find((entry) => entry.key === entityScopeKey(scope, guildId))
      : undefined,
  );
  const channels = useChannelStore((state) =>
    scope && guildId ? getAccountChannelView(scope, state).channelsByGuild[guildId] : undefined,
  );
  const members = useMemberStore((state) =>
    scope && guildId ? state.members.get(entityScopeKey(scope, guildId)) : undefined,
  );
  const sources = useLightSources();

  return useMemo(() => {
    if (!scope || !guildId || !guild) return null;
    void sources.presences;
    const selected =
      sources.selectedChannel &&
      accountScopeKey(sources.selectedChannel.scope) === accountScopeKey(scope)
        ? sources.selectedChannel.id
        : null;
    return guildLight({
      scope,
      guildId,
      guildName: guild.name,
      icon: guild.icon_hash ?? guild.icon ?? null,
      memberCount: guild.member_count ?? undefined,
      channels: channels ?? NO_CHANNELS,
      members: members ?? NO_MEMBERS,
      channelParticipants: sources.channelParticipants,
      speakingUsers: sources.speakingUsers,
      typingByChannel: sources.typingByChannel,
      messages:
        sources.messagesScopeKey === accountScopeKey(scope) ? sources.messages : NO_MESSAGES,
      getStatus: statusLookup(scope.serverId),
      selfUserId: sources.selfUserId,
      selectedChannelId: selected,
      windowVisible: sources.windowVisible,
      nowMs: sources.nowMs,
    });
  }, [scope, guildId, guild, channels, members, sources]);
}

/** Every room in one building. */
export function useRoomLights(guildId: string | null | undefined): RoomLight[] {
  const building = useBuildingLight(guildId);
  return building?.rooms ?? NO_ROOMS;
}

/** One room's light. */
export function useRoomLight(
  guildId: string | null | undefined,
  channelId: string | null | undefined,
): RoomLight | null {
  const rooms = useRoomLights(guildId);
  return useMemo(
    () => rooms.find((room) => room.channelId === channelId) ?? null,
    [rooms, channelId],
  );
}

/** One building's people, as light. */
export function useBuildingPeople(guildId: string | null | undefined): PersonLight[] {
  const building = useBuildingLight(guildId);
  return useMemo(() => {
    if (!building) return NO_PEOPLE;
    const byId = new Map<string, PersonLight>();
    for (const room of building.rooms) {
      for (const occupant of room.occupants) byId.set(occupant.person.userId, occupant.person);
      for (const reader of room.readers) byId.set(reader.person.userId, reader.person);
    }
    return [...byId.values()];
  }, [building]);
}

/**
 * Every building on every connected server, brightest first (§7.1, §7.5).
 *
 * Reuses the same pure builder as `useBuildingLight`, so a building can never
 * look different on Home than it does in the sidebar.
 */
export function useBuildingLights(): BuildingLight[] {
  const guilds = useAvailableGuilds();
  const channelsByGuild = useChannelStore((state) => state.channelsByGuild);
  const members = useMemberStore((state) => state.members);
  const sources = useLightSources();

  return useMemo(() => {
    void sources.presences;
    const built = guilds.map((guild) => {
      const key = guild.key;
      const selected =
        sources.selectedChannel &&
        accountScopeKey(sources.selectedChannel.scope) === accountScopeKey(guild.scope)
          ? sources.selectedChannel.id
          : null;
      return guildLight({
        scope: guild.scope,
        guildId: guild.id,
        guildName: guild.name,
        icon: guild.icon_hash ?? guild.icon ?? null,
        memberCount: guild.member_count ?? undefined,
        channels: channelsByGuild[key] ?? NO_CHANNELS,
        members: members.get(key) ?? NO_MEMBERS,
        channelParticipants: sources.channelParticipants,
        speakingUsers: sources.speakingUsers,
        typingByChannel: sources.typingByChannel,
        messages:
          sources.messagesScopeKey === accountScopeKey(guild.scope)
            ? sources.messages
            : NO_MESSAGES,
        getStatus: statusLookup(guild.scope.serverId),
        selfUserId: sources.selfUserId,
        selectedChannelId: selected,
        windowVisible: sources.windowVisible,
        nowMs: sources.nowMs,
      });
    });
    return orderBuildingsByBrightness(built);
  }, [guilds, channelsByGuild, members, sources]);
}

/**
 * "+17 lights on" across every building (§7.3).
 *
 * A person visible through two connected servers is two accounts as far as the
 * client can prove, so they are counted per building and summed. When account
 * linking lands, this is the single place that changes.
 */
export function useLightsOnAcrossBuildings(buildings: readonly BuildingLight[]): number {
  return useMemo(
    () => buildings.reduce((total, building) => total + building.lightsOn, 0),
    [buildings],
  );
}

/** The one-sentence "Around now" summary for one building, or for all of them. */
export function useAroundNow(
  buildings: readonly BuildingLight[],
  maxClauses = 3,
  empty?: string,
): string {
  return useMemo(() => {
    const rooms = buildings.flatMap((building) => building.rooms);
    const byId = new Map<string, PersonLight>();
    for (const room of rooms) {
      for (const occupant of room.occupants) byId.set(occupant.person.userId, occupant.person);
      for (const reader of room.readers) byId.set(reader.person.userId, reader.person);
    }
    return aroundNowSentence({ rooms, people: [...byId.values()], maxClauses, empty });
  }, [buildings, maxClauses, empty]);
}

export interface HereNow {
  /** The people in this room right now — occupants, or readers. */
  people: PersonLight[];
  here: number;
  /** How many people in the building have their lights on. */
  lightsOn: number;
  /** "4 here · 20 lights on" — the DOM text equivalent (§9). */
  caption: string;
}

/** The lit strip in a room header (§7.2, §7.4). Never a docked member list. */
export function useHereNow(
  guildId: string | null | undefined,
  channelId: string | null | undefined,
): HereNow {
  const building = useBuildingLight(guildId);
  return useMemo(() => {
    const room = building?.rooms.find((entry) => entry.channelId === channelId) ?? null;
    const present = room
      ? room.kind === 'voice'
        ? room.occupants.map((occupant) => occupant.person)
        : room.readers.map((reader) => reader.person)
      : [];
    const everyone = new Map<string, PersonLight>();
    for (const entry of building?.rooms ?? []) {
      for (const occupant of entry.occupants) everyone.set(occupant.person.userId, occupant.person);
      for (const reader of entry.readers) everyone.set(reader.person.userId, reader.person);
    }
    const lightsOn = building?.lightsOn ?? countLightsOn([...everyone.values()]);
    return {
      people: present,
      here: present.length,
      lightsOn,
      caption: hereNowCaption(present.length, lightsOn),
    };
  }, [building, channelId]);
}

export interface OnAir {
  room: RoomLight | null;
  roomName: string;
  /** Where the room is — "Kestrel Robotics". */
  buildingName: string | null;
  durationMs: number | null;
  micOn: boolean;
  deafened: boolean;
  sharing: boolean;
}

/**
 * The on-air pill's model (§7.7): you are in a room and looking at something
 * else. `MiniVoiceBar` becomes this in WP3.
 */
export function useOnAir(): OnAir | null {
  const scope = useCurrentAccountScope();
  const channelId = useVoiceStore((state) => state.channelId);
  const guildId = useVoiceStore((state) => state.guildId);
  const connected = useVoiceStore((state) => state.connected);
  const selfMute = useVoiceStore((state) => state.selfMute);
  const selfDeaf = useVoiceStore((state) => state.selfDeaf);
  const selfStream = useVoiceStore((state) => state.selfStream);
  const building = useBuildingLight(guildId);
  const channelName = useChannelStore((state) =>
    scope && channelId
      ? (getAccountChannelView(scope, state).channelsById[channelId]?.name ?? null)
      : null,
  );

  return useMemo(() => {
    if (!connected || !channelId) return null;
    const room = building?.rooms.find((entry) => entry.channelId === channelId) ?? null;
    return {
      room,
      roomName: room?.name ?? channelName ?? 'the room',
      buildingName: building?.name ?? null,
      durationMs: room?.durationMs ?? null,
      micOn: !selfMute,
      deafened: selfDeaf,
      sharing: selfStream,
    };
  }, [connected, channelId, building, channelName, selfMute, selfDeaf, selfStream]);
}

/** Test seam: the account key a hook is scoped to. */
export function accountKeyOf(scope: AccountScope | null): string | null {
  return scope ? accountScopeKey(scope) : null;
}
