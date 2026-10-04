import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import { useAvailableChannels } from '../../../hooks/useChannels';
import { useAvailableAccountScopes } from '../../../hooks/useAvailableAccountScopes';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { snowflakeToMs } from '../../../lib/attention/conversationModel';
import { guildLandingPath } from '../../../lib/guildNavigation';
import { accountScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useGuildStore } from '../../../stores/guildStore';
import { toast } from '../../../stores/toastStore';
import { readPlaceMemory, resolveLastPlace, type PlaceMemory } from './lastPlace';

export interface LastPlaceRedirectProps {
  /** `app`: the route `/app`, the last place. `dms`: the route `/app/dms`, the last People item. */
  mode: 'app' | 'dms';
}

/**
 * `/app` and `/app/dms` (docs/index-spec.md §8.1): not pages, a way back to where
 * you were. Home is retired; its content lives in the dock's dots, each server's card
 * and Coming up, and People's Friends and Inbox.
 *
 * What it needs that may not have arrived on a cold launch is the list of your servers
 * and your conversations. It asks for both (a request already under way is joined, not
 * repeated), and a server or conversation that is not in the answer is gone: People
 * opens instead. Nothing is guessed while it waits, and nothing is shown but a status.
 */
export function LastPlaceRedirect({ mode }: LastPlaceRedirectProps) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const guilds = useAvailableGuilds();
  const channels = useAvailableChannels();
  const scopes = useAvailableAccountScopes();
  const scopesKey = scopes.map(accountScopeKey).join('|');
  const [settled, setSettled] = useState(false);
  const arrived = useRef(false);

  // Ask for what the answer needs; settled once both have answered, or failed (the failure is the
  // stores' to report, and a list that failed to load is no reason to hold the app on a blank).
  // Nothing is asked, and nothing is settled, before there is an account to ask as: on a cold launch
  // the user arrives a beat after the shell, and "no servers" would be a guess.
  useEffect(() => {
    if (scopes.length === 0) return;
    let live = true;
    void Promise.allSettled([
      useChannelStore.getState().loadAllDmChannels(),
      ...scopes.map((scope) => useGuildStore.getState().fetchGuilds(scope)),
    ]).then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
    // The scopes are named by their keys: the array is a new one whenever the stores change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopesKey]);

  const memory = useMemo<PlaceMemory | null>(() => {
    const stored = readPlaceMemory();
    return stored && user && stored.userId === user.id ? stored : null;
    // Read once per mount of the route: the redirect leaves before the memory can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const guildIds = useMemo(() => guilds.map((guild) => guild.id), [guilds]);
  const dmIds = useMemo(
    () =>
      channels
        .filter((channel) => !channel.guild_id)
        .map((channel) => ({ id: channel.id, at: channel.last_message_id ? snowflakeToMs(channel.last_message_id) : 0 }))
        .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
        .map((entry) => entry.id),
    [channels],
  );

  const resolution = resolveLastPlace({ mode, memory, guildIds, dmIds, settled: settled && scopes.length > 0 });
  const resolutionKey = resolution.kind === 'wait' ? 'wait' : resolution.kind === 'go' ? `go:${resolution.path}` : `landing:${resolution.guildId}`;

  useEffect(() => {
    if (arrived.current || resolution.kind === 'wait') return;
    arrived.current = true;
    if (resolution.kind === 'go') {
      navigate(resolution.path, { replace: true });
      return;
    }
    const guild = guilds.find((candidate) => candidate.id === resolution.guildId);
    if (!guild) {
      navigate('/app/friends', { replace: true });
      return;
    }
    void guildLandingPath(guild).then(
      (path) => navigate(path, { replace: true }),
      (error) => {
        // Say so, and open People: a place that cannot be opened must not hold the app on a blank.
        toast.error(`Failed to open ${guild.name}: ${extractApiError(error)}`);
        navigate('/app/friends', { replace: true });
      },
    );
    // `resolutionKey` stands for `resolution`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolutionKey]);

  return (
    <div className="ix-redirect" role="status" aria-busy="true" data-testid="ix-redirect">
      <span className="sr-only">Opening where you left off…</span>
    </div>
  );
}
