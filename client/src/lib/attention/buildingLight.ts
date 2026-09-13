/**
 * Buildings → light (docs/lantern-stage-spec.md §3, §7.1, §7.3, §7.5).
 *
 * A building draws **one window per room**: voice rooms first, then text rooms
 * by activity, at most two rows of eight. Rooms past the sixteenth do not get a
 * window — they collapse into the caption count (§3), because a window map that
 * scrolls is a chart, not a building.
 *
 * Also here: the "brightest first" ordering used by the buildings column and by
 * Home, and the one-sentence "Around now" summary.
 *
 * Pure — NO store or React imports.
 */

import { entityScopeKey, type AccountScope } from '../serverScope';
import { buildingCaption, nameList } from './lightCaptions';
import {
  MAX_WINDOWS,
  type BuildingLight,
  type BuildingWindow,
  type PersonLight,
  type RoomLight,
} from './lightModel';

export interface BuildingLightInput {
  scope: AccountScope;
  guildId: string;
  name: string;
  icon?: string | null;
  /** Every room in the building, already lit by `roomLight.ts`. */
  rooms: readonly RoomLight[];
  /** Members of this building, already lit by `personLight.ts`. */
  members: readonly PersonLight[];
  /** Total members, including the ones whose lights are off. */
  memberCount?: number;
}

/**
 * Room ordering for the window map (§3): voice first, then text by activity.
 *
 * Within voice, a lit room outranks a dark one and more people outrank fewer;
 * within text, more readers outrank fewer. Equally-lit rooms fall back to the
 * order the building's own people gave them (the channel position), then to the
 * name — so the map is stable between renders and never reshuffles a building
 * into alphabetical order.
 */
export function orderRoomsForWindows(rooms: readonly RoomLight[]): RoomLight[] {
  return [...rooms].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'voice' ? -1 : 1;
    if (a.kind === 'voice') {
      return (
        b.occupants.length - a.occupants.length ||
        b.talkingCount - a.talkingCount ||
        a.order - b.order ||
        a.name.localeCompare(b.name)
      );
    }
    return b.readingCount - a.readingCount || a.order - b.order || a.name.localeCompare(b.name);
  });
}

/** One window per room, in window-map order, capped at two rows of eight. */
export function windowsFor(rooms: readonly RoomLight[], max = MAX_WINDOWS): BuildingWindow[] {
  return orderRoomsForWindows(rooms)
    .slice(0, max)
    .map((room) => ({
      key: room.key,
      channelId: room.channelId,
      name: room.name,
      state: room.level === 'white' ? 'on' : room.level === 'amber' ? 'warm' : 'dark',
      kind: room.kind,
      label: `${room.name} — ${room.caption}`,
    }));
}

/**
 * Brightness, for "brightest building first" (§7.1, §7.5).
 *
 * Talking outranks reading outranks merely-lit, exactly as the light does: a
 * room with voices in it is the loudest thing in a building. Scale is arbitrary
 * but the ORDER is the contract, and it is asserted in the tests.
 */
export function brightnessOf(building: {
  talkingCount: number;
  roomsLit: number;
  readingCount: number;
  lightsOn: number;
}): number {
  return (
    building.talkingCount * 1000 +
    building.roomsLit * 200 +
    building.readingCount * 20 +
    building.lightsOn
  );
}

/** Build the light for one building. */
export function buildingLight(input: BuildingLightInput): BuildingLight {
  const rooms = [...input.rooms];
  const ordered = orderRoomsForWindows(rooms);
  const windows = windowsFor(ordered);
  const overflowCount = Math.max(0, ordered.length - windows.length);

  const voiceRooms = rooms.filter((room) => room.kind === 'voice');
  const roomsLit = voiceRooms.filter((room) => room.lit).length;
  const talkingCount = voiceRooms.reduce((sum, room) => sum + room.talkingCount, 0);
  const readingCount = rooms.reduce((sum, room) => sum + room.readingCount, 0);
  const people = [...new Map(input.members.map((person) => [person.userId, person])).values()];
  const lightsOn = people.filter((person) => person.level === 'on').length;

  // The building's live thumbnail comes from its loudest lit voice room.
  const brightestRoom =
    voiceRooms
      .filter((room) => room.lit)
      .sort(
        (a, b) =>
          Number(b.thumbnail.live) - Number(a.thumbnail.live) ||
          b.talkingCount - a.talkingCount ||
          b.occupants.length - a.occupants.length ||
          a.order - b.order ||
          a.name.localeCompare(b.name),
      )[0] ?? null;

  return {
    key: entityScopeKey(input.scope, input.guildId),
    scope: input.scope,
    guildId: input.guildId,
    name: input.name,
    icon: input.icon ?? null,
    windows,
    overflowCount,
    rooms: ordered,
    brightestRoom,
    roomsLit,
    talkingCount,
    readingCount,
    lightsOn,
    people,
    memberCount: input.memberCount ?? input.members.length,
    brightness: brightnessOf({ talkingCount, roomsLit, readingCount, lightsOn }),
    caption: buildingCaption(roomsLit, readingCount),
  };
}

/**
 * Brightest building first, then the one with the most lights on, then by name
 * (§7.1 "the cross-server merge still drives ordering"). Stable and total —
 * two equally dark buildings always come out in the same order.
 */
export function orderBuildingsByBrightness(buildings: readonly BuildingLight[]): BuildingLight[] {
  return [...buildings].sort(
    (a, b) => b.brightness - a.brightness || b.lightsOn - a.lightsOn || a.name.localeCompare(b.name),
  );
}

/** How many names the "lights on, but nobody's in a room" clause spells out. */
const LIT_ONLY_NAMES = 3;

export interface AroundNowInput {
  /** Rooms to summarise, across one building or every building. */
  rooms: readonly RoomLight[];
  /** People whose lights are on or dim, for the "… is away" tail. */
  people?: readonly PersonLight[];
  /** How many room clauses the sentence may carry. */
  maxClauses?: number;
  /** What to say when nothing anywhere is lit. */
  empty?: string;
}

/**
 * The one-sentence "Around now" summary (§7.3, §7.5).
 *
 *   "Mara, Priya and Ren are in Shop floor · Tomas and Aisha are reading
 *    build-log · Devon is away"
 *
 * Voice clauses come first (loudest first), then reading clauses, then at most
 * one away clause. It is one sentence because it is meant to be read in one
 * glance; everything past `maxClauses` is what the window map is for.
 */
export function aroundNowSentence(input: AroundNowInput): string {
  const maxClauses = input.maxClauses ?? 3;
  const clauses: string[] = [];

  const voice = input.rooms
    .filter((room) => room.kind === 'voice' && room.lit)
    .sort((a, b) => b.occupants.length - a.occupants.length || a.name.localeCompare(b.name));
  for (const room of voice) {
    const names = nameList(room.occupants.map((o) => o.person.name));
    if (!names) continue;
    const verb = room.occupants.length === 1 ? 'is' : 'are';
    clauses.push(`${names} ${verb} in ${room.name}`);
  }

  const text = input.rooms
    .filter((room) => room.kind === 'text' && room.lit)
    .sort((a, b) => b.readingCount - a.readingCount || a.name.localeCompare(b.name));
  for (const room of text) {
    const names = nameList(room.readers.map((r) => r.person.name));
    if (!names) continue;
    const verb = room.readers.length === 1 ? 'is' : 'are';
    clauses.push(`${names} ${verb} reading ${room.name}`);
  }

  const busy = new Set<string>();
  for (const room of input.rooms) {
    for (const occupant of room.occupants) busy.add(occupant.person.userId);
    for (const reader of room.readers) busy.add(reader.person.userId);
  }

  // Nobody is in a room and nobody is reading — but people can still have their
  // lights on, and this well must not deny what the count above it asserts
  // (§9: the light always has a text equivalent, and two rows never disagree).
  // Only when there is no room clause: with somebody actually in a room, the
  // rest of the lit building is what the "+N lights on" tail is for.
  if (clauses.length === 0) {
    const lit = [
      ...new Map(
        (input.people ?? [])
          .filter((person) => person.level === 'on' && !busy.has(person.userId))
          .map((person) => [person.userId, person]),
      ).values(),
    ];
    const names = nameList(lit.map((person) => person.name), LIT_ONLY_NAMES);
    if (names) clauses.push(`${names} ${lit.length === 1 ? 'has' : 'have'} their lights on`);
  }

  const away = (input.people ?? []).filter(
    (person) => person.level === 'dim' && !busy.has(person.userId),
  );
  if (away.length > 0) {
    const names = nameList(away.map((person) => person.name), 2);
    clauses.push(`${names} ${away.length === 1 ? 'is' : 'are'} away`);
  }

  if (clauses.length === 0) return input.empty ?? "Nobody's lights are on right now";
  return clauses.slice(0, maxClauses).join(' · ');
}
