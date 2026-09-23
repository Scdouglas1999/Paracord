import { describe, expect, it } from 'vitest';

import { buildingLight, orderBuildingsByBrightness } from './buildingLight';
import { personLight } from './personLight';
import { textRoomLight } from './roomLight';
import { arrangeAs, orderOf, othersOrderSignature } from './steadyOrder';
import type { BuildingLight, PersonLight, RoomLight } from './lightModel';

const SCOPE = { serverId: 'a', userId: 'me' };
const NOW = 1_800_000_000_000;

const ME = personLight({ userId: 'me', name: 'Mira', status: 'online' });
const REN = personLight({ userId: 'ren', name: 'Ren', status: 'online' });

function text(channelId: string, order: number, typing: PersonLight[], viewing = false): RoomLight {
  return textRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId,
    name: channelId,
    order,
    candidates: [ME, REN],
    typingUserIds: typing.map((person) => person.userId),
    selfUserId: 'me',
    selfIsViewing: viewing,
    nowMs: NOW,
  });
}

function building(rooms: RoomLight[]): BuildingLight {
  return buildingLight({ scope: SCOPE, guildId: 'g1', name: 'Lantern Works', rooms, members: [ME, REN] });
}

/** What the sidebar hook does, one light at a time. */
function column() {
  let held: { signature: string; order: ReturnType<typeof orderOf> } | null = null;
  return (buildings: BuildingLight[]) => {
    const ordered = orderBuildingsByBrightness(buildings);
    const signature = othersOrderSignature(ordered);
    if (!held || held.signature !== signature) {
      held = { signature, order: orderOf(ordered) };
      return ordered;
    }
    return arrangeAs(ordered, held.order);
  };
}

const keys = (buildings: readonly BuildingLight[]) =>
  buildings.flatMap((entry) => entry.rooms.map((room) => room.channelId));

describe('steady order', () => {
  it('does not move the room you just opened', () => {
    const show = column();
    expect(keys(show([building([text('general', 0, [], true), text('design', 1, [])])]))).toEqual([
      'general',
      'design',
    ]);
    // Opening #design makes you its reader, which ranks it above #general.
    const opened = show([building([text('general', 0, []), text('design', 1, [], true)])]);
    expect(keys(opened)).toEqual(['general', 'design']);
    // The rooms are today's lights, just in the order you were looking at.
    expect(opened[0].rooms[1].youAreHere).toBe(true);
  });

  it('lets the whole order through on the next change somebody else makes', () => {
    const show = column();
    show([building([text('general', 0, [], true), text('design', 1, []), text('shop', 2, [])])]);
    show([building([text('general', 0, []), text('design', 1, [], true), text('shop', 2, [])])]);
    // Ren starts writing in #shop: a genuine change, and yours comes with it.
    const next = show([building([text('general', 0, []), text('design', 1, [], true), text('shop', 2, [REN])])]);
    expect(keys(next)).toEqual(['design', 'shop', 'general']);
  });

  it('returns the same array when nothing is held back', () => {
    const lights = orderBuildingsByBrightness([building([text('general', 0, [REN]), text('design', 1, [])])]);
    expect(arrangeAs(lights, orderOf(lights))).toBe(lights);
  });
});
