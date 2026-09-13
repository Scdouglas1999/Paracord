import type { User } from '../types';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { LOCAL_SERVER_ID, type AccountScope } from './serverScope';

export function getServerUser(serverId: string): User | null {
  if (serverId === LOCAL_SERVER_ID) return useAuthStore.getState().user;
  const server = useServerListStore.getState().getServer(serverId);
  return server?.token && server.user && server.user.id === server.userId ? server.user : null;
}

/** Public gateway projections can update an authenticated account, not establish one. */
export function mergeServerUserProjection(serverId: string, projection: Partial<User> & Pick<User, 'id'>): void {
  if (serverId !== LOCAL_SERVER_ID) {
    useServerListStore.getState().mergeUserProjection(serverId, projection);
    return;
  }
  const current = useAuthStore.getState().user;
  if (current?.id === projection.id) {
    useAuthStore.setState({ user: { ...current, ...projection } });
  }
}

export function getServerAccountScope(serverId: string): AccountScope | null {
  const user = getServerUser(serverId);
  return user ? { serverId, userId: user.id } : null;
}
