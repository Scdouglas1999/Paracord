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
  const guildKey = useMemo(() => guilds.map((guild) => guild.id).join(','), [guilds]);
  useEffect(() => {
    if (!enabled || !userId) return;
    rememberRoute(pathname, userId, new Set(guildKey ? guildKey.split(',') : []));
  }, [enabled, pathname, userId, guildKey]);
}
