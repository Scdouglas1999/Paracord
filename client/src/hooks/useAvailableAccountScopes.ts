import { useMemo } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { LOCAL_SERVER_ID, type AccountScope } from '../lib/serverScope';

export function useAvailableAccountScopes() {
  const user = useAuthStore(state => state.user);
  const token = useAuthStore(state => state.token);
  const servers = useServerListStore(state => state.servers);
  return useMemo(() => {
    const scopes: AccountScope[] = user && token ? [{ serverId: LOCAL_SERVER_ID, userId: user.id }] : [];
    for (const server of servers) if (server.token && server.user && server.user.id === server.userId) scopes.push({ serverId: server.id, userId: server.user.id });
    return scopes;
  }, [user, token, servers]);
}
