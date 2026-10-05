import * as React from 'react';
import { cn } from '../../lib/utils';

export interface WellProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'aside' | 'li' | 'form';
  /** Drop the well's own padding when the caller lays the inside out itself. */
  bare?: boolean;
}

/**
 * A well (docs/index-spec.md §6.14): the field fill with a hairline (a field, a
 * search, a block of code or text that is read, not typed). No shadow.
 *
 * A well only ever appears *inside* a surface. It is the bottom of the layers
 * (surface → plate → raised / well); nothing nests below it.
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
 * A raised surface (docs/index-spec.md §3.1): the other half of the inside-a-plate
 * step — a row, a chip, a hover card — in the quiet control fill, with no shadow
 * unless it floats a little (`lifted`).
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
        'bg-[var(--ix-fill-ctl)]',
        lifted && 'shadow-[var(--ix-shadow-room)]',
        'rounded-[11px]',
        !bare && 'p-3',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
});
