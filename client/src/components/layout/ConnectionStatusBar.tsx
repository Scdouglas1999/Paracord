import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { gateway } from '../../gateway/manager';

export function ConnectionStatusBar() {
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const [showConnected, setShowConnected] = useState(false);
  const [prevStatus, setPrevStatus] = useState(connectionStatus);

  useEffect(() => {
    // Show brief "Connected" banner when reconnecting → connected
    if (connectionStatus === 'connected' && (prevStatus === 'reconnecting' || prevStatus === 'disconnected')) {
      setShowConnected(true);
      const timer = setTimeout(() => setShowConnected(false), 2000);
      return () => clearTimeout(timer);
    }
    setPrevStatus(connectionStatus);
  }, [connectionStatus, prevStatus]);

  // When voice is active but gateway dropped, kick off an immediate reconnect
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
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          {connectionStatus === 'reconnecting' && (
            <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-warning/15 px-4 py-2 text-xs font-semibold text-accent-warning">
              <RefreshCw size={13} className="animate-spin" />
              Reconnecting...
            </div>
          )}
          {connectionStatus === 'disconnected' && (
            voiceConnected ? (
              <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-warning/15 px-4 py-2 text-xs font-semibold text-accent-warning">
                <RefreshCw size={13} className="animate-spin" />
                Chat disconnected — Retrying...
                <button
                  onClick={() => void gateway.connectAll()}
                  className="ml-1 rounded-md border border-accent-warning/35 bg-accent-warning/10 px-2 py-0.5 text-[11px] font-semibold transition-colors hover:bg-accent-warning/20"
                >
                  Retry now
                </button>
              </div>
            ) : (
              <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-danger/15 px-4 py-2 text-xs font-semibold text-accent-danger">
                <WifiOff size={13} />
                Disconnected
                <button
                  onClick={() => void gateway.connectAll()}
                  className="ml-1 rounded-md border border-accent-danger/35 bg-accent-danger/10 px-2 py-0.5 text-[11px] font-semibold transition-colors hover:bg-accent-danger/20"
                >
                  Retry now
                </button>
              </div>
            )
          )}
          {connectionStatus === 'connected' && showConnected && (
            <div className="mx-4 mb-3 mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-success/15 px-4 py-2 text-xs font-semibold text-accent-success">
              <Wifi size={13} />
              Connected
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
