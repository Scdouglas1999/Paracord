import { safeStoredImageDataUrl } from '../lib/security';
import { LOCAL_SERVER_ID, type AccountScope } from '../lib/serverScope';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';

/** LitAvatar's file transport belongs to the active account, so never retarget a foreign path. */
export function avatarForScope(
  avatar: string | null | undefined,
  scope: AccountScope,
  activeScope: AccountScope | null,
): string | null {
  if (!avatar) return null;
  if (avatar.startsWith('data:')) return safeStoredImageDataUrl(avatar);
  return activeScope?.serverId === scope.serverId && activeScope.userId === scope.userId
    ? avatar
    : null;
}

/** Resolve once per avatar group; every member shares the image transport's active account. */
export function useAvatarScope(): AccountScope | null {
  const activeServerId = useServerListStore((state) => state.activeServerId ?? LOCAL_SERVER_ID);
  const homeUserId = useAuthStore((state) => state.token ? state.user?.id : undefined);
  const serverUserId = useServerListStore((state) => {
    const server = state.servers.find((row) => row.id === activeServerId);
    return server?.token && server.user?.id === server.userId ? server.userId : undefined;
  });
  const activeUserId = activeServerId === LOCAL_SERVER_ID ? homeUserId : serverUserId;
  return activeUserId ? { serverId: activeServerId, userId: activeUserId } : null;
}

export function useScopedAvatar(avatar: string | null | undefined, scope: AccountScope): string | null {
  return avatarForScope(avatar, scope, useAvatarScope());
}
