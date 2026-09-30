import * as React from 'react';
import { cn } from '../../lib/utils';

export type KbdProps = React.HTMLAttributes<HTMLElement>;

/**
 * Kbd: a keyboard hint ("Ctrl K", "Esc") in the instrument cut, on a quiet glass
 * chip so it reads as a key cap (docs/glass-spec.md §2.3: 12px and up).
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
        'font-primary glass-instrument inline-flex h-[var(--h-chip-sm)] shrink-0 items-center justify-center',
        'rounded-[var(--r-chip)] bg-[var(--glass-fill-quiet)] px-1.5',
        'text-[12px] font-medium text-text-secondary',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
});
