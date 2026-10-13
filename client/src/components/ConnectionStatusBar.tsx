import { useEffect, useRef, useState } from 'react';
// §5.1/§5.3: the shared banner recipe (pc-banner-in / pc-banner-out) and the
// ONE reduced-motion switch — the presence hook keeps the bar mounted for its
// --duration-fast leave.
import { usePresence } from '../lib/motion';
import { gateway } from '../gateway/manager';
import { useUIStore } from '../stores/uiStore';
import { useServerListStore } from '../stores/serverListStore';
import { useServerConnectionStore } from '../stores/serverConnectionStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { BannerStrip } from './ix/conversation/BannerStrip';

// Words only (docs/index-spec.md §6.8): the strip is the card's color with a hairline, never amber,
// green or red; "retrying" is a thing the strip says, not a thing its color shouts.
const MESSAGES: Record<string, { text: string }> = {
  reconnecting: { text: 'Reconnecting to the instance…' },
  disconnected: { text: 'Connection lost, retrying automatically' },
};

export function ConnectionStatusBar() {
  const status = useUIStore((s) => s.connectionStatus);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );
  const voiceConnected = useVoiceStore((s) => s.connected);
  const identityHeld = useServerConnectionStore((s) =>
    Object.values(s.servers).some((server) => server.phase === 'identity-changed'),
  );
  const signedIn = useCurrentUser() != null;

  const hasConnected = useRef(false);
  const [showBanner, setShowBanner] = useState(false);
  const [showConnected, setShowConnected] = useState(false);
  const [prevStatus, setPrevStatus] = useState(status);

  // Signing out drops the connection on purpose. Without this the sign-in
  // screen announced "Connection lost — retrying automatically" four seconds
  // after every sign-out, about a session that no longer exists.
  useEffect(() => {
    if (signedIn) return;
    hasConnected.current = false;
    setShowBanner(false);
    setShowConnected(false);
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    if (status === 'connected') {
      if (hasConnected.current && (prevStatus === 'reconnecting' || prevStatus === 'disconnected')) {
        setShowConnected(true);
        const timer = setTimeout(() => setShowConnected(false), 2000);
        setPrevStatus(status);
        setShowBanner(false);
        return () => clearTimeout(timer);
      }
      hasConnected.current = true;
      setShowBanner(false);
      setPrevStatus(status);
      return;
    }
    setPrevStatus(status);
    if (!hasConnected.current) return;
    const timer = setTimeout(() => setShowBanner(true), 4000);
    return () => clearTimeout(timer);
  }, [status, prevStatus, signedIn]);

  useEffect(() => {
    if (voiceConnected && status === 'disconnected') {
      void gateway.connectAll();
    }
  }, [voiceConnected, status]);

  const apiReachable = Boolean(activeServer?.apiReachable);
  const info = MESSAGES[status];
  // Nothing is retrying a server held for an identity change: its own strip
  // (ServerSessionBanner) says what happened, and "retrying automatically" would not be true.
  const offlineVisible =
    status !== 'connected' &&
    showBanner &&
    !apiReachable &&
    !voiceConnected &&
    !(status === 'disconnected' && identityHeld) &&
    Boolean(info);
  const visible = offlineVisible || showConnected;

  const message = showConnected ? 'Back online' : info?.text ?? '';
  const { mounted, exiting, scenery } = usePresence(visible && Boolean(message));

  if (!mounted) return null;

  // §5.1 / WP9d: never a spinner on the street. A gateway that is away is drawn on the building,
  // and this strip says the words; a spinning ring next to them would be a second, decorative
  // answer to the same question.
  return (
    <BannerStrip
      data-testid="ix-banner-connection"
      className={exiting ? 'pc-banner-out' : 'pc-banner-in'}
      action={!showConnected && status === 'disconnected' ? { label: 'Retry now', onPress: () => void gateway.connectAll() } : undefined}
      {...scenery}
    >
      {message}
    </BannerStrip>
  );
}
