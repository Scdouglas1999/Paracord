import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
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
      style={{
        animation: 'toast-slide-in var(--duration-normal) var(--ease-out)',
      }}
      className="pointer-events-auto relative flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 overflow-hidden rounded-md border border-border-subtle bg-bg-accent px-4 py-3 shadow-lg"
    >
      <Icon size={18} style={{ color, flexShrink: 0, marginTop: '1px' }} />
      <div className="min-w-0 flex-1">
        <p className="text-label text-text-primary">{message}</p>
        {action && (
          <button
            type="button"
            onClick={() => void handleAction()}
            className="mt-1 text-meta font-semibold uppercase tracking-wide text-accent-primary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-accent-primary-hover"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => removeToast(id)}
        aria-label="Dismiss notification"
        className="-mr-1 flex-shrink-0 rounded-sm p-1 text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
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

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col-reverse gap-2"
      style={{ maxHeight: 'calc(100vh - 2rem)' }}
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
