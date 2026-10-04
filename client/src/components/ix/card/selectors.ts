import { useMemo } from 'react';

import type { Place } from '../shell/place';
import { inlineCard, rankRooms } from './model';
import { useCardWorld } from './useCardWorld';

/**
 * What the card shows, for the sidebar packages (IX-5 Rooms, IX-6 dock).
 *
 * The Rooms list leaves out the room the place's card shows (index-spec §4.3:
 * "Other occupied rooms appear in the Rooms list as busy rows"); this is that
 * room's id, or null when the place has no card.
 */
export function useInlineCardRoom(place: Place): string | null {
  const world = useCardWorld();
  return useMemo(() => (world ? inlineCard(world, place)?.channelId ?? null : null), [world, place]);
}

/** A server has a live room (somebody joined, not only listening): its dock item's live dot. */
export function useServerLive(guildId: string): boolean {
  const world = useCardWorld();
  return useMemo(() => (world ? rankRooms(world, guildId).length > 0 : false), [world, guildId]);
}
