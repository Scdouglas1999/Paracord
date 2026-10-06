import { useMemo } from 'react';

import { LOCAL_SERVER_ID } from '../lib/serverScope';
import { useServerConnectionStore, type ServerConnectionPhase } from '../stores/serverConnectionStore';
import { useServerListStore, type ServerEntry } from '../stores/serverListStore';

/**
 * Whether REST to the selected server can be made yet.
 *
 * `getApi()` resolves the selected server's own client and refuses to stand in
 * another one, so while that server is still connecting, being retried or signed
 * out there is nothing to ask. A section that fetches when it mounts (the Events
 * page, Coming up, the Overview's widgets, the add-on rows) waits for this,
 * shows its quiet loading state meanwhile, and asks once the server is there;
 * the effect depends on `ready`, so it runs again by itself when the server
 * comes back.
 *
 * The home server (no selection, or the home scope) is always ready: its client
 * is the app's own. A saved server is ready once its connection says so
 * (`connected`: signed in, holding the realtime stream), which is also when its
 * places are in the stores.
 */
export interface ServerReadiness {
  ready: boolean;
  /** The selected saved server, for the words about it; null for the home server. */
  server: ServerEntry | null;
  /** Where its connection stands; null for the home server or one not asked about yet. */
  phase: ServerConnectionPhase | null;
}

export function useServerReadiness(): ServerReadiness {
  const activeServerId = useServerListStore((state) => state.activeServerId);
  const remote = activeServerId && activeServerId !== LOCAL_SERVER_ID ? activeServerId : null;
  const server = useServerListStore((state) => (remote ? state.servers.find((entry) => entry.id === remote) ?? null : null));
  const phase = useServerConnectionStore((state) => (remote ? state.servers[remote]?.phase ?? null : null));
  return useMemo(() => ({ ready: remote === null || phase === 'connected', server, phase }), [remote, server, phase]);
}

/** {@link useServerReadiness}, for a section that only needs to know whether to ask. */
export function useServerReady(): boolean {
  return useServerReadiness().ready;
}
