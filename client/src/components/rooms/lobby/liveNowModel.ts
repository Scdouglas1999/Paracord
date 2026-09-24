/**
 * What is live in a server right now (docs/server-home-spec.md, "Live now").
 *
 * Five kinds of thing can be live: a voice channel watching or listening to
 * something together, a voice channel with people in it, a stage with people
 * on it, an event whose time is now, and a game from the Sports add-on. The section shows at most three cards and counts the rest ("+2
 * more"); when nothing is live it becomes the one-line list of voice channels.
 *
 * Pure: the page hands in what its hooks already know.
 */

import type { RoomLight } from '../../../lib/attention/light';
import type { SportsGame } from '../../../api/sports';
import type { HomeEvent } from './useUpcomingEvents';
import type { TogetherActivity } from '../../../lib/together/model';

export type LiveItem =
  | { kind: 'together'; key: string; room: RoomLight; activity: TogetherActivity }
  | { kind: 'voice'; key: string; room: RoomLight }
  | { kind: 'stage'; key: string; room: RoomLight }
  | { kind: 'event'; key: string; event: HomeEvent }
  | { kind: 'game'; key: string; game: SportsGame };

export interface LiveNow {
  /** The cards to draw, at most {@link LIVE_CARDS}. */
  shown: LiveItem[];
  /** How many more are live than are shown. */
  more: number;
  /** Everything live, for the "+N more" list. */
  all: LiveItem[];
}

export const LIVE_CARDS = 3;

export interface LiveNowInput {
  rooms: readonly RoomLight[];
  stageChannelIds: ReadonlySet<string>;
  events: readonly HomeEvent[];
  /** Games from the Sports add-on; only `state === 'in'` ones are live. */
  games: readonly SportsGame[];
  /** What voice channels are watching or listening to together, by channel id. */
  together?: Readonly<Record<string, TogetherActivity | null | undefined>>;
}

export function liveNow({ rooms, stageChannelIds, events, games, together = {} }: LiveNowInput): LiveNow {
  // A call playing something together is the liveliest thing in the server:
  // its card replaces the plain call card and leads the row.
  const shared: LiveItem[] = rooms
    .filter((room) => room.kind === 'voice' && room.occupants.length > 0 && together[room.channelId])
    .sort((a, b) => b.occupants.length - a.occupants.length || a.order - b.order)
    .map((room) => ({
      kind: 'together' as const,
      key: `together:${room.channelId}`,
      room,
      activity: together[room.channelId] as TogetherActivity,
    }));
  const calls: LiveItem[] = rooms
    .filter((room) => !together[room.channelId])
    .filter((room) => room.kind === 'voice' && room.occupants.length > 0)
    .sort(
      (a, b) =>
        b.occupants.length - a.occupants.length ||
        b.talkingCount - a.talkingCount ||
        a.order - b.order ||
        a.name.localeCompare(b.name),
    )
    .map((room) =>
      stageChannelIds.has(room.channelId)
        ? { kind: 'stage' as const, key: `stage:${room.channelId}`, room }
        : { kind: 'voice' as const, key: `voice:${room.channelId}`, room },
    );
  const now: LiveItem[] = events
    .filter((event) => event.happeningNow)
    .map((event) => ({ kind: 'event' as const, key: `event:${event.id}`, event }));
  const live: LiveItem[] = games
    .filter((game) => game.state === 'in')
    .map((game) => ({ kind: 'game' as const, key: `game:${game.id}`, game }));
  const all = [...shared, ...calls, ...now, ...live];
  return { shown: all.slice(0, LIVE_CARDS), more: Math.max(0, all.length - LIVE_CARDS), all };
}
