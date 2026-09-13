import * as React from 'react';
import { cn } from '../../lib/utils';

export interface WellProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'aside' | 'li' | 'form';
  /** Drop the well's own padding when the caller lays the inside out itself. */
  bare?: boolean;
}

/**
 * A well (spec §1.1, §4): recessed inside a plate — search, a tile's ground,
 * the "here now" strip, an event card. Depth is an inset shadow, never a border.
 *
 * A well only ever appears *inside* a plate. It is the bottom of the three
 * layers (street → plate → raised / well); nothing nests below it.
 */
export const Well = React.forwardRef<HTMLElement, WellProps>(function Well(
  { as = 'div', bare = false, className, children, ...props },
  ref,
) {
  const Tag = as as React.ElementType;
  return (
    <Tag ref={ref} className={cn('pc-well', !bare && 'p-3', className)} {...props}>
      {children}
    </Tag>
  );
});

export interface RaisedProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'li' | 'article';
  /** Adds the lifted shadow — for a surface that floats a little (a composer). */
  lifted?: boolean;
  bare?: boolean;
}

/**
 * A raised surface (spec §1.1): the other half of the inside-a-plate step —
 * selected rows, chips, the composer, a hover card. One warm top highlight.
 */
export const Raised = React.forwardRef<HTMLElement, RaisedProps>(function Raised(
  { as = 'div', lifted = false, bare = false, className, children, ...props },
  ref,
) {
  const Tag = as as React.ElementType;
  return (
    <Tag
      ref={ref}
      className={cn(
        'bg-bg-raised',
        lifted ? 'shadow-[var(--shadow-lifted)]' : 'shadow-[var(--shadow-raised)]',
        'rounded-[var(--radius-control)]',
        !bare && 'p-3',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
});
