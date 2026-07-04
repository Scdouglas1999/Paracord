import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Loader2, WifiOff } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';

// App-wide connectivity banner (design-spec §7 Toast/banner language): a slim
// top bar on a semantic tinted surface with a matching lucide icon and a
// --text-label message, sliding in over --duration-normal. This is the
// top-level variant; the layout/ConnectionStatusBar.tsx variant is owned
// elsewhere.
type BannerTone = 'warning' | 'danger';

const TONE: Record<
  BannerTone,
  { surface: string; edge: string; fg: string }
> = {
  warning: {
    surface: 'color-mix(in srgb, var(--accent-warning) 16%, var(--bg-secondary))',
    edge: 'color-mix(in srgb, var(--accent-warning) 45%, transparent)',
    fg: 'var(--accent-warning)',
  },
  danger: {
    surface: 'color-mix(in srgb, var(--accent-danger) 16%, var(--bg-secondary))',
    edge: 'color-mix(in srgb, var(--accent-danger) 45%, transparent)',
    fg: 'var(--accent-danger)',
  },
};

const MESSAGES: Record<string, { tone: BannerTone; text: string }> = {
  reconnecting: { tone: 'warning', text: 'Reconnecting to the server…' },
  disconnected: { tone: 'danger', text: 'Connection lost — retrying automatically' },
};

export function ConnectionStatusBar() {
  const status = useUIStore((s) => s.connectionStatus);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );
  const voiceConnected = useVoiceStore((s) => s.connected);
  const reduceMotion = useReducedMotion();

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

  const apiReachable = Boolean(activeServer?.apiReachable);
  const info = MESSAGES[status];
  // Voice connectivity proves the network is up; suppress the banner.
  const visible =
    status !== 'connected' && showBanner && !apiReachable && !voiceConnected && Boolean(info);

  const tone = info ? TONE[info.tone] : TONE.danger;
  const reconnecting = status === 'reconnecting';

  return (
    <AnimatePresence>
      {visible && info && (
        <motion.div
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -20 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-x-0 top-0 z-[9999] flex items-center justify-center gap-2 px-4 py-2"
          style={{
            backgroundColor: tone.surface,
            borderBottom: `1px solid ${tone.edge}`,
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {reconnecting ? (
            <Loader2 size={15} className="animate-spin" style={{ color: tone.fg }} />
          ) : (
            <WifiOff size={15} style={{ color: tone.fg }} />
          )}
          <span className="text-label" style={{ color: tone.fg }}>
            {info.text}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
