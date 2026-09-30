import type { BuildingLight, RoomLight } from '../../lib/attention/light';
import { PageSection } from './GlassPage';
import { LiveRoomRow } from './LiveRoomRow';

/** One live room and the server it is in. */
export interface LiveRoomEntry {
  building: BuildingLight;
  room: RoomLight;
}

/**
 * Every voice room with somebody in it, across every server, busiest first: the
 * most people, then the most talking, then the servers' own order (brightest
 * first). Nothing is invented: a room is here only because the building's own
 * light model says people are in it.
 */
export function liveRoomsOf(buildings: readonly BuildingLight[]): LiveRoomEntry[] {
  const entries: LiveRoomEntry[] = [];
  for (const building of buildings) {
    for (const room of building.rooms) {
      if (room.kind === 'voice' && room.occupants.length > 0) entries.push({ building, room });
    }
  }
  const order = new Map(buildings.map((building, index) => [building.key, index]));
  return entries.sort(
    (a, b) =>
      b.room.occupants.length - a.room.occupants.length ||
      b.room.talkingCount - a.room.talkingCount ||
      (order.get(a.building.key) ?? 0) - (order.get(b.building.key) ?? 0) ||
      a.room.order - b.room.order,
  );
}

export interface HomeLiveNowProps {
  rooms: readonly LiveRoomEntry[];
  nowMs: number;
  onOpenRoom: (building: BuildingLight, room: RoomLight) => void;
  onJoinRoom: (building: BuildingLight, room: RoomLight) => void;
}

/**
 * Live now: the calls happening across your servers, in amber (docs/glass-spec.md
 * §1.3, §3.1). Join is the one cream button on the page and belongs to the
 * busiest room; the rest are glass.
 *
 * Omitted entirely when nobody is in a call: an empty "Live now" is a claim about
 * silence the client cannot make for a server it has not loaded.
 */
export function HomeLiveNow({ rooms, nowMs, onOpenRoom, onJoinRoom }: HomeLiveNowProps) {
  if (rooms.length === 0) return null;
  return (
    <PageSection kicker="Live now" tone="amber" count={rooms.length}>
      {rooms.map(({ building, room }, index) => (
        <LiveRoomRow
          key={room.key}
          room={room}
          where={building.name}
          primary={index === 0}
          nowMs={nowMs}
          onOpen={() => onOpenRoom(building, room)}
          onJoin={() => onJoinRoom(building, room)}
        />
      ))}
    </PageSection>
  );
}
