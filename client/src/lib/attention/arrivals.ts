/**
 * Who just walked in, and who just walked out
 * (docs/lantern-stage-spec.md §5.1 "arrivals travel one path").
 *
 * The light models say who is in a room *now*; a moment needs the edge. This
 * module is the edge, and nothing else: pure, injectable, no store, React, DOM
 * or ambient clock, so the rule "one arrival is one choreography" is a thing a
 * unit test can hold rather than something the components hope is true.
 *
 * Occupancy is read from voice membership, which is exact — the gateway sends
 * every `VOICE_STATE_UPDATE`, so an arrival here is a fact and never a guess.
 * Text rooms are deliberately out of scope: WP1's "reading" is derived from
 * typing and recent authorship, and a light that flickers on every keystroke is
 * not somebody walking in.
 */

/** Who is in which room: channel id → the user ids in it. */
export type Occupancy = ReadonlyMap<string, ReadonlySet<string>>;

/** One person crossing one room's threshold. */
export interface RoomCrossing {
  userId: string;
  /** The room's channel id — what `data-motion-window` carries. */
  roomId: string;
  /** The room was dark before they arrived / is dark now they have gone. */
  roomWentDark?: boolean;
  roomLitUp?: boolean;
}

export interface OccupancyDelta {
  arrivals: RoomCrossing[];
  departures: RoomCrossing[];
}

const NONE: OccupancyDelta = { arrivals: [], departures: [] };
const EMPTY: ReadonlySet<string> = new Set();

/** Nothing crossed anything. */
export function noCrossings(delta: OccupancyDelta): boolean {
  return delta.arrivals.length === 0 && delta.departures.length === 0;
}

/**
 * What changed between two occupancy snapshots.
 *
 * `selfUserId` is dropped on purpose: your own arrival is Moment 2 — the room
 * you walked into becomes the thing you are looking at — and playing Moment 3
 * over the top of it would animate you twice for one act.
 *
 * `baseline` is the §5.3 guard: the first time a scope's voice state loads,
 * everybody in every room would otherwise "arrive" at once, and that is data
 * appearing rather than people walking in. Pass it for the first observation of
 * a scope and whenever the account underneath changes.
 */
export function diffOccupancy(
  previous: Occupancy | null,
  next: Occupancy,
  options: { selfUserId?: string | null; baseline?: boolean } = {},
): OccupancyDelta {
  if (!previous || options.baseline) return NONE;
  const self = options.selfUserId ?? null;
  const arrivals: RoomCrossing[] = [];
  const departures: RoomCrossing[] = [];

  for (const [roomId, now] of next) {
    // The voice store only carries rooms that have somebody in them, so a room
    // appearing for the first time is the room LIGHTING UP — the single most
    // important arrival there is, and the one the study is drawn around. The
    // "this is just data loading" case is `baseline`, above, not this.
    const before = previous.get(roomId) ?? EMPTY;
    for (const userId of now) {
      if (before.has(userId) || userId === self) continue;
      arrivals.push({ userId, roomId, roomLitUp: before.size === 0 });
    }
    for (const userId of before) {
      if (now.has(userId) || userId === self) continue;
      departures.push({ userId, roomId, roomWentDark: now.size === 0 });
    }
  }

  // A room that disappeared from the snapshot entirely emptied out.
  for (const [roomId, before] of previous) {
    if (next.has(roomId)) continue;
    for (const userId of before) {
      if (userId === self) continue;
      departures.push({ userId, roomId, roomWentDark: true });
    }
  }

  if (arrivals.length === 0 && departures.length === 0) return NONE;
  return { arrivals, departures };
}

/** Voice membership as this module wants it, from the voice store's shape. */
export function occupancyOf(
  channelParticipants: ReadonlyMap<string, ReadonlyArray<{ user_id: string }>>,
): Occupancy {
  const map = new Map<string, Set<string>>();
  for (const [channelId, members] of channelParticipants) {
    map.set(channelId, new Set(members.map((member) => member.user_id)));
  }
  return map;
}

/**
 * Merge a crossing into a burst already in flight.
 *
 * §5.1's "nothing else on screen moves" cuts both ways: five people arriving in
 * the same beat is ONE thing happening, and five overlapping sequences is five.
 * A crossing that repeats a person already in the burst is dropped rather than
 * queued twice.
 */
export function mergeBurst(burst: RoomCrossing[], incoming: readonly RoomCrossing[]): RoomCrossing[] {
  const seen = new Set(burst.map((crossing) => `${crossing.userId}:${crossing.roomId}`));
  const merged = [...burst];
  for (const crossing of incoming) {
    const key = `${crossing.userId}:${crossing.roomId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(crossing);
  }
  return merged;
}
