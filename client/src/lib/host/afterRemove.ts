import { clearStoredServerUrl, getStoredServerUrl, setStoredServerUrl } from '../config/apiBaseUrl';
import { connectionManager } from '../connectionManager';
import { LOCAL_SERVER_ID, sameServerUrl } from '../serverScope';
import { useAuthStore } from '../../stores/authStore';
import { useFirstRunStore } from '../../stores/firstRunStore';
import { useServerListStore } from '../../stores/serverListStore';

/** Where the app goes once the removed server is no longer part of it. */
export type AfterRemove =
  /** Nothing else is saved: the first-run welcome screen. */
  | { kind: 'welcome' }
  /** Another saved server took its place. */
  | { kind: 'switched'; serverId: string }
  /** The app was never signed in to the removed server. */
  | { kind: 'unchanged' };

/**
 * After **Remove from this computer** succeeded: the server on this computer's
 * own `127.0.0.1` origin is gone, so take it out of the app instead of leaving
 * it behind as an "unavailable" server.
 *
 * - Its saved entries are removed, with their connections and tokens.
 * - When it was the home server (the stored address, the home session), the
 *   address is replaced by another saved server's, or cleared, and the home
 *   session is signed out (the server cannot hear it, so nothing waits on it).
 * - No saved server left: the answer is the first-run welcome screen.
 *   Otherwise another one becomes the active server.
 *
 * `hostUrl` is the host's `home_url`, read before it was removed.
 */
export async function leaveRemovedHost(hostUrl: string): Promise<AfterRemove> {
  const list = useServerListStore.getState();
  const stored = getStoredServerUrl();
  const homeWasHost = !!stored && sameServerUrl(stored, hostUrl);

  const entries = list.servers.filter((server) => sameServerUrl(server.url, hostUrl));
  for (const entry of entries) {
    connectionManager.dropServer(entry.id);
    list.removeServer(entry.id);
  }
  if (homeWasHost) connectionManager.dropServer(LOCAL_SERVER_ID);

  if (!homeWasHost && entries.length === 0) return { kind: 'unchanged' };

  const remaining = useServerListStore.getState().servers;
  const next = remaining[0];
  if (homeWasHost) {
    if (next) setStoredServerUrl(next.url);
    else clearStoredServerUrl();
    await useAuthStore.getState().logout();
  }
  if (!next) {
    useFirstRunStore.getState().reset();
    return { kind: 'welcome' };
  }
  useServerListStore.getState().setActive(next.id);
  return { kind: 'switched', serverId: next.id };
}
