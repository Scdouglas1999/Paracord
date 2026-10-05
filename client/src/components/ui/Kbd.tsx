import * as React from 'react';
import { cn } from '../../lib/utils';

export type KbdProps = React.HTMLAttributes<HTMLElement>;

/**
 * Kbd: a keyboard hint ("Ctrl K", "Esc"): 11/500 tabular, a hairline and a
 * quiet fill so it reads as a key cap (docs/index-spec.md §3.1 search field).
 */
export const Kbd = React.forwardRef<HTMLElement, KbdProps>(function Kbd(
  { className, children, ...props },
  ref,
) {
  return (
    <kbd
      ref={ref}
      className={cn(
        // `kbd` defaults to the UA monospace face; a key cap here is Instrument Sans.
        'font-primary inline-flex h-[var(--h-chip-sm)] shrink-0 items-center justify-center tabular-nums',
        'rounded-[6px] bg-[var(--ix-fill)] px-1.5 shadow-[inset_0_0_0_1px_var(--ix-line)]',
        'text-[11px] font-medium text-[var(--ix-ink-2)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
});
