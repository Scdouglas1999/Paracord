import { useLayoutEffect, useMemo } from 'react';
import { useLocation } from 'react-router';
import { create } from 'zustand';

import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { PEOPLE_HUE, paletteHue, serverHue } from '../../../lib/identityHue';
import { registerSessionReset } from '../../../stores/sessionReset';
import { PEOPLE_PLACE, placeKey, placeOfPath, type Place } from './place';

/**
 * The current place, the dock order, and a place's hue and name.
 *
 * The place comes from the route; a route that belongs to no place (admin,
 * developers, discovery) keeps the last one, which this store remembers for the
 * session (IX-14's "/app redirects to the last place" reads it too).
 */

interface PlaceMemory {
  last: Place;
  remember: (place: Place) => void;
}

export const useIxPlaceStore = create<PlaceMemory>()((set, get) => ({
  last: PEOPLE_PLACE,
  remember: (place) => {
    if (placeKey(get().last) !== placeKey(place)) set({ last: place });
  },
}));

registerSessionReset('ix-place', () => useIxPlaceStore.setState({ last: PEOPLE_PLACE }));

/** The place the sidebar shows: the route's, else the last one. Stable identity per place. */
export function useCurrentPlace(): Place {
  const { pathname } = useLocation();
  const routed = placeOfPath(pathname);
  const last = useIxPlaceStore((state) => state.last);
  const remember = useIxPlaceStore((state) => state.remember);
  const routedKey = routed ? placeKey(routed) : null;
  // Remembered before paint, so a non-place route mounted right after reads it.
  useLayoutEffect(() => {
    if (routed) remember(routed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routedKey, remember]);
  // One object per key, so consumers can depend on the place itself.
  return useMemo(() => routed ?? last, [routedKey, last]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The dock order (§4.8): People first, then servers in the client's order (join
 * order; no reordering yet). Entries are place keys (`placeKey`). The dock
 * (IX-6) renders in this order and the sidebar's slide direction (§5.1) reads
 * it, so the two always agree.
 */
export function usePlaceOrder(): string[] {
  const guilds = useAvailableGuilds();
  return useMemo(() => ['people', ...guilds.map((guild) => guild.id)], [guilds]);
}

/** The window hue of a place (§2.2): People 210; a server its own hue, else its id's. */
export function usePlaceHue(place: Place): number {
  const guilds = useAvailableGuilds();
  if (place.kind === 'people') return PEOPLE_HUE;
  const guild = guilds.find((candidate) => candidate.id === place.guildId);
  return guild ? serverHue(guild) : paletteHue(place.guildId);
}

/** The place's name: the server's, or "People". Empty while a server is not loaded. */
export function usePlaceName(place: Place): string {
  const guilds = useAvailableGuilds();
  if (place.kind === 'people') return 'People';
  return guilds.find((candidate) => candidate.id === place.guildId)?.name ?? '';
}
