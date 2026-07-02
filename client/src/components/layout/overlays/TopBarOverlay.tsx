import type { ReactNode, RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../../lib/utils';

interface TopBarOverlayProps {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  panelClassName: string;
  children: ReactNode;
}

export function TopBarOverlay({
  open,
  onClose,
  dialogRef,
  titleId,
  panelClassName,
  children,
}: TopBarOverlayProps) {
  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-2 pb-[calc(var(--safe-bottom)+0.75rem)] pt-[calc(var(--safe-top)+3.75rem)] sm:px-4 sm:pt-20 modal-backdrop"
          onClick={onClose}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.18 }}
            className={cn('glass-modal overflow-hidden rounded-xl border sm:rounded-2xl', panelClassName)}
            onClick={(event) => event.stopPropagation()}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
