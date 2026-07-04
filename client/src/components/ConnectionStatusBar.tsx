import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Loader2, Wifi, WifiOff } from 'lucide-react';
import { gateway } from '../gateway/manager';
import { useUIStore } from '../stores/uiStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';

type BannerTone = 'warning' | 'danger' | 'success';

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
  success: {
    surface: 'color-mix(in srgb, var(--accent-success) 16%, var(--bg-secondary))',
    edge: 'color-mix(in srgb, var(--accent-success) 45%, transparent)',
    fg: 'var(--accent-success)',
  },
};

const MESSAGES: Record<string, { tone: BannerTone; text: string }> = {
  reconnecting: { tone: 'warning', text: 'Reconnecting to the server…' },
  disconnected: { tone: 'danger', text: 'Connection lost — retrying automatically' },
};

const RETRY_BUTTON =
  'ml-1 inline-flex h-7 items-center rounded-sm border border-current/30 px-2.5 text-meta font-semibold ' +
  'outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-current/10 ' +
  'focus-visible:shadow-[var(--focus-ring)]';

export function ConnectionStatusBar() {
  const status = useUIStore((s) => s.connectionStatus);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );
  const voiceConnected = useVoiceStore((s) => s.connected);
  const reduceMotion = useReducedMotion();

  const hasConnected = useRef(false);
  const [showBanner, setShowBanner] = useState(false);
  const [showConnected, setShowConnected] = useState(false);
  const [prevStatus, setPrevStatus] = useState(status);

  useEffect(() => {
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
  }, [status, prevStatus]);

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

  const reconnecting = status === 'reconnecting';
  const tone = showConnected
    ? TONE.success
    : info
      ? TONE[info.tone]
      : TONE.danger;
  const message = showConnected ? 'Back online' : info?.text ?? '';

  return (
    <AnimatePresence>
      {visible && message && (
        <motion.div
          role="status"
          aria-live="polite"
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
          {showConnected ? (
            <Wifi size={15} style={{ color: tone.fg }} />
          ) : reconnecting ? (
            <Loader2 size={15} className="animate-spin" style={{ color: tone.fg }} />
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}
