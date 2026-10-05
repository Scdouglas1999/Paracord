import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToastStore, type Toast, type ToastType, type ToastAction } from '../../stores/toastStore';

/**
 * Toasts (docs/index-spec.md §5.18, §6.8): a near-solid capsule at the top
 * center of main, under the toolbar. 13.5/600 ink, an optional text action, and
 * an error or a warning carries its glyph and the danger ink on the words, never a
 * red fill. They arrive from 8px above on the spring (135ms) and leave in 90ms;
 * the store removes one after its duration (4s by default).
 */

/** How long a dismissed toast stays to play its leave (§5.18: out 90ms). */
const LEAVE_MS = 90;
/** The toolbar's height and the gap under it (the frame's `--ix-toolbar-h`). */
const TOOLBAR_PX = 58;
const GAP_PX = 8;

const ICON: Partial<Record<ToastType, typeof AlertCircle>> = {
  error: AlertCircle,
  warning: AlertTriangle,
};

// The store's own timer removes a toast after its `duration`; nothing here
// draws the time left, so `duration` is not read.
function ToastItem({
  id,
  type,
  message,
  action,
  leaving,
}: {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: ToastAction;
  leaving: boolean;
}) {
  const removeToast = useToastStore((s) => s.removeToast);
  const Icon = ICON[type];
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
      data-toast-type={type}
      aria-hidden={leaving || undefined}
      className={cn(
        // A near-solid capsule (the action capsule's recipe, §6.8): 13.5/600 ink.
        'ix-toast pointer-events-auto relative flex max-w-[min(32rem,calc(100vw-2rem))] items-center gap-2.5 rounded-full',
        'bg-[var(--ix-capsule)] py-1.5 pl-4 pr-1.5 text-[13.5px] font-semibold text-[var(--ix-ink)] shadow-[var(--ix-shadow-capsule)]',
        leaving ? 'pc-toast-out' : 'pc-toast-in',
      )}
    >
      {Icon && (
        <Icon
          size={16}
          className={cn('shrink-0', type === 'error' ? 'text-[var(--ix-danger-ink)]' : 'text-[var(--ix-ink-2)]')}
          aria-hidden
        />
      )}
      <p className={cn('min-w-0 py-1 leading-snug', type === 'error' && 'text-[var(--ix-danger-ink)]')}>{message}</p>
      {action && (
        <button
          type="button"
          onClick={() => void handleAction()}
          className="pc-focusable shrink-0 rounded-full px-3 py-1.5 text-[13.5px] font-semibold text-[var(--ix-ink)] transition-colors duration-[55ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-2)] active:bg-[var(--ix-fill)]"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => removeToast(id)}
        aria-label="Dismiss notification"
        className="pc-focusable flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--ix-ink-3)] transition-colors duration-[55ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-2)] hover:text-[var(--ix-ink)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}

interface Shown extends Toast {
  leaving: boolean;
}

/**
 * What to draw: the store's toasts, plus the ones just dismissed for the beat
 * their leave takes. The store drops a toast at once, and a removed node cannot
 * play its own exit.
 */
function useShownToasts(): Shown[] {
  const toasts = useToastStore((s) => s.toasts);
  const [leaving, setLeaving] = useState<Toast[]>([]);
  const previous = useRef<Toast[]>(toasts);

  useEffect(() => {
    const live = new Set(toasts.map((toast) => toast.id));
    const gone = previous.current.filter((toast) => !live.has(toast.id));
    previous.current = toasts;
    if (gone.length === 0) return;
    // A leave is a short, one-off hold of what the store already dropped.
    setLeaving((current) => [...current, ...gone]);
    const ids = new Set(gone.map((toast) => toast.id));
    const timer = window.setTimeout(() => {
      setLeaving((current) => current.filter((toast) => !ids.has(toast.id)));
    }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  return [...toasts.map((toast) => ({ ...toast, leaving: false })), ...leaving.map((toast) => ({ ...toast, leaving: true }))];
}

/**
 * Where main is, so the stack can sit at its top center under the toolbar. Outside
 * the frame (a test, a page with no main) it is the window's top center.
 */
function useMainBox(active: boolean): { top: number; left: number; width: number } | null {
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      const main = document.querySelector<HTMLElement>('.ix-main');
      if (!main) {
        setBox((current) => (current === null ? current : null));
        return;
      }
      const rect = main.getBoundingClientRect();
      setBox((current) =>
        current && current.top === rect.top && current.left === rect.left && current.width === rect.width
          ? current
          : { top: rect.top, left: rect.left, width: rect.width },
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active]);

  return box;
}

export function ToastContainer() {
  const shown = useShownToasts();
  const box = useMainBox(shown.length > 0);

  return createPortal(
    <div
      className="pointer-events-none fixed z-[9999] flex flex-col items-center gap-2"
      // The stack is fixed to the viewport: top center of main under the toolbar
      // (the window's top center where there is no main), inside the safe area.
      style={
        box
          ? { top: box.top + TOOLBAR_PX + GAP_PX, left: box.left, width: box.width }
          : { top: 'calc(1rem + var(--safe-top, 0px))', left: 0, right: 0 }
      }
      aria-live="polite"
      aria-atomic="false"
    >
      {shown.map((t) => (
        <ToastItem key={t.id} {...t} />
      ))}
    </div>,
    document.body,
  );
}
