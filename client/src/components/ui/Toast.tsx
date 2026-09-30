import { createPortal } from 'react-dom';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
// §5.1: the stack is one FLIP'd list — a new toast fades+rises, a dismissed one
// falls away as a ghost, and every toast still on screen slides to its new spot
// on the ease-out. Reduced motion lands all of it instantly.
import { useFlipList } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useToastStore, type ToastType, type ToastAction } from '../../stores/toastStore';

const iconMap: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

// Glass has no red or green in its chrome (docs/glass-spec.md §1.3): a toast is a
// solid tonal surface in ink, and only an error takes the one danger ink. The
// kind is carried by the icon and, for an error or a warning, by the role.
const iconClass: Record<ToastType, string> = {
  success: 'text-text-primary',
  error: 'text-accent-danger',
  info: 'text-text-secondary',
  warning: 'text-text-primary',
};

// The store's own timer removes a toast after its `duration`; nothing here
// draws the time left, so `duration` is not read.
function ToastItem({
  id,
  type,
  message,
  action,
}: {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: ToastAction;
}) {
  const removeToast = useToastStore((s) => s.removeToast);
  const Icon = iconMap[type];
  const handleAction = async () => {
    if (!action) return;
    try {
      await action.onClick();
    } finally {
      removeToast(id);
    }
  };

  return (
    <div
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
      aria-live={type === 'error' || type === 'warning' ? 'assertive' : 'polite'}
      data-flip-key={id}
      // A toast is content: a solid tonal surface at radius 22 with a soft
      // shadow and no outline (the reference clip toast), never glass.
      className="pointer-events-auto relative flex w-[22rem] max-w-[calc(100vw-2rem)] items-start gap-3 overflow-hidden rounded-[22px] bg-[var(--raise)] py-3 pl-4 pr-3 text-text-primary shadow-[var(--sh-raised)]"
    >
      <Icon size={18} className={cn('mt-px shrink-0', iconClass[type])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium leading-snug text-text-primary">{message}</p>
        {action && (
          <button
            type="button"
            onClick={() => void handleAction()}
            className="pc-focusable -ml-2 mt-1.5 rounded-[10px] px-2 py-1 text-[15px] font-semibold text-text-primary transition-colors duration-[var(--glass-ms)] ease-[var(--glass-ease)] hover:bg-[var(--wash-hover)] active:bg-[var(--wash-press)]"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => removeToast(id)}
        aria-label="Dismiss notification"
        className="pc-focusable flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-capsule)] text-text-muted transition-colors duration-[var(--glass-ms)] ease-[var(--glass-ease)] hover:bg-[var(--wash-hover)] hover:text-text-primary active:bg-[var(--wash-press)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  // The container stays mounted even when empty: the FLIP hook's first commit
  // only measures, so an always-mounted stack animates the very first toast's
  // arrival instead of swallowing it as an initial mount.
  const stackRef = useFlipList<HTMLDivElement>();

  return createPortal(
    <div
      ref={stackRef}
      className="pointer-events-none fixed z-[9999] flex flex-col-reverse gap-2"
      // A toast is fixed to the viewport, so it stays inside the safe area (the
      // home-indicator inset and the notch) on all four sides.
      style={{
        bottom: 'calc(1rem + var(--safe-bottom, 0px))',
        right: 'calc(1rem + var(--safe-right, 0px))',
        maxHeight: 'calc(100dvh - 2rem - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
      }}
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} />
      ))}
    </div>,
    document.body,
  );
}
