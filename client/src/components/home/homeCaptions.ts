/**
 * Home's words (docs/lantern-stage-spec.md §6.9, §7.5, §9).
 *
 * Every count and every state on Home has a sentence here, so light is never
 * the only cue and two rows can never word the same fact differently. The
 * shared vocabulary lives in `lib/attention/lightCaptions.ts` (WP1) — this file
 * only adds the phrases §7.5 asks for and nothing else invents.
 *
 * Pure strings. No React, no stores.
 */

import {
  darkRoomCaption,
  litMembersCaption,
  nameList,
  readingCaption,
  type RoomLight,
} from '../../lib/attention/light';

/** "1 mention for you" / "3 mentions for you" (§7.5, the lit building's text rooms). */
export function mentionCaption(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return `${n} mention${n === 1 ? '' : 's'} for you`;
}

/**
 * What the people in a lit room are actually doing, for the line beside the
 * occupant stack on a building's live thumbnail.
 *
 * Ordered by what a passer-by would notice first: a screen, then a camera, then
 * voices, then simply that somebody is in there. Every branch names a person —
 * "somebody is here" is not a thing this app says.
 */
export function roomActivityLine(room: RoomLight): string {
  if (!room.lit || room.occupants.length === 0) return darkRoomCaption('card');
  const share = room.screenSharer;
  if (share) return `${share.person.name} is sharing a screen`;
  const camera = room.cameraSharer;
  if (camera) return `${camera.person.name} has their camera on`;
  const speaking = room.occupants.filter((occupant) => occupant.speaking);
  if (speaking.length > 0) {
    const names = nameList(speaking.map((occupant) => occupant.person.name));
    return `${names} ${speaking.length === 1 ? 'is' : 'are'} talking`;
  }
  const names = nameList(room.occupants.map((occupant) => occupant.person.name));
  return `${names} ${room.occupants.length === 1 ? 'is' : 'are'} in here`;
}

/**
 * A building's meta on Home: "24 in · 2 rooms lit", "6 in · quiet".
 *
 * `building.caption` is WP1's canonical phrasing and is reused verbatim when
 * something is lit. The one phrase Home adds is the middle state the reference
 * render names — people are in the building but no room is lit — because
 * "24 in · Dark · nobody in" contradicts itself.
 */
export function buildingMetaCaption(building: {
  lightsOn: number;
  roomsLit: number;
  readingCount: number;
  caption: string;
}): string {
  if (building.lightsOn <= 0 && building.roomsLit <= 0 && building.readingCount <= 0) {
    return building.caption;
  }
  const lit = building.roomsLit > 0 || building.readingCount > 0;
  return `${litMembersCaption(building.lightsOn)} · ${lit ? building.caption : 'quiet'}`;
}

/** A lit text room's line inside a building card: "5 reading · 1 mention for you". */
export function textRoomCaption(room: RoomLight, mentionCount = 0): string {
  const reading = room.lit ? readingCaption(room.readingCount) : darkRoomCaption('row');
  return mentionCount > 0 ? `${reading} · ${mentionCaption(mentionCount)}` : reading;
}

/** The add-a-building row (§7.5). One sentence, both ways in. */
export const ADD_BUILDING_LABEL = 'Add a server — join with an invite, or start your own';

/**
 * For-you empty states distinguish a checked inbox from an unknown answer.
 */
export const NEEDS_YOU_QUIET = {
  ready: 'Nothing new for you right now.',
  loading: 'Checking for new messages…',
  error: 'Some activity could not be checked — refresh to try again.',
} as const;
