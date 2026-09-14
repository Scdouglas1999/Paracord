import { useMemo } from 'react';
import { useGuildStore } from '../stores/guildStore';
import { findScopedGuild } from '../lib/guildScope';
import { useCurrentAccountScope } from './useCurrentUser';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { findHomeServerEntry } from '../lib/serverIdentity';
import { accountScopeKey, LOCAL_SERVER_ID } from '../lib/serverScope';

/** A route ID is interpreted only inside the account shown by that route. */
export function useGuild(id: string | null | undefined) {
  const scope = useCurrentAccountScope();
  return useGuildStore(state => findScopedGuild(state.guilds, scope, id));
}
export function useSelectedGuildId() {
  const scope = useCurrentAccountScope();
  const selected = useGuildStore(state => state.selectedGuild);
  return scope && selected && accountScopeKey(scope) === accountScopeKey(selected.scope) ? selected.id : null;
}
export function useCurrentGuilds() {
  const scope = useCurrentAccountScope();
  const guilds = useGuildStore(state => state.guilds);
  return useMemo(() => scope ? guilds.filter(guild => accountScopeKey(guild.scope) === accountScopeKey(scope)) : [], [guilds, scope]);
}
/**
 * Cross-server surfaces include only the account currently verified on each
 * host — and one host contributes one account. When a server-list entry stands
 * for the home server (always, on the desktop) the `__local__` scope is the
 * same account reached by another name, and counting both listed every
 * building, and every person in it, twice.
 */
export function useAvailableGuilds() {
  const guilds = useGuildStore(state => state.guilds);
  const user = useAuthStore(state => state.user);
  const token = useAuthStore(state => state.token);
  const servers = useServerListStore(state => state.servers);
  return useMemo(() => {
    const homeEntry = findHomeServerEntry(servers, token);
    return guilds.filter(guild => {
      if (guild.scope.serverId === LOCAL_SERVER_ID) return !homeEntry && !!token && user?.id === guild.scope.userId;
      const server = servers.find(entry => entry.id === guild.scope.serverId);
      return !!server?.token && server.user?.id === guild.scope.userId && server.userId === guild.scope.userId;
    });
  }, [guilds, user, token, servers]);
}
