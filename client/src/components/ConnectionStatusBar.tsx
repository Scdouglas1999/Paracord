import { useUIStore } from '../stores/uiStore';
import { useServerListStore } from '../stores/serverListStore';

export function ConnectionStatusBar() {
  const status = useUIStore((s) => s.connectionStatus);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );

  if (status === 'connected') return null;

  const apiReachable = Boolean(activeServer?.apiReachable);
  if (apiReachable) return null;

  const messages: Record<string, { text: string; color: string }> = {
    connecting: { text: 'Connecting...', color: 'var(--status-warning, #faa61a)' },
    reconnecting: { text: 'Reconnecting...', color: 'var(--status-warning, #faa61a)' },
    disconnected: { text: 'Disconnected', color: 'var(--status-danger, #ed4245)' },
  };

  const info = messages[status];
  if (!info) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        backgroundColor: info.color,
        color: '#fff',
        textAlign: 'center',
        padding: '4px 8px',
        fontSize: '13px',
        fontWeight: 500,
      }}
    >
      {info.text}
    </div>
  );
}
