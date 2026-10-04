import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { guildLandingPath } from '../../../lib/guildNavigation';
import { toast } from '../../../stores/toastStore';
import { placeOfPath } from '../shell/place';
import { PEOPLE_KEY } from './dockModel';

/** Where People opens (IX-14 makes this the last People item). */
export const PEOPLE_PATH = '/app/dms';

/**
 * One way to go to a place, for a click on the dock, Ctrl+Alt+Up/Down and
 * Ctrl+1…9 alike. The shell follows the route, so switching is navigating (§4.8).
 *
 *   People   `/app/dms`.
 *   a server its landing channel (`guildLandingPath`: the default channel, else
 *            the first text channel, else the server's own page).
 *
 * Picking the place you are already in changes nothing when you are in one of
 * its conversations (a click must not throw you back to the landing channel);
 * from one of its other pages (overview, settings, add-ons) it takes you to a
 * channel. Returns a promise that settles when the route has changed (or the
 * attempt has failed loudly, with a toast).
 */
export function useGoToPlace(): (key: string) => Promise<void> {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const guilds = useAvailableGuilds();

  return useCallback(
    async (key: string) => {
      const here = placeOfPath(pathname);
      const inChannel = /\/channels\//.test(pathname);
      if (key === PEOPLE_KEY) {
        if (here?.kind === 'people') return;
        navigate(PEOPLE_PATH);
        return;
      }
      const guild = guilds.find((candidate) => candidate.id === key);
      if (!guild) return;
      if (here?.kind === 'server' && here.guildId === key && inChannel) return;
      try {
        navigate(await guildLandingPath(guild));
      } catch (error) {
        toast.error(`Failed to open ${guild.name}: ${extractApiError(error)}`);
      }
    },
    [guilds, navigate, pathname],
  );
}
