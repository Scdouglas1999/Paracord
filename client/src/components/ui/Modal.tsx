import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
// §5.1/§5.3: enter/exit are the shared pc-enter / pc-exit / pc-fade classes —
// the presence hook stays mounted for the --duration-fast leave and the ONE
// reduced-motion switch lands the whole thing instantly.
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';

/**
 * Single base modal/dialog primitive for the app. Owns the portal, backdrop,
 * enter/exit motion (the shared §5.1 overlay recipe: fade + 6px rise in on
 * spring-settle, fade + 4px fall out on ease-in), ARIA wiring, focus trap and
 * Escape handling. Complex consumers that already manage their own focus trap
 * can opt out with `manageFocus={false}` and pass their own `panelRef`.
 *
 * Imported (not edited) by other lanes — keep this export surface stable.
 */

type ModalPlacement = 'center' | 'top';
type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'auto';

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'w-full max-w-md',
  md: 'w-full max-w-xl',
  lg: 'w-full max-w-2xl',
  xl: 'w-full max-w-3xl',
  auto: '',
};

const PLACEMENT_CLASS: Record<ModalPlacement, string> = {
  center: 'items-center justify-center px-4',
  top: 'items-start justify-center px-4 pt-[12vh]',
};


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
  /** Extra classes for the dialog panel. */
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
  // Stay mounted for the leave: `exiting` swaps the enter classes for the exit
  // ones, and the hook drops the node when --duration-fast has run.
  const { mounted, exiting, scenery } = usePresence(open);

  // Only trap/escape from here when the consumer hasn't taken it over.
  useFocusTrap(ref, open && manageFocus, manageFocus ? onClose : undefined);

  if (!mounted) return null;

  return createPortal(
    // The backdrop deliberately carries NO `data-native-overlay-occlude`.
    // Over the Linux native underlay the force-opaque rule (layout.css)
    // repaints marked elements solid --bg-secondary; on this full-screen
    // `inset-0` backdrop that painted the ENTIRE viewport dark whenever a
    // stream was live, so opening any modal "blacked out" the stream and the
    // dialog looked stuck. The backdrop stays translucent (dims the video
    // behind); the opaque panel below carries the content and reads clearly.
    <div
      className={cn(
        'fixed inset-0 flex modal-backdrop',
        exiting ? 'pc-fade-out' : 'pc-fade-in',
        zIndexClassName,
        PLACEMENT_CLASS[placement],
        backdropClassName,
      )}
      onMouseDown={
        closeOnBackdrop
          ? (event) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        tabIndex={-1}
        className={cn(
          // A dialog is a plate that floats over the street (spec §4):
          // --bg-floating + the plate shadow, the plate's radius, no border.
          'pc-dialog relative max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden',
          exiting ? 'pc-exit' : 'pc-enter',
          SIZE_CLASS[size],
          panelClassName,
        )}
        onKeyDown={onKeyDown}
        {...scenery}
      >
        <ModalContext.Provider value={{ onClose, closeLabel }}>
          {showCloseButton && <ModalCloseButton />}
          {children}
        </ModalContext.Provider>
      </div>
    </div>,
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
        'pc-focusable absolute right-4 top-4 flex h-[var(--h-control)] w-[var(--h-control)] items-center justify-center',
        'rounded-[var(--radius-control)] text-text-muted',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary',
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
    <div className={cn('flex items-start gap-3 px-6 pb-3 pt-6', className)}>
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
      className={cn('pc-display text-title text-text-primary', className)}
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
      className={cn('mt-2 max-w-prose text-body text-text-secondary', className)}
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
  return <div className={cn('px-6 py-3', className)}>{children}</div>;
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
      className={cn('flex flex-wrap justify-end gap-2 px-6 pb-6 pt-5', className)}
    >
      {children}
    </div>
  );
}
