import * as React from 'react';
import { cn } from '../../lib/utils';

export type KbdProps = React.HTMLAttributes<HTMLElement>;

/**
 * Kbd — a keyboard hint ("⌘K", "Esc"). Meta face (JetBrains Mono, spec §2) on a
 * quiet plate-colored pill so it reads as a key cap inside a well.
 */
export const Kbd = React.forwardRef<HTMLElement, KbdProps>(function Kbd(
  { className, children, ...props },
  ref,
) {
  return (
    <kbd
      ref={ref}
      className={cn(
        'pc-mono inline-flex h-[var(--h-chip-sm)] shrink-0 items-center justify-center',
        'rounded-[var(--radius-chip)] bg-bg-plate px-1.5',
        'text-[11px] font-medium text-text-faint shadow-[var(--shadow-chip)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
});
