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
        'flex items-center justify-between gap-3 rounded-md border border-accent-danger/35 bg-danger-tint px-4 py-3 text-label text-accent-danger',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AlertCircle size={16} className="shrink-0" />
        <span className="truncate">{message}</span>
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-sm border border-accent-danger/45 px-2.5 py-1 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger hover:text-text-on-danger focus-visible:shadow-[var(--focus-ring)]"
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
      <Loader2 className={cn('animate-spin text-accent-primary', spinnerSizeClass[size])} />
      {label && <span className="text-label">{label}</span>}
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

// Recipe: design-spec §7 (Empty state) — left-aligned, never a centered
// icon-in-circle. Line icon in a tinted well, Subhead title, warm 1–2 line copy,
// then a primary action.
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-start px-2 py-8', className)}>
      {icon && (
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-sm bg-accent-tint text-text-muted">
          {icon}
        </div>
      )}
      <h3 className="text-subhead text-text-primary">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-text-secondary">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
