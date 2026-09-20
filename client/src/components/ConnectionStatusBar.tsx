import { useEffect, useRef, useState } from 'react';
// §5.1/§5.3: the shared banner recipe (pc-banner-in / pc-banner-out) and the
// ONE reduced-motion switch — the presence hook keeps the bar mounted for its
// --duration-fast leave.
import { usePresence } from '../lib/motion';
import { Wifi, WifiOff } from 'lucide-react';
import { gateway } from '../gateway/manager';
import { useUIStore } from '../stores/uiStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { cn } from '../lib/utils';

type BannerTone = 'warning' | 'danger' | 'success';

const TONE: Record<
  BannerTone,
  { surface: string; edge: string; fg: string }
> = {
  warning: {
    surface: 'color-mix(in srgb, var(--accent-warning) 16%, var(--bg-raised))',
    edge: 'color-mix(in srgb, var(--accent-warning) 45%, transparent)',
    fg: 'var(--accent-warning)',
  },
  danger: {
    surface: 'color-mix(in srgb, var(--accent-danger) 16%, var(--bg-raised))',
    edge: 'color-mix(in srgb, var(--accent-danger) 45%, transparent)',
    fg: 'var(--accent-danger)',
  },
  success: {
    surface: 'color-mix(in srgb, var(--accent-success) 16%, var(--bg-raised))',
    edge: 'color-mix(in srgb, var(--accent-success) 45%, transparent)',
    fg: 'var(--accent-success)',
  },
};

const MESSAGES: Record<string, { tone: BannerTone; text: string }> = {
  reconnecting: { tone: 'warning', text: 'Reconnecting to the instance…' },
  disconnected: { tone: 'danger', text: 'Connection lost — retrying automatically' },
};

const RETRY_BUTTON =
  'ml-1 inline-flex h-7 items-center rounded-chip border border-current/30 px-2.5 text-meta font-semibold ' +
  'outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-current/10 ' +
  'focus-visible:shadow-[var(--focus-ring)]';

export function ConnectionStatusBar() {
  const status = useUIStore((s) => s.connectionStatus);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );
  const voiceConnected = useVoiceStore((s) => s.connected);
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
  const offlineVisible =
    status !== 'connected' && showBanner && !apiReachable && !voiceConnected && Boolean(info);
  const visible = offlineVisible || showConnected;

  const tone = showConnected
    ? TONE.success
    : info
      ? TONE[info.tone]
      : TONE.danger;
  const message = showConnected ? 'Back online' : info?.text ?? '';
  const { mounted, exiting, scenery } = usePresence(visible && Boolean(message));

  if (!mounted) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'flex w-full items-center justify-center gap-2 px-4 py-2',
        exiting ? 'pc-banner-out' : 'pc-banner-in',
      )}
      style={{
        backgroundColor: tone.surface,
        borderBottom: `1px solid ${tone.edge}`,
        boxShadow: 'var(--shadow-lifted)',
      }}
      {...scenery}
    >
      {/* §5.1 / WP9d: never a spinner on the street. A gateway that is
          away is drawn on the building — the whole thing dims 30% and holds
          there (`lib/motion/lights.ts`, played by `MotionDirector`) — and
          this banner says the words. A spinning ring next to them would be
          a second, decorative answer to the same question, and §5's law is
          that only light and the things people do move. */}
      {showConnected ? (
        <Wifi size={15} style={{ color: tone.fg }} />
      ) : (
        <WifiOff size={15} style={{ color: tone.fg }} />
      )}
      <span className="text-label" style={{ color: tone.fg }}>
        {message}
      </span>
      {!showConnected && status === 'disconnected' && (
        <button
          type="button"
          className={RETRY_BUTTON}
          style={{ color: tone.fg }}
          onClick={() => void gateway.connectAll()}
        >
          Retry
        </button>
      )}
    </div>
  );
}
