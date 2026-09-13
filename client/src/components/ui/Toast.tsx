import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
// §5.1: the stack is one FLIP'd list — a new toast fades+rises, a dismissed one
// falls away as a ghost, and every toast still on screen slides to its new spot
// on the spring-settle. Reduced motion lands all of it instantly.
import { useFlipList } from '../../lib/motion';
import { useToastStore, type ToastType, type ToastAction } from '../../stores/toastStore';

const iconMap: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap: Record<ToastType, string> = {
  success: 'var(--accent-success)',
  error: 'var(--accent-danger)',
  info: 'var(--accent-info)',
  warning: 'var(--accent-warning)',
};

function ToastItem({
  id,
  type,
  message,
  duration,
  action,
}: {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  action?: ToastAction;
}) {
  const removeToast = useToastStore((s) => s.removeToast);
  const progressRef = useRef<HTMLDivElement>(null);
  const Icon = iconMap[type];
  const color = colorMap[type];

  useEffect(() => {
    const el = progressRef.current;
    if (!el) return;
    // Trigger the CSS animation on next frame
    requestAnimationFrame(() => {
      el.style.transition = `width ${duration}ms linear`;
      el.style.width = '0%';
    });
  }, [duration]);

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
      className="pc-floating pointer-events-auto relative flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 overflow-hidden px-4 py-3"
    >
      <Icon size={18} style={{ color, flexShrink: 0, marginTop: '1px' }} />
      <div className="min-w-0 flex-1">
        <p className="text-label leading-relaxed text-text-primary">{message}</p>
        {action && (
          <button
            type="button"
            onClick={() => void handleAction()}
            className="pc-focusable mt-1.5 rounded-[var(--radius-chip)] text-meta font-semibold text-accent-primary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:text-accent-primary-hover"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => removeToast(id)}
        aria-label="Dismiss notification"
        className="pc-focusable -mr-1 flex-shrink-0 rounded-[var(--radius-chip)] p-1 text-text-muted transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary"
      >
        <X size={14} />
      </button>
      <div
        ref={progressRef}
        className="absolute bottom-0 left-0 h-0.5"
        style={{ width: '100%', backgroundColor: color, opacity: 0.45 }}
      />
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
      // A toast is fixed to the viewport, and on a phone the viewport's bottom
      // 49px belong to the tab bar — so every toast landed on top of the
      // navigation, and none of them cleared the home-indicator inset. The
      // stack now starts above whatever is actually down there
      // (`--h-mobile-nav` is measured by `MobileBottomNav`, 0 when it is not
      // on screen) and inside the safe area on all four sides.
      style={{
        bottom: 'calc(1rem + var(--safe-bottom, 0px) + var(--h-mobile-nav, 0px))',
        right: 'calc(1rem + var(--safe-right, 0px))',
        maxHeight:
          'calc(100dvh - 2rem - var(--safe-top, 0px) - var(--safe-bottom, 0px) - var(--h-mobile-nav, 0px))',
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
