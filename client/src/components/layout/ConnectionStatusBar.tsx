import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { gateway } from '../../gateway/manager';

const RETRY_BUTTON =
  'ml-1 inline-flex h-7 items-center rounded-sm border border-current/30 px-2.5 text-meta font-semibold ' +
  'outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-current/10 ' +
  'focus-visible:shadow-[var(--focus-ring)]';

export function ConnectionStatusBar() {
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const [showConnected, setShowConnected] = useState(false);
  const [prevStatus, setPrevStatus] = useState(connectionStatus);

  useEffect(() => {
    // Show a brief "back online" banner when reconnecting → connected.
    if (connectionStatus === 'connected' && (prevStatus === 'reconnecting' || prevStatus === 'disconnected')) {
      setShowConnected(true);
      const timer = setTimeout(() => setShowConnected(false), 2000);
      return () => clearTimeout(timer);
    }
    setPrevStatus(connectionStatus);
  }, [connectionStatus, prevStatus]);

  // When voice is active but the gateway dropped, kick off an immediate reconnect
  // since voice connectivity proves the network is reachable.
  useEffect(() => {
    if (voiceConnected && connectionStatus === 'disconnected') {
      void gateway.connectAll();
    }
  }, [voiceConnected, connectionStatus]);

  const visible = connectionStatus === 'reconnecting' || connectionStatus === 'disconnected' || showConnected;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          {connectionStatus === 'reconnecting' && (
            <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-md bg-warning-tint px-4 py-1.5 text-label font-medium text-accent-warning">
              <RefreshCw size={14} className="animate-spin" />
              Reconnecting to server…
            </div>
          )}
          {connectionStatus === 'disconnected' && (
            voiceConnected ? (
              <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-md bg-warning-tint px-4 py-1.5 text-label font-medium text-accent-warning">
                <RefreshCw size={14} className="animate-spin" />
                Chat connection dropped — retrying…
                <button onClick={() => void gateway.connectAll()} className={RETRY_BUTTON}>
                  Retry now
                </button>
              </div>
            ) : (
              <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-md bg-danger-tint px-4 py-1.5 text-label font-medium text-accent-danger">
                <WifiOff size={14} />
                You&apos;re offline — messages will send once you reconnect.
                <button onClick={() => void gateway.connectAll()} className={RETRY_BUTTON}>
                  Retry now
                </button>
              </div>
            )
          )}
          {connectionStatus === 'connected' && showConnected && (
            <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-md bg-success-tint px-4 py-1.5 text-label font-medium text-accent-success">
              <Wifi size={14} />
              Back online
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
