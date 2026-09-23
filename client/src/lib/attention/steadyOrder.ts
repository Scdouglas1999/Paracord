/**
 * A column that does not move under your own hand.
 *
 * The buildings column orders rooms and buildings by light, and part of that
 * light is you: opening a text channel makes you one of its readers, joining a
 * voice channel makes you one of its occupants. So the row you had just clicked
 * jumped up the column — to where your pointer no longer was — at the moment
 * you clicked it, and the room you left slid down behind it.
 *
 * The rule here: an order only changes when something *other* than you changed
 * it. Every light is also ranked with you taken out of it; while that ranking
 * holds still, the column keeps the order it is showing. The next genuine
 * change — somebody else arrives, talks, writes, leaves — lets the full order
 * (you included) through, all at once and on the column's own FLIP.
 */
import { brightnessOf, orderBuildingsByBrightness, orderRoomsForWindows } from './buildingLight';
import type { BuildingLight, RoomLight } from './lightModel';

/** A room's light with the viewer's own part in it taken out. */
function withoutSelf(room: RoomLight, selfUserId: string): RoomLight {
  if (room.kind === 'voice') {
    if (!room.occupants.some((occupant) => occupant.person.userId === selfUserId)) return room;
    const occupants = room.occupants.filter((occupant) => occupant.person.userId !== selfUserId);
    return {
      ...room,
      occupants,
      lit: occupants.length > 0,
      talkingCount: occupants.filter((occupant) => occupant.speaking).length,
    };
  }
  if (!room.readers.some((reader) => reader.person.userId === selfUserId)) return room;
  const readers = room.readers.filter((reader) => reader.person.userId !== selfUserId);
  return { ...room, readers, readingCount: readers.length, lit: readers.length > 0 };
}

/** A building's light with the viewer's own part in it taken out. */
function buildingWithoutSelf(building: BuildingLight): BuildingLight {
  const selfUserId = building.scope.userId;
  const rooms = orderRoomsForWindows(building.rooms.map((room) => withoutSelf(room, selfUserId)));
  const voiceRooms = rooms.filter((room) => room.kind === 'voice');
  const talkingCount = voiceRooms.reduce((sum, room) => sum + room.talkingCount, 0);
  const roomsLit = voiceRooms.filter((room) => room.lit).length;
  const readingCount = rooms.reduce((sum, room) => sum + room.readingCount, 0);
  const selfOn = building.people.some((person) => person.userId === selfUserId && person.level === 'on');
  const lightsOn = building.lightsOn - (selfOn ? 1 : 0);
  return {
    ...building,
    rooms,
    talkingCount,
    roomsLit,
    readingCount,
    lightsOn,
    brightness: brightnessOf({ talkingCount, roomsLit, readingCount, lightsOn }),
  };
}

/**
 * The column's order as everybody but the viewer made it: buildings, then each
 * building's rooms. Two lights with the same signature differ only by what the
 * viewer did.
 */
export function othersOrderSignature(buildings: readonly BuildingLight[]): string {
  return JSON.stringify(
    orderBuildingsByBrightness(buildings.map(buildingWithoutSelf)).map((building) => [
      building.key,
      building.rooms.map((room) => room.key),
    ]),
  );
}

/** The order a column is showing: building keys, and each building's room keys. */
export interface HeldOrder {
  buildings: readonly string[];
  rooms: ReadonlyMap<string, readonly string[]>;
}

export function orderOf(buildings: readonly BuildingLight[]): HeldOrder {
  return {
    buildings: buildings.map((building) => building.key),
    rooms: new Map(buildings.map((building) => [building.key, building.rooms.map((room) => room.key)])),
  };
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * Today's lights, laid out in a held order. Every key in `held` must be present
 * in `buildings` and the other way round (the caller only holds an order while
 * the set of rooms is unchanged). Returns `buildings` itself when nothing moves.
 */
export function arrangeAs(buildings: readonly BuildingLight[], held: HeldOrder): readonly BuildingLight[] {
  const byKey = new Map(buildings.map((building) => [building.key, building]));
  let moved = false;
  const arranged = held.buildings.map((key, index) => {
    const building = byKey.get(key);
    if (!building) throw new Error(`steadyOrder: held server ${key} is not in the sidebar`);
    if (buildings[index] !== building) moved = true;
    const heldRooms = held.rooms.get(key) ?? [];
    if (sameKeys(heldRooms, building.rooms.map((room) => room.key))) return building;
    const roomByKey = new Map(building.rooms.map((room) => [room.key, room]));
    moved = true;
    return {
      ...building,
      rooms: heldRooms.map((roomKey) => {
        const room = roomByKey.get(roomKey);
        if (!room) throw new Error(`steadyOrder: held channel ${roomKey} is not in server ${key}`);
        return room;
      }),
    };
  });
  return moved ? arranged : buildings;
}
