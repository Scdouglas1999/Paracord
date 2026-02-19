import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { useConfirmStore } from '../../stores/confirmStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { cn } from '../../lib/utils';

export function ConfirmDialog() {
  const isOpen = useConfirmStore((s) => s.isOpen);
  const options = useConfirmStore((s) => s.options);
  const close = useConfirmStore((s) => s.close);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, isOpen, () => close(false));

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  return createPortal(
    <AnimatePresence>
      {isOpen && options && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center px-4"
          style={{ backgroundColor: 'var(--overlay-backdrop)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => close(false)}
        >
          <motion.div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby={options.description ? 'confirm-dialog-desc' : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.18 }}
            className="glass-modal w-full max-w-[440px] overflow-hidden rounded-2xl border"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 pb-2 pt-6">
              {options.variant === 'danger' && (
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-danger/12 text-accent-danger">
                  <AlertTriangle size={20} />
                </div>
              )}
              <h2 id="confirm-dialog-title" className="text-lg font-bold text-text-primary">
                {options.title}
              </h2>
              {options.description && (
                <p id="confirm-dialog-desc" className="mt-2 text-sm leading-relaxed text-text-secondary">
                  {options.description}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 px-6 pb-5 pt-4">
              <button
                className="h-10 rounded-xl border border-border-strong px-5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                onClick={() => close(false)}
              >
                {options.cancelLabel || 'Cancel'}
              </button>
              <button
                className={cn(
                  'h-10 rounded-xl px-5 text-sm font-semibold text-white transition-colors',
                  options.variant === 'danger'
                    ? 'bg-accent-danger hover:bg-accent-danger/85'
                    : 'bg-accent-primary hover:bg-accent-primary-hover'
                )}
                onClick={() => close(true)}
                autoFocus
              >
                {options.confirmLabel || 'Confirm'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
