import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { cn } from '../../lib/utils';

/**
 * Single base modal/dialog primitive for the app. Owns the portal, backdrop,
 * enter/exit motion (~240ms, matching --duration-slow/--ease-out), ARIA
 * wiring, focus trap and Escape handling. Complex consumers that already manage
 * their own focus trap can opt out with `manageFocus={false}` and pass their own
 * `panelRef`.
 *
 * Imported (not edited) by other lanes — keep this export surface stable.
 */

type ModalPlacement = 'center' | 'top';
type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'auto';

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'w-full max-w-[440px]',
  md: 'w-full max-w-[560px]',
  lg: 'w-full max-w-2xl',
  xl: 'w-full max-w-3xl',
  auto: '',
};

const PLACEMENT_CLASS: Record<ModalPlacement, string> = {
  center: 'items-center justify-center px-4',
  top: 'items-start justify-center px-4 pt-[12vh]',
};

// Modal enter (design-spec §5): 240ms ease-out, scale(.96→1) + translateY(8→0) + fade.
const PANEL_MOTION = {
  center: {
    initial: { opacity: 0, scale: 0.96, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.96, y: 8 },
  },
  top: {
    initial: { opacity: 0, scale: 0.96, y: -12 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.96, y: -12 },
  },
} as const;

const MODAL_TRANSITION = { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const };

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Dialog semantics. Use `alertdialog` for confirm/destructive prompts. */
  role?: 'dialog' | 'alertdialog';
  /** id of the title element for aria-labelledby. */
  labelledBy?: string;
  /** id of the description element for aria-describedby. */
  describedBy?: string;
  /** Fallback accessible name when there is no visible title element. */
  ariaLabel?: string;
  placement?: ModalPlacement;
  size?: ModalSize;
  /** Extra classes for the panel (glass-modal shell). */
  panelClassName?: string;
  /** Extra classes for the backdrop container. */
  backdropClassName?: string;
  /** z-index layer for the backdrop. Defaults to 60. */
  zIndexClassName?: string;
  /** Close when the backdrop is clicked. Defaults to true. */
  closeOnBackdrop?: boolean;
  /** Render the built-in top-right close affordance. */
  showCloseButton?: boolean;
  /** Accessible label for the built-in close button. */
  closeLabel?: string;
  /**
   * When true (default) the primitive traps focus and handles Escape itself.
   * Set false if the consumer already runs its own useFocusTrap on `panelRef`.
   */
  manageFocus?: boolean;
  /** External ref to the panel. Required for consumers running their own trap. */
  panelRef?: RefObject<HTMLDivElement | null>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

interface ModalContextValue {
  onClose: () => void;
  closeLabel: string;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function Modal({
  open,
  onClose,
  children,
  role = 'dialog',
  labelledBy,
  describedBy,
  ariaLabel,
  placement = 'center',
  size = 'auto',
  panelClassName,
  backdropClassName,
  zIndexClassName = 'z-[60]',
  closeOnBackdrop = true,
  showCloseButton = false,
  closeLabel = 'Close',
  manageFocus = true,
  panelRef,
  onKeyDown,
}: ModalProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? internalRef;

  // Only trap/escape from here when the consumer hasn't taken it over.
  useFocusTrap(ref, open && manageFocus, manageFocus ? onClose : undefined);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className={cn(
            'fixed inset-0 flex modal-backdrop backdrop-blur-sm',
            zIndexClassName,
            PLACEMENT_CLASS[placement],
            backdropClassName,
          )}
          onClick={closeOnBackdrop ? onClose : undefined}
        >
          <motion.div
            ref={ref}
            role={role}
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            aria-label={labelledBy ? undefined : ariaLabel}
            tabIndex={-1}
            initial={PANEL_MOTION[placement].initial}
            animate={PANEL_MOTION[placement].animate}
            exit={PANEL_MOTION[placement].exit}
            transition={MODAL_TRANSITION}
            className={cn(
              'relative overflow-hidden rounded-lg border border-border-strong bg-bg-accent shadow-xl',
              SIZE_CLASS[size],
              panelClassName,
            )}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onKeyDown}
          >
            <ModalContext.Provider value={{ onClose, closeLabel }}>
              {showCloseButton && <ModalCloseButton />}
              {children}
            </ModalContext.Provider>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Standalone close affordance. Uses the enclosing Modal's onClose. */
export function ModalCloseButton({ className }: { className?: string }) {
  const ctx = useContext(ModalContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={ctx.onClose}
      aria-label={ctx.closeLabel}
      className={cn(
        'absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]',
        className,
      )}
    >
      <X size={18} />
    </button>
  );
}

export function ModalHeader({
  children,
  className,
  icon,
}: {
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <div className={cn('flex items-start gap-3 px-6 pb-2 pt-6', className)}>
      {icon && <div className="shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ModalTitle({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        'font-display text-title text-text-primary',
        className,
      )}
    >
      {children}
    </h2>
  );
}

export function ModalDescription({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <p
      id={id}
      className={cn(
        'mt-2 text-body text-text-secondary',
        className,
      )}
    >
      {children}
    </p>
  );
}

export function ModalBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('px-6 py-2', className)}>{children}</div>;
}

export function ModalFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex justify-end gap-3 px-6 pb-5 pt-4',
        className,
      )}
    >
      {children}
    </div>
  );
}
