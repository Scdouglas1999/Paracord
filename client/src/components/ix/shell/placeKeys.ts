import { useMemo } from 'react';

import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { entityScopeKey, LOCAL_SERVER_ID, type AccountScope } from '../../../lib/serverScope';
import { useServerListStore } from '../../../stores/serverListStore';
import type { Place } from './place';

/**
 * A place's key, unique per saved server (docs/index-spec.md §4.8: a dock item is a place).
 *
 * A place's key has always been its server's (guild's) id: the dock's `data-place`, the
 * dock order, the shell's slide direction, Ctrl+1…9. A server mints that id, and two
 * instances can mint the same one: every instance's generator carries the same worker
 * number and starts a fresh process at sequence zero, so two fresh servers that each make
 * their first server in the same millisecond give them the same snowflake (seen as two dock
 * items under one id, in the real-server test). The client cannot choose what a server
 * mints; it can keep its own keys apart.
 *
 *   one server with that id      the key is the id, exactly as before (every stored order,
 *                                last place and test driver keeps working);
 *   several servers share an id  the first (the home server, then the saved servers in the
 *                                order they were added) keeps the bare id; each other one is
 *                                `<id>@<saved server id>`.
 *
 * Which of them a route's `/app/guilds/<id>` means is the saved server that is selected, as it
 * always was (`useGuild` is scoped to the selected account): going to a place selects its
 * saved server first.
 */

interface Keyed {
  id: string;
  scope: AccountScope;
}

/** What tells one guild from another across saved servers: (saved server, account, guild id). */
const identityOf = (guild: Keyed) => entityScopeKey(guild.scope, guild.id);

/** `identity → place key`, for every guild given. */
export function placeKeysFor<G extends Keyed>(list: readonly G[], serverOrder: readonly string[]): Map<string, string> {
  const byId = new Map<string, G[]>();
  for (const guild of list) {
    const group = byId.get(guild.id);
    if (group) group.push(guild);
    else byId.set(guild.id, [guild]);
  }
  const rank = (guild: G) => {
    const at = serverOrder.indexOf(guild.scope.serverId);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const keys = new Map<string, string>();
  for (const [id, group] of byId) {
    if (group.length === 1) {
      keys.set(identityOf(group[0]), id);
      continue;
    }
    [...group]
      .sort((a, b) => rank(a) - rank(b))
      .forEach((guild, index) => keys.set(identityOf(guild), index === 0 ? id : `${id}@${guild.scope.serverId}`));
  }
  return keys;
}

export interface PlaceKeys<G extends Keyed> {
  /** The place key of a guild. */
  keyOf: (guild: G) => string;
  /** The guild a place key names. */
  guildOf: (key: string) => G | undefined;
  /** The place key of the route's place: the guild on the selected saved server when ids coincide. */
  currentKey: (place: Place) => string;
  /** The guild of the route's place, the one on the selected saved server when ids coincide. */
  guildOfPlace: (place: Place) => G | undefined;
}

export function resolvePlaceKeys<G extends Keyed>(
  list: readonly G[],
  serverOrder: readonly string[],
  selectedServerId: string,
): PlaceKeys<G> {
  const keys = placeKeysFor(list, serverOrder);
  const byKey = new Map<string, G>();
  for (const guild of list) byKey.set(keys.get(identityOf(guild)) ?? guild.id, guild);
  const guildOfPlace = (place: Place): G | undefined => {
    if (place.kind !== 'server') return undefined;
    const named = list.filter((guild) => guild.id === place.guildId);
    // The selected saved server's; failing that the one that holds the bare id (a stable choice).
    return (
      named.find((guild) => guild.scope.serverId === selectedServerId) ??
      named.find((guild) => keys.get(identityOf(guild)) === guild.id) ??
      named[0]
    );
  };
  return {
    keyOf: (guild) => keys.get(identityOf(guild)) ?? guild.id,
    guildOf: (key) => byKey.get(key),
    guildOfPlace,
    currentKey: (place) => {
      const guild = guildOfPlace(place);
      return guild ? keys.get(identityOf(guild)) ?? guild.id : place.kind === 'server' ? place.guildId : 'people';
    },
  };
}

/** The servers this account shows and their place keys, with the selected saved server breaking ties. */
export function usePlaceKeys() {
  const guilds = useAvailableGuilds();
  const servers = useServerListStore((state) => state.servers);
  const selectedServerId = useServerListStore((state) => state.activeServerId ?? LOCAL_SERVER_ID);
  const keys = useMemo(
    () => resolvePlaceKeys(guilds, [LOCAL_SERVER_ID, ...servers.map((server) => server.id)], selectedServerId),
    [guilds, servers, selectedServerId],
  );
  return useMemo(() => ({ guilds, keys }), [guilds, keys]);
}
