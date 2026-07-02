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
  info: 'var(--accent-primary)',
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
        background: 'var(--glass-modal-fill-top)',
        border: '1px solid var(--border-strong)',
        borderLeft: `3px solid ${color}`,
        backdropFilter: 'blur(16px)',
        boxShadow: 'var(--shadow-lg)',
        animation: 'toast-slide-in 0.25s var(--ease-out)',
      }}
      className="pointer-events-auto relative flex w-80 max-w-[calc(100vw-2rem)] items-start gap-2.5 overflow-hidden rounded-xl p-3"
    >
      <Icon size={18} style={{ color, flexShrink: 0, marginTop: '1px' }} />
      <div className="flex-1">
        <p className="text-sm leading-snug" style={{ color: 'var(--text-secondary)' }}>
          {message}
        </p>
        {action && (
          <button
            type="button"
            onClick={() => void handleAction()}
            className="mt-1 text-xs font-semibold uppercase tracking-wide text-accent-primary hover:text-accent-primary-hover"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => removeToast(id)}
        className="flex-shrink-0 rounded-md p-0.5 transition-colors hover:bg-bg-mod-subtle"
        style={{ color: 'var(--text-muted)' }}
      >
        <X size={14} />
      </button>
      <div
        ref={progressRef}
        className="absolute bottom-0 left-0 h-0.5"
        style={{ width: '100%', backgroundColor: color, opacity: 0.5 }}
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
