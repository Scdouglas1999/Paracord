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
 * Single base modal/dialog primitive for the app (docs/index-spec.md §6.12):
 * centered, max 440 wide at `sm`, radius 20, the card color, a title 17/700, a
 * body 14 ink-2 and actions right-aligned (a text Cancel and one cream confirm;
 * a destructive confirm is the danger ink on its fill). Owns the portal, the scrim
 * (`--ix-scrim`, fading 200ms), the enter/exit motion (the panel from scale(.97) and
 * a fade, 220ms on the spring), ARIA wiring, focus trap and Escape handling.
 * Complex consumers that already manage their own focus trap
 * can opt out with `manageFocus={false}` and pass their own `panelRef`.
 *
 * Imported (not edited) by other lanes — keep this export surface stable.
 */

type ModalPlacement = 'center' | 'top';
type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'auto';

// A dialog is the card color over the scrim at radius 20 (`.pc-dialog`,
// primitives.css). `sm` is the confirm's 440; the rest are for forms and lists
// that need the room.
const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'w-full max-w-[440px]',
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
  labeledBy?: string;
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
  labeledBy,
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
        'fixed inset-0 flex modal-backdrop bg-[var(--ix-scrim)]',
        exiting ? 'pc-scrim-out' : 'pc-scrim-in',
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
        aria-labelledby={labeledBy}
        aria-describedby={describedBy}
        aria-label={labeledBy ? undefined : ariaLabel}
        tabIndex={-1}
        className={cn(
          // A dialog is the card color over the scrim (§6.12); its contents read
          // the Index inks (`ix-lt--card`).
          'pc-dialog ix-lt--card relative max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden text-[var(--ix-ink)]',
          exiting ? 'pc-dialog-exit' : 'pc-dialog-enter',
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
        'pc-focusable absolute right-3.5 top-3.5 flex h-9 w-9 items-center justify-center',
        'rounded-[11px] text-[var(--ix-ink-3)]',
        'transition-colors duration-[120ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill)] hover:text-[var(--ix-ink)] active:bg-[var(--ix-fill-2)]',
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
    <div className={cn('flex items-start gap-3 px-[22px] pb-3 pt-[22px]', className)}>
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
      className={cn('pc-display text-[17px] font-bold leading-[1.25] tracking-[-0.01em] text-[var(--ix-ink)]', className)}
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
      className={cn('mt-1.5 max-w-prose text-[14px] leading-[1.45] text-[var(--ix-ink-2)]', className)}
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
  return <div className={cn('px-[22px] py-2', className)}>{children}</div>;
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
      className={cn('flex flex-wrap items-center justify-end gap-2 px-[22px] pb-[18px] pt-4', className)}
    >
      {children}
    </div>
  );
}
