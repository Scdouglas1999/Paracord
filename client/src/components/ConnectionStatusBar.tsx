import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';

export function ConnectionStatusBar() {
  const status = useUIStore((s) => s.connectionStatus);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );
  const voiceConnected = useVoiceStore((s) => s.connected);

  // Don't show the banner until we've been connected at least once.
  // This prevents a flash of "Disconnected" on startup before the
  // gateway has had time to establish its first connection.
  const hasConnected = useRef(false);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (status === 'connected') {
      hasConnected.current = true;
      setShowBanner(false);
      return;
    }
    // Only show the banner after we've previously been connected.
    if (!hasConnected.current) return;
    // Brief grace period to avoid flashing during transient reconnects.
    const timer = setTimeout(() => setShowBanner(true), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  if (status === 'connected' || !showBanner) return null;

  const apiReachable = Boolean(activeServer?.apiReachable);
  if (apiReachable) return null;
  // Voice connectivity proves the network is up; suppress the banner.
  if (voiceConnected) return null;

  const messages: Record<string, { text: string; color: string }> = {
    reconnecting: { text: 'Reconnecting...', color: 'var(--status-warning, #faa61a)' },
    disconnected: { text: 'Disconnected', color: 'var(--status-danger, #ed4245)' },
  };

  const info = messages[status];
  if (!info) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
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
