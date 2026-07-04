import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';

// App-wide status banner (design-spec §7): an info-toned top bar with a
// matching lucide icon and --text-label copy, sliding in over --duration-normal.
export function RestartBanner() {
  const serverRestarting = useUIStore((s) => s.serverRestarting);
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {serverRestarting && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -20 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 px-4 py-2"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--accent-info) 16%, var(--bg-secondary))',
            borderBottom: '1px solid color-mix(in srgb, var(--accent-info) 45%, transparent)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <RefreshCw size={15} className="animate-spin" style={{ color: 'var(--accent-info)' }} />
          <span className="text-label" style={{ color: 'var(--accent-info)' }}>
            Server is restarting — you'll reconnect automatically
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
