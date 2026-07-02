import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { gateway } from '../gateway/manager';
import { logVoiceDiagnostic } from '../lib/desktopDiagnostics';

export function useGateway() {
  const token = useAuthStore((s) => s.token);
  const serverSyncKey = useServerListStore((s) =>
    s.servers.map((server) => `${server.id}:${server.url}:${server.token ?? ''}`).join('|')
  );
  const storesHydrated = useServerListStore((s) => s.hydrated && s.tokensHydrated);

  useEffect(() => {
    logVoiceDiagnostic('[gateway] useGateway effect fired', {
      storesHydrated,
      hasToken: !!token,
      serverSyncKey: serverSyncKey.substring(0, 80),
      hydrated: useServerListStore.getState().hydrated,
      tokensHydrated: useServerListStore.getState().tokensHydrated,
    });

    if (!storesHydrated) {
      logVoiceDiagnostic('[gateway] useGateway: stores not hydrated, skipping');
      return;
    }

    const hasServers = useServerListStore.getState().servers.length > 0;

    if (!token && !hasServers) {
      logVoiceDiagnostic('[gateway] useGateway: no token and no servers, disconnecting');
      gateway.disconnectAll();
      return;
    }

    logVoiceDiagnostic('[gateway] useGateway: calling syncServers', { hasToken: !!token, hasServers });
    void gateway.syncServers().catch((err) => {
      logVoiceDiagnostic('[gateway] useGateway: syncServers error', { error: String(err) });
    });
  }, [token, storesHydrated, serverSyncKey]);

  useEffect(
    () => () => {
      gateway.disconnectAll();
    },
    []
  );
}
