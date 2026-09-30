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
        // An error is the danger *well* carrying the one danger ink (§1.3),
        // never a saturated red fill and never a border-only edge.
        'flex justify-between gap-3 rounded-[var(--r-row)] bg-danger-well px-4 py-3',
        'text-[15px] text-accent-danger',
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
          className="pc-focusable shrink-0 rounded-[var(--r-capsule)] bg-[var(--glass-fill)] px-3 py-1 text-[13px] font-semibold text-text-primary shadow-[var(--glass-edge)] transition-colors duration-[var(--glass-ms)] ease-[var(--glass-ease)] hover:bg-[var(--glass-fill-hover)] active:bg-[var(--glass-fill-press)]"
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
      {label && <span className="text-[15px]">{label}</span>}
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

// Left-aligned, never a centered icon-in-circle. A line icon in a well, a
// section-title heading (17/600), one specific line of copy, then one action.
// Never "No data" / "It's quiet here".
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
        <div className="pc-well mb-4 flex h-10 w-10 items-center justify-center rounded-[var(--r-ctl)] text-text-muted">
          {icon}
        </div>
      )}
      <h3 className="pc-display glass-title-section text-text-primary">{title}</h3>
      {description && (
        <p className="glass-body mt-1.5 max-w-prose text-text-secondary">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
