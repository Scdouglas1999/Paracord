import * as React from 'react';
import { cn } from '../../lib/utils';

export interface DividerProps extends React.HTMLAttributes<HTMLElement> {
  orientation?: 'horizontal' | 'vertical';
  /** Use the stronger hairline where a plate genuinely needs a harder break. */
  strong?: boolean;
  /** A labeled rule ("Today", "New messages"). Horizontal only. */
  label?: React.ReactNode;
}

/**
 * Divider: a hairline (`--ix-line`), and only where a surface needs an internal
 * division. Depth between surfaces comes from tone; a border is never how two
 * surfaces are told apart. A label is the time divider's 12/500.
 */
export const Divider = React.forwardRef<HTMLElement, DividerProps>(function Divider(
  { orientation = 'horizontal', strong = false, label, className, ...props },
  ref,
) {
  const line = strong ? 'bg-[var(--ix-edge-strong)]' : 'bg-[var(--ix-line)]';

  if (label != null && orientation === 'horizontal') {
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        role="separator"
        className={cn('flex items-center gap-3', className)}
        {...props}
      >
        <span className={cn('h-px flex-1', line)} aria-hidden />
        <span className="shrink-0 text-[12px] font-medium tabular-nums text-[var(--ix-ink-2)]">{label}</span>
        <span className={cn('h-px flex-1', line)} aria-hidden />
      </div>
    );
  }

  return (
    <hr
      ref={ref as React.Ref<HTMLHRElement>}
      aria-orientation={orientation}
      className={cn(
        'shrink-0 border-0',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        line,
        className,
      )}
      {...props}
    />
  );
});
