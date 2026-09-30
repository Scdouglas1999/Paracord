/**
 * The small selections Home makes over WP1's models.
 *
 * Nothing here derives a light — every person and every room arrives already
 * lit or dark from `lib/attention` (WP1's §9 rule: a surface never re-derives
 * "who is reading"). These are ordering and picking, so the page body stays a
 * layout and the choices stay testable.
 */

import type { BuildingLight, PersonLight } from '../../lib/attention/light';

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
    // Everybody the building can see whose light is doing something — lit or
    // merely dim. Somebody with their lights on but in no room is still around,
    // and leaving them out is what let the well say "nobody" while the sentence
    // above it counted them.
    for (const person of building.people) {
      if (person.level === 'off') continue;
      if (!byId.has(person.userId)) byId.set(person.userId, person);
    }
    for (const room of building.rooms) {
      for (const occupant of room.occupants) {
        const existing = byId.get(occupant.person.userId);
        if (!existing || (!existing.speaking && occupant.person.speaking)) {
          byId.set(occupant.person.userId, occupant.person);
        }
      }
      for (const reader of room.readers) {
        const existing = byId.get(reader.person.userId);
        if (!existing || existing.level === 'off') byId.set(reader.person.userId, reader.person);
      }
    }
  }
  const rank = (person: PersonLight) =>
    person.speaking ? 0 : person.live ? 1 : person.lit ? 2 : 3;
  return [...byId.values()].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}
