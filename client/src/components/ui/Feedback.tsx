import { AlertCircle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface ErrorBannerProps {
  message: string;
  className?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorBanner({
  message,
  className,
  onRetry,
  retryLabel = 'Retry',
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm font-medium text-accent-danger',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AlertCircle size={15} className="shrink-0" />
        <span className="truncate">{message}</span>
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-accent-danger/45 px-2 py-1 text-xs font-semibold transition-colors hover:bg-accent-danger hover:text-white"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

interface LoadingSpinnerProps {
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const spinnerSizeClass: Record<NonNullable<LoadingSpinnerProps['size']>, string> = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8',
};

export function LoadingSpinner({
  label,
  size = 'md',
  className,
}: LoadingSpinnerProps) {
  return (
    <div
      className={cn('flex items-center justify-center gap-2 text-text-muted', className)}
      aria-live="polite"
      aria-busy="true"
    >
      <Loader2 className={cn('animate-spin', spinnerSizeClass[size])} />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle/40 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && <div className="mb-3 text-text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      {description && <p className="mt-1 text-xs text-text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

