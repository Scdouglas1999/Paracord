import { useMemo } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { LOCAL_SERVER_ID, type AccountScope } from '../lib/serverScope';

/** Read the selected server's verified account; an unverified remote has no user. */
export function useCurrentUser() {
  const localUser = useAuthStore((state) => state.user);
  const serverId = useServerListStore((state) => state.activeServerId ?? LOCAL_SERVER_ID);
  const remoteUser = useServerListStore((state) => {
    if (serverId === LOCAL_SERVER_ID) return null;
    const server = state.servers.find((entry) => entry.id === serverId);
    return server?.token && server.user && server.user.id === server.userId ? server.user : null;
  });
  return serverId === LOCAL_SERVER_ID ? localUser : remoteUser;
}

/** Stable account scope for selectors and event handlers in the current view. */
export function useCurrentAccountScope(): AccountScope | null {
  const userId = useCurrentUser()?.id;
  const serverId = useServerListStore(state => state.activeServerId ?? LOCAL_SERVER_ID);
  return useMemo(() => userId ? { serverId, userId } : null, [serverId, userId]);
}
