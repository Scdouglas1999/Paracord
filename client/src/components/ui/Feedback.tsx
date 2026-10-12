import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { CordMark, CordSpinner } from '../brand/CordMark';

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
        // An error is the danger fill carrying the one danger ink (§1.4, §6.8),
        // never a saturated red fill and never a border-only edge.
        'flex justify-between gap-3 rounded-[12px] bg-[var(--ix-danger-fill)] px-4 py-3',
        'text-[14px] text-[var(--ix-danger-ink)]',
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
          className="pc-focusable shrink-0 rounded-[10px] bg-[var(--ix-fill-ctl)] px-3 py-1 text-[13px] font-semibold text-[var(--ix-ink)] transition-colors duration-[40ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-ctl-hover)] active:bg-[var(--ix-fill-2)]"
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

/**
 * The mark's size for each loader. `sm` is a one-line status row: the flat mark
 * in the text's color beside the label. `md` and `lg` are section and page
 * loaders: the ember mark drawing in and out above the label.
 */
const spinnerMarkSize: Record<'md' | 'lg', number> = {
  md: 40,
  lg: 56,
};

export function LoadingSpinner({
  label,
  size = 'md',
  className,
}: LoadingSpinnerProps) {
  if (size === 'sm') {
    return (
      <div
        className={cn('flex items-center justify-center gap-2 text-[var(--ix-ink-3)]', className)}
        aria-live="polite"
        aria-busy="true"
      >
        <CordSpinner className="text-[var(--ix-ink-2)]" />
        {label && <span className="text-[14px]">{label}</span>}
      </div>
    );
  }
  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-3 text-[var(--ix-ink-3)]', className)}
      aria-live="polite"
      aria-busy="true"
    >
      <CordMark size={spinnerMarkSize[size]} motion="loading" />
      {label && <span className="text-[14px]">{label}</span>}
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

// Left-aligned, never a centered icon-in-circle. A line icon in a quiet tile, a
// heading (17/700), one specific line of copy, then one action. Never "No data" /
// "It's quiet here". A whole-page empty state is `ix/page/EmptyPage`.
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
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--ix-fill-ctl)] text-[var(--ix-ink-2)]">
          {icon}
        </div>
      )}
      <h3 className="pc-display text-[17px] font-bold leading-[1.25] tracking-[-0.01em] text-[var(--ix-ink)]">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-prose text-[14px] leading-[1.5] text-[var(--ix-ink-2)]">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
