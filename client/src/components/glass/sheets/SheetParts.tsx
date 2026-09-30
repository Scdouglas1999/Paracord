import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

/**
 * The small pieces every sheet page shares (docs/glass-spec.md §2.3, §2.4): a
 * kicker, an empty or error state, and a faint line. Solid tonal tiles, no
 * outlines, one danger ink for errors.
 */

/** A group label: the kicker (12/700, narrow, uppercase, ink-3). */
export function SheetKicker({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <h3 id={id} className={cn('glass-kicker glass-sheet-kicker', className)}>
      {children}
    </h3>
  );
}

/** Nothing here yet, said in words: a glyph tile, a title and a line. */
export function SheetEmpty({
  icon,
  title,
  children,
  role,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div className="glass-sheet-empty" role={role}>
      <span className="glass-sheet-empty__tile" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="glass-sheet-empty__title">{title}</h3>
        {children != null && <p className="glass-sheet-empty__text">{children}</p>}
      </div>
    </div>
  );
}

/** An error, in the one danger ink. */
export function SheetAlert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn('glass-sheet-alert', className)}>
      {children}
    </div>
  );
}

/** A quiet status line ("Loading…"). */
export function SheetStatus({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="glass-sheet-line glass-sheet-status">
      {children}
    </p>
  );
}
