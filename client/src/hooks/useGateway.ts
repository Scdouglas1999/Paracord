import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { gateway } from '../gateway/manager';

export function useGateway() {
  const token = useAuthStore((s) => s.token);
  const serverSyncKey = useServerListStore((s) =>
    s.servers.map((server) => `${server.id}:${server.url}:${server.token ?? ''}`).join('|')
  );
  const storesHydrated = useServerListStore((s) => s.hydrated && s.tokensHydrated);

  useEffect(() => {
    if (!storesHydrated) return;

    if (!token) {
      gateway.disconnectAll();
      return;
    }

    void gateway.syncServers().catch(() => {
      // Per-server errors are handled inside gateway manager.
    });
  }, [token, storesHydrated, serverSyncKey]);

  useEffect(
    () => () => {
      gateway.disconnectAll();
    },
    []
  );
}
