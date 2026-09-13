import { AlertCircle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface ErrorBannerProps {
  message: string;
  className?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /**
   * Wrap the message across lines instead of ellipsizing it to one.
   *
   * The default single line suits short inline failures. Opt in when the
   * message is an explanation the reader has to act on — an ellipsis there
   * hides the instructions and leaves a dead end.
   */
  multiline?: boolean;
}

export function ErrorBanner({
  message,
  className,
  onRetry,
  retryLabel = 'Retry',
  multiline = false,
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex justify-between gap-3 rounded-md border border-accent-danger/35 bg-danger-tint px-4 py-3 text-label text-accent-danger',
        multiline ? 'items-start' : 'items-center',
        className,
      )}
    >
      <span className={cn('flex min-w-0 gap-2', multiline ? 'items-start' : 'items-center')}>
        <AlertCircle size={16} className={cn('shrink-0', multiline && 'mt-0.5')} />
        <span className={multiline ? 'leading-relaxed' : 'truncate'}>{message}</span>
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
  // Set to "alert" for error states so assistive tech announces the failure.
  role?: 'alert' | 'status';
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
  role,
}: EmptyStateProps) {
  return (
    <div role={role} className={cn('flex flex-col items-start px-2 py-8', className)}>
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
