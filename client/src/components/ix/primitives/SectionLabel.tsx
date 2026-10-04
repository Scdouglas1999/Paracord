import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

export interface SectionLabelProps {
  children: ReactNode;
  /** A count, right-aligned in weight 500 ("3 here"). */
  count?: ReactNode;
  /** The element: a heading when it names a region ("Channels"), a div when it only decorates. Default `div`. */
  as?: 'div' | 'h2' | 'h3';
  id?: string;
  className?: string;
}

/**
 * A section label (docs/index-spec.md §3.1): "Channels", "Rooms", "Messages".
 * 12.5/600 in the tertiary ink, padding 16 8 6, sentence case, never uppercase.
 */
export function SectionLabel({ children, count, as: Tag = 'div', id, className }: SectionLabelProps) {
  return (
    <Tag id={id} className={cn('ix-section-label', className)}>
      {children}
      {count !== undefined && <span className="ix-section-label__count">{count}</span>}
    </Tag>
  );
}
