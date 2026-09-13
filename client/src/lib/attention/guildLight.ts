/**
 * One building, assembled from the raw store shapes
 * (docs/lantern-stage-spec.md §7.1, §7.3, §7.5).
 *
 * This is the seam between the stores and the light models: it takes the plain
 * data a gateway session produces (members, channels, voice states, typing,
 * loaded messages, presence) and returns the {@link BuildingLight} the sidebar,
 * the Lobby and Home all render. It is a **pure function** — every ambient thing
 * it needs (the clock, presence lookup, the lit history) is injected — so the
 * whole derivation is unit-testable without React or a live store.
 *
 * `src/hooks/useLights.ts` is the only caller; it supplies the store slices.
 */

import { displayName } from '../displayName';
import { entityScopeKey, type AccountScope } from '../serverScope';
import type { PresenceStatus } from '../presence';
import { ChannelType, type Member, type VoiceState } from '../../types';
import { buildingLight } from './buildingLight';
import { roomLitHistory, type LitHistory } from './litHistory';
import { personLight } from './personLight';
import {
  RECENT_AUTHOR_LIMIT,
  textRoomLight,
  voiceRoomLight,
  type RecentAuthorSample,
} from './roomLight';
import type { BuildingLight, PersonLight, RoomLight } from './lightModel';

/** Only the channel fields the light derivation reads. */
export interface LightChannel {
  id: string;
  type: ChannelType;
  name?: string | null;
  position?: number;
}

/** Only the message fields the "authored" reading term reads. */
export interface LightMessage {
  id: string;
  author?: { id: string } | null;
}

export interface GuildLightInput {
  scope: AccountScope;
  guildId: string;
  guildName: string;
  icon?: string | null;
  memberCount?: number;

  channels: readonly LightChannel[];
  members: readonly Member[];
  /** Voice states, keyed by the BARE channel id exactly as `voiceStore` holds them. */
  channelParticipants: ReadonlyMap<string, VoiceState[]>;
  speakingUsers: ReadonlySet<string>;
  typingByChannel: Readonly<Record<string, readonly string[]>>;
  messages: Readonly<Record<string, readonly LightMessage[]>>;

  /** Presence lookup, already bound to this account's presence scope. */
  getStatus: (userId: string) => PresenceStatus | null | undefined;
  selfUserId?: string | null;
  /** The channel THIS client has selected, already checked against this account. */
  selectedChannelId?: string | null;
  /** Whether this window is actually being looked at (the self-viewing term). */
  windowVisible?: boolean;

  nowMs: number;
  /** Injected so tests get a clean observation log. */
  litHistory?: LitHistory;
  /**
   * Whether this building's channels AND members have arrived. A building you
   * are not currently in must not claim "0 in · Dark · nobody in" because
   * nobody has fetched it yet.
   */
  rosterKnown?: boolean;
}

function isVoice(type: ChannelType): boolean {
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

/**
 * Which voice room each member of THIS guild is in.
 *
 * `voiceStore.channelParticipants` is one map keyed by the bare channel id and
 * populated across every connected server, so a state only counts here when its
 * `guild_id` says it belongs to this building. Without that check a room on
 * server B lights the same-id room on server A.
 */
function voiceRoomsByUser(
  channelParticipants: ReadonlyMap<string, VoiceState[]>,
  guildId: string,
  nameOf: (channelId: string) => string | null,
): Map<string, { channelId: string; roomName: string | null }> {
  const byUser = new Map<string, { channelId: string; roomName: string | null }>();
  for (const [channelId, states] of channelParticipants) {
    for (const state of states) {
      if (state.guild_id !== guildId) continue;
      byUser.set(state.user_id, { channelId, roomName: nameOf(channelId) });
    }
  }
  return byUser;
}

/** The tail of a loaded timeline, for the "authored" reading term. */
export function recentAuthorsOf(
  messages: Readonly<Record<string, readonly LightMessage[]>>,
  channelId: string,
): RecentAuthorSample[] {
  const loaded = messages[channelId];
  if (!loaded?.length) return [];
  const samples: RecentAuthorSample[] = [];
  for (const message of loaded.slice(-RECENT_AUTHOR_LIMIT)) {
    const authorId = message.author?.id;
    if (authorId) samples.push({ authorId, messageId: message.id });
  }
  return samples;
}

/** Every member of the building, as light. */
export function guildPeople(input: GuildLightInput): PersonLight[] {
  const nameOf = channelNameLookup(input.channels);
  const inRoom = voiceRoomsByUser(input.channelParticipants, input.guildId, nameOf);
  return input.members.map((member) => {
    const userId = member.user.id;
    const voice = inRoom.get(userId);
    return personLight({
      userId,
      name: displayName(member.user, member.nick),
      status: input.getStatus(userId) ?? 'offline',
      avatar: member.user.avatar_hash ?? null,
      speaking: input.speakingUsers.has(userId),
      inRoom: Boolean(voice),
      roomName: voice?.roomName ?? null,
    });
  });
}

function channelNameLookup(channels: readonly LightChannel[]): (id: string) => string | null {
  const names = new Map(channels.map((channel) => [channel.id, channel.name ?? null]));
  return (id) => names.get(id) ?? null;
}

/** Every room of the building, as light. */
export function guildRooms(input: GuildLightInput, people: readonly PersonLight[]): RoomLight[] {
  const history = input.litHistory ?? roomLitHistory;
  const peopleById = new Map(people.map((person) => [person.userId, person]));
  const rooms: RoomLight[] = [];

  for (const channel of input.channels) {
    if (channel.type === ChannelType.Category) continue;
    const name = channel.name ?? 'unknown';
    const key = entityScopeKey(input.scope, channel.id);

    if (isVoice(channel.type)) {
      const states = (input.channelParticipants.get(channel.id) ?? []).filter(
        (state) => state.guild_id === input.guildId,
      );
      const times = history.observe(key, states.length > 0, input.nowMs);
      rooms.push(
        voiceRoomLight({
          scope: input.scope,
          guildId: input.guildId,
          channelId: channel.id,
          name,
          order: channel.position ?? 0,
          occupants: states.map((state) => ({
            // A member list can lag a join by a beat; the voice state itself
            // always carries enough identity to light the person.
            person:
              peopleById.get(state.user_id) ??
              personLight({
                userId: state.user_id,
                name: displayName({ username: state.username, display_name: state.display_name }),
                status: 'online',
                avatar: state.avatar_hash ?? null,
                speaking: input.speakingUsers.has(state.user_id),
                inRoom: true,
                roomName: name,
              }),
            speaking: input.speakingUsers.has(state.user_id),
            muted: state.self_mute || state.mute,
            sharingScreen: state.self_stream,
            sharingCamera: state.self_video,
          })),
          selfUserId: input.selfUserId ?? null,
          startedAtMs: times.litSinceMs,
          lastLitMs: times.lastLitMs,
          nowMs: input.nowMs,
        }),
      );
      continue;
    }

    const room = textRoomLight({
      scope: input.scope,
      guildId: input.guildId,
      channelId: channel.id,
      name,
      order: channel.position ?? 0,
      candidates: people,
      typingUserIds: input.typingByChannel[channel.id] ?? [],
      recentAuthors: recentAuthorsOf(input.messages, channel.id),
      selfUserId: input.selfUserId ?? null,
      selfIsViewing:
        Boolean(input.windowVisible) && input.selectedChannelId === channel.id,
      lastLitMs: history.peek(key).lastLitMs,
      nowMs: input.nowMs,
    });
    history.observe(key, room.lit, input.nowMs);
    rooms.push(room);
  }

  return rooms;
}

/** The whole building: people, rooms, window map, counts, caption. */
export function guildLight(input: GuildLightInput): BuildingLight {
  const people = guildPeople(input);
  const rooms = guildRooms(input, people);
  return buildingLight({
    scope: input.scope,
    guildId: input.guildId,
    name: input.guildName,
    icon: input.icon ?? null,
    rooms,
    members: people,
    memberCount: input.memberCount ?? people.length,
    rosterKnown: input.rosterKnown,
  });
}
