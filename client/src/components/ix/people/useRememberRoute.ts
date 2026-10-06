import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router';

import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { rememberRoute } from './lastPlace';

/**
 * Remember the route you are on, so `/app` can open it next time (`lastPlace.ts`).
 * One call, from the sidebar slot, for the pane that is not sliding out: that pane
 * exists for every place and every app route, and it is the one place that knows
 * the route and the servers you are in together.
 */
export function useRememberRoute(enabled: boolean): void {
  const { pathname } = useLocation();
  const userId = useCurrentUser()?.id ?? null;
  const guilds = useAvailableGuilds();
  // `id:server` pairs, so the effect runs when the list changes, not when its array does.
  const guildKey = useMemo(() => guilds.map((guild) => `${guild.id}:${guild.scope.serverId}`).join(','), [guilds]);
  useEffect(() => {
    if (!enabled || !userId) return;
    const pairs = guildKey ? guildKey.split(',').map((pair) => pair.split(':') as [string, string]) : [];
    rememberRoute(pathname, userId, new Set(pairs.map(([id]) => id)), new Map(pairs));
  }, [enabled, pathname, userId, guildKey]);
}
