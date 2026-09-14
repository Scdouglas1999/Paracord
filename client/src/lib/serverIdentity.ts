import type { User } from '../types';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore, type ServerEntry } from '../stores/serverListStore';
import { getCurrentOriginServerUrl, getStoredServerUrl } from './config/apiBaseUrl';
import { LOCAL_SERVER_ID, sameServerUrl, type AccountScope } from './serverScope';

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

/**
 * Where the home session lives.
 *
 * `configuredHomeServerUrl` answers only when a server was actually configured;
 * `resolveHomeServerUrl` always answers, falling back to a guess so a connect
 * attempt has somewhere to go. A guess must never be shown to the user as a
 * server to trust, so the two are kept apart.
 */
export function configuredHomeServerUrl(): string | null {
  const stored = getStoredServerUrl();
  if (stored) return stored;
  const currentOrigin = getCurrentOriginServerUrl();
  if (currentOrigin) return currentOrigin;
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol) && window.location.host) {
    return `${window.location.protocol}//${window.location.host}`;
  }
  return null;
}

export function resolveHomeServerUrl(): string {
  return configuredHomeServerUrl() ?? 'http://localhost:8080';
}

/**
 * The server-list entry that stands for the home server, when one exists.
 *
 * `__local__` is the home *session* — the account behind the process-global
 * access token — not a server of its own. In a browser served by its own
 * Paracord instance those are separate things. On the desktop they are not: the
 * shell has no origin server, so it always adds its own server by address, and
 * that entry IS the home server. Holding both identities open made one account
 * look like two, and every building, member, DM and unread badge was counted
 * twice on a fresh install.
 *
 * `connectionManager` already refuses to open a second `__local__` transport
 * for a covered host. This is the same rule, one layer up, for identity.
 */
export function findHomeServerEntry(
  servers: readonly ServerEntry[] = useServerListStore.getState().servers,
  homeToken: string | null = useAuthStore.getState().token,
  homeUrl: string = resolveHomeServerUrl(),
): ServerEntry | undefined {
  const normalizedHomeUrl = homeUrl.replace(/\/+$/, '');
  return servers.find(
    (server) => sameServerUrl(server.url, normalizedHomeUrl) || (!!homeToken && server.token === homeToken),
  );
}

/** True when `__local__` would be a second identity for a server already listed. */
export function isHomeScopeCovered(
  servers?: readonly ServerEntry[],
  homeToken?: string | null,
): boolean {
  return !!findHomeServerEntry(servers, homeToken);
}

/**
 * Every server id to visit when sweeping all signed-in accounts. Never yields
 * two ids for one server: `__local__` is listed only while no entry covers it.
 */
export function accountScopeServerIds(entryIds: readonly string[]): string[] {
  return isHomeScopeCovered() ? [...entryIds] : [LOCAL_SERVER_ID, ...entryIds];
}
