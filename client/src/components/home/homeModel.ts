/**
 * The small selections Home makes over WP1's models (docs/lantern-stage-spec.md §7.5).
 *
 * Nothing here derives a light — every person and every room arrives already
 * lit or dark from `lib/attention` (WP1's §9 rule: a surface never re-derives
 * "who is reading"). These are ordering and picking, so the page body stays a
 * layout and the choices stay testable.
 */

import type { BuildingLight, PersonLight, RoomLight } from '../../lib/attention/light';

/** At most this many lit text rooms are listed under a building's window map. */
export const BUILDING_TEXT_ROOMS = 3;

/**
 * The faces for the Around-now well: everybody the buildings can currently see,
 * lit before dim, speakers before listeners, then alphabetical so the stack
 * does not reshuffle between ticks.
 *
 * A person seen through two connected servers appears twice — the client cannot
 * prove they are one human (WP1, "left for later"), and guessing would be worse
 * than counting honestly.
 */
export function aroundNowPeople(buildings: readonly BuildingLight[]): PersonLight[] {
  const byId = new Map<string, PersonLight>();
  for (const building of buildings) {
    for (const room of building.rooms) {
      for (const occupant of room.occupants) {
        const existing = byId.get(occupant.person.userId);
        if (!existing || (!existing.speaking && occupant.person.speaking)) {
          byId.set(occupant.person.userId, occupant.person);
        }
      }
      for (const reader of room.readers) {
        if (!byId.has(reader.person.userId)) byId.set(reader.person.userId, reader.person);
      }
    }
  }
  const rank = (person: PersonLight) =>
    person.speaking ? 0 : person.live ? 1 : person.lit ? 2 : 3;
  return [...byId.values()].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

/** A building's lit text rooms, most readers first — the lines under its windows. */
export function litTextRooms(
  building: BuildingLight,
  max = BUILDING_TEXT_ROOMS,
): RoomLight[] {
  return building.rooms
    .filter((room) => room.kind === 'text' && room.lit)
    .sort(
      (a, b) => b.readingCount - a.readingCount || a.order - b.order || a.name.localeCompare(b.name),
    )
    .slice(0, max);
}

/**
 * A quiet building gets **one** line: the text room somebody is actually in.
 * With nobody reading anywhere it gets none — a dark building does not get a
 * row of rooms to pad it out.
 */
export function activeTextRoom(building: BuildingLight): RoomLight | null {
  return litTextRooms(building, 1)[0] ?? null;
}

/**
 * A building is drawn as the wide card only when a voice room in it is lit —
 * that card exists to show the room's live thumbnail, and there is no honest
 * thumbnail without a room to look into (§6.4: no fake video).
 */
export function isLitBuilding(building: BuildingLight): boolean {
  return building.brightestRoom !== null;
}
